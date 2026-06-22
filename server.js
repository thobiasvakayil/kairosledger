const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const app = express();
const PORT = process.env.PORT || 8000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'Kairoserec_relevant.db');

app.use(cors());
app.use(express.json({ limit: '20mb' }));

const ROLE_PERMISSIONS = {
  admin: {
    title: 'Administrator',
    permissions: ['read_state', 'write_state', 'manage_users', 'view_audit']
  },
  agent: {
    title: 'Agent',
    permissions: ['read_state', 'write_state']
  },
  reviewer: {
    title: 'Reviewer',
    permissions: ['read_state', 'write_state', 'approve_changes']
  },
  viewer: {
    title: 'Viewer',
    permissions: ['read_state']
  }
};

const ALL_ROLES = Object.keys(ROLE_PERMISSIONS);
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();

const ENTRA_TENANT_ID = normalizeValue(process.env.ENTRA_TENANT_ID);
const ENTRA_API_CLIENT_ID = normalizeValue(process.env.ENTRA_API_CLIENT_ID || process.env.ENTRA_CLIENT_ID);
const ENTRA_SPA_CLIENT_ID = normalizeValue(process.env.ENTRA_SPA_CLIENT_ID);
const ENTRA_API_SCOPE = normalizeValue(process.env.ENTRA_API_SCOPE);
const ENTRA_AUTHORITY = normalizeValue(process.env.ENTRA_AUTHORITY) || (ENTRA_TENANT_ID ? `https://login.microsoftonline.com/${ENTRA_TENANT_ID}` : '');
const ENTRA_ISSUER = normalizeValue(process.env.ENTRA_ISSUER) || (ENTRA_TENANT_ID ? `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/v2.0` : '');
const ENTRA_JWKS_URI = normalizeValue(process.env.ENTRA_JWKS_URI) || (ENTRA_TENANT_ID ? `https://login.microsoftonline.com/${ENTRA_TENANT_ID}/discovery/v2.0/keys` : '');
const ENTRA_ENABLED = Boolean(ENTRA_TENANT_ID && ENTRA_API_CLIENT_ID && ENTRA_ISSUER && ENTRA_JWKS_URI);
const ENTRA_ALLOW_LOCAL_LOGIN = String(process.env.ENTRA_ALLOW_LOCAL_LOGIN || '').toLowerCase() === 'true';
let cachedEntraJwks = null;

function parseRoleMap(raw) {
  if (!raw) {
    return {
      admin: 'admin',
      agent: 'agent',
      reviewer: 'reviewer',
      viewer: 'viewer'
    };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const out = {};
    Object.keys(parsed).forEach((key) => {
      const source = normalizeValue(key).toLowerCase();
      const target = normalizeValue(parsed[key]).toLowerCase();
      if (source && ALL_ROLES.includes(target)) {
        out[source] = target;
      }
    });
    return out;
  } catch (_err) {
    return {};
  }
}

const ENTRA_ROLE_MAP = parseRoleMap(process.env.ENTRA_ROLE_MAP_JSON);
const ENTRA_AUDIENCES = [
  ENTRA_API_CLIENT_ID,
  ENTRA_API_CLIENT_ID ? `api://${ENTRA_API_CLIENT_ID}` : ''
].filter(Boolean);

function getEntraJwks() {
  if (!cachedEntraJwks) {
    cachedEntraJwks = createRemoteJWKSet(new URL(ENTRA_JWKS_URI));
  }
  return cachedEntraJwks;
}

function getClaimValues(claimValue) {
  if (Array.isArray(claimValue)) {
    return claimValue.map((value) => normalizeValue(value).toLowerCase()).filter(Boolean);
  }
  const single = normalizeValue(claimValue).toLowerCase();
  return single ? [single] : [];
}

function resolveRoleFromEntraClaims(claims) {
  const roleCandidates = [
    ...getClaimValues(claims.roles),
    ...getClaimValues(claims.groups),
    ...getClaimValues(claims.role)
  ];

  for (const candidate of roleCandidates) {
    const mapped = ENTRA_ROLE_MAP[candidate];
    if (mapped && ALL_ROLES.includes(mapped)) {
      return mapped;
    }
    if (ALL_ROLES.includes(candidate)) {
      return candidate;
    }
  }

  return 'viewer';
}

function normalizeEntraUser(claims) {
  const role = resolveRoleFromEntraClaims(claims);
  return {
    id: normalizeValue(claims.oid || claims.sub || claims.id),
    username: normalizeValue(claims.preferred_username || claims.upn || claims.email || claims.sub || 'entra-user'),
    displayName: normalizeValue(claims.name || claims.preferred_username || claims.upn || 'Entra User'),
    role,
    agentScope: normalizeValue(claims.agent_scope || claims.extension_agent_scope || claims.agentScope),
    authProvider: 'entra'
  };
}

async function verifyEntraToken(token) {
  if (!ENTRA_ENABLED) {
    throw Object.assign(new Error('Entra ID authentication is not configured'), { status: 401 });
  }

  const result = await jwtVerify(token, getEntraJwks(), {
    issuer: ENTRA_ISSUER,
    audience: ENTRA_AUDIENCES,
    clockTolerance: 5
  });

  return result.payload || {};
}

async function resolveAuthContext(req) {
  cleanupExpiredSessions();
  const token = getBearerToken(req);
  if (!token) {
    throw Object.assign(new Error('Unauthorized: missing token'), { status: 401 });
  }

  const session = sessions.get(token);
  if (session) {
    return {
      authToken: token,
      authType: 'local',
      user: {
        id: session.userId,
        username: session.username,
        displayName: session.displayName,
        role: session.role,
        agentScope: session.agentScope || '',
        authProvider: 'local'
      }
    };
  }

  if (ENTRA_ENABLED) {
    try {
      const claims = await verifyEntraToken(token);
      return {
        authToken: token,
        authType: 'entra',
        user: normalizeEntraUser(claims),
        entraClaims: claims
      };
    } catch (_err) {
      throw Object.assign(new Error('Unauthorized: invalid or expired token'), { status: 401 });
    }
  }

  throw Object.assign(new Error('Unauthorized: invalid or expired token'), { status: 401 });
}

async function ensureAuditTable(db) {
  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor_user_id INTEGER,
      actor_username TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      metadata TEXT
    )`
  );
}

async function writeAuditLog(db, entry) {
  await ensureAuditTable(db);
  const actor = entry && entry.actor ? entry.actor : null;
  const metadataText = entry && entry.metadata ? JSON.stringify(entry.metadata) : null;

  await runExecute(
    db,
    `INSERT INTO audit_logs (
      actor_user_id,
      actor_username,
      actor_role,
      action,
      target_type,
      target_id,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      actor ? actor.id : null,
      actor ? actor.username : null,
      actor ? actor.role : null,
      entry.action,
      entry.targetType || null,
      entry.targetId || null,
      metadataText
    ]
  );
}

function openDb() {
  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
      console.error('Failed to open DB', err.message);
    }
  });

  try {
    db.configure('busyTimeout', 5000);
  } catch (_err) {
    // Not all sqlite3 builds support configure; fallback to PRAGMA.
  }

  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA journal_mode = WAL');
  return db;
}

function runQuery(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function runGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function runExecute(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    const attempt = (retry = 0) => {
      db.run(sql, params, function onRun(err) {
        if (!err) return resolve(this);
        if (err.code === 'SQLITE_BUSY' && retry < 5) {
          const delay = 100 * (retry + 1);
          return setTimeout(() => attempt(retry + 1), delay);
        }
        return reject(err);
      });
    };
    attempt();
  });
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const calculated = crypto.scryptSync(password, salt, 64).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculated, 'hex'));
  } catch (_err) {
    return false;
  }
}

function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    displayName: user.display_name || user.username,
    role: user.role,
    agentScope: user.agent_scope || '',
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function randomPassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function getBearerToken(req) {
  const header = (req.headers.authorization || '').toString();
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

async function authRequired(req, res, next) {
  try {
    const context = await resolveAuthContext(req);
    req.authToken = context.authToken;
    req.authType = context.authType;
    req.user = context.user;
    req.entraClaims = context.entraClaims || null;
    return next();
  } catch (err) {
    return res.status(err.status || 401).json({ error: err.message || 'Unauthorized' });
  }
}

function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  if (['none', 'null', 'nan'].includes(text.toLowerCase())) return '';
  return text;
}

function mergeCommaValues(existing, incoming) {
  const out = [];
  const seen = new Set();
  const addList = (v) => {
    if (!v) return;
    v.toString().split(/[;,]+/).map(s => s.trim()).filter(Boolean).forEach(item => {
      const key = (item || '').toString().trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(item); }
    });
  };
  addList(existing);
  addList(incoming);
  return out.join(', ');
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function getUserAgentScope(user) {
  return normalizeValue(user && user.agentScope);
}

function isAgentScoped(user) {
  return normalizeValue(user && user.role).toLowerCase() === 'agent' && Boolean(getUserAgentScope(user));
}

function personIdentity(person) {
  return normalizeValue(person && (person.source_id || person.id || person.name));
}

function transactionIdentity(transaction) {
  return normalizeValue(transaction && (transaction.tran_id || transaction.ref || transaction.source_id || transaction.id));
}

function isPersonVisibleToUser(user, person) {
  if (!isAgentScoped(user)) return true;
  return normalizeValue(person && person.agent) === getUserAgentScope(user);
}

function buildScopedPersonLookup(user, people) {
  const scopedPeople = ensureArray(people).filter((person) => isPersonVisibleToUser(user, person));
  return {
    ids: new Set(scopedPeople.map((person) => normalizeValue(person.id)).filter(Boolean)),
    names: new Set(scopedPeople.map((person) => normalizeValue(person.name)).filter(Boolean))
  };
}

function isTransactionVisibleToUser(user, transaction, scopedPersonLookup = null) {
  if (!isAgentScoped(user)) return true;
  if (normalizeValue(transaction && transaction.assignedAgent) === getUserAgentScope(user)) {
    return true;
  }

  if (scopedPersonLookup) {
    const matchedPersonId = normalizeValue(transaction && transaction.matchedPersonId);
    const matchedPersonName = normalizeValue(transaction && transaction.matchedPersonName);
    if (matchedPersonId && scopedPersonLookup.ids.has(matchedPersonId)) {
      return true;
    }
    if (matchedPersonName && scopedPersonLookup.names.has(matchedPersonName)) {
      return true;
    }
  }

  return false;
}

function buildScopedStateForUser(user, state) {
  if (!isAgentScoped(user)) {
    return state;
  }

  const scopedPeople = ensureArray(state.people).filter((person) => isPersonVisibleToUser(user, person));
  const scopedPersonLookup = buildScopedPersonLookup(user, scopedPeople);

  return {
    ...state,
    people: scopedPeople,
    transactions: ensureArray(state.transactions).filter((transaction) => isTransactionVisibleToUser(user, transaction, scopedPersonLookup))
  };
}

function sameIdentitySet(leftItems, rightItems, getKey) {
  const leftKeys = ensureArray(leftItems).map(getKey).filter(Boolean).sort();
  const rightKeys = ensureArray(rightItems).map(getKey).filter(Boolean).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index]);
}

async function ensureColumnExists(db, tableName, columnName, definitionSql) {
  const columns = await runQuery(db, `PRAGMA table_info(${tableName})`);
  const hasColumn = columns.some((column) => normalizeValue(column.name).toLowerCase() === columnName.toLowerCase());
  if (!hasColumn) {
    await runExecute(db, `ALTER TABLE ${tableName} ADD COLUMN ${definitionSql}`);
  }
}

function mapTrnTypeTag(rawTag, fallbackType, trnTypeLookup) {
  const tag = normalizeValue(rawTag);
  if (!tag) return normalizeValue(fallbackType) || 'Uncategorized';

  const names = tag
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => trnTypeLookup[token] || token);

  const uniqueNames = [];
  names.forEach((name) => {
    if (!uniqueNames.includes(name)) {
      uniqueNames.push(name);
    }
  });

  return uniqueNames.length > 0
    ? uniqueNames.join(' | ')
    : (normalizeValue(fallbackType) || 'Uncategorized');
}

function requireRole(roles) {
  return async (req, res, next) => {
    try {
      const context = await resolveAuthContext(req);
      req.authToken = context.authToken;
      req.authType = context.authType;
      req.user = context.user;
      req.entraClaims = context.entraClaims || null;

      const role = (req.user.role || '').toLowerCase();
      const normalizedRoles = roles.map((r) => r.toLowerCase());
      if (!normalizedRoles.includes(role)) {
        return res.status(403).json({ error: 'Forbidden: insufficient role' });
      }
      return next();
    } catch (err) {
      return res.status(err.status || 401).json({ error: err.message || 'Unauthorized' });
    }
  };
}

function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const context = await resolveAuthContext(req);
      req.authToken = context.authToken;
      req.authType = context.authType;
      req.user = context.user;
      req.entraClaims = context.entraClaims || null;

      const role = (req.user.role || '').toLowerCase();
      const roleDef = ROLE_PERMISSIONS[role];
      const permissions = roleDef && Array.isArray(roleDef.permissions) ? roleDef.permissions : [];
      if (!permissions.includes(permission)) {
        return res.status(403).json({ error: `Forbidden: missing permission ${permission}` });
      }
      return next();
    } catch (err) {
      return res.status(err.status || 401).json({ error: err.message || 'Unauthorized' });
    }
  };
}

async function ensureUsersTable(db) {
  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS app_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_scope TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await ensureColumnExists(db, 'app_users', 'agent_scope', 'agent_scope TEXT');

  const countRow = await runGet(db, 'SELECT COUNT(1) AS count FROM app_users');
  const count = Number(countRow && countRow.count ? countRow.count : 0);
  if (count > 0) {
    await runExecute(
      db,
      "UPDATE app_users SET agent_scope = 'Leena' WHERE lower(username) = 'agent1' AND (agent_scope IS NULL OR trim(agent_scope) = '')"
    );
    return;
  }

  const defaultUsers = [
    { username: 'admin', displayName: 'System Admin', role: 'admin', password: 'Admin@123', agentScope: '' },
    { username: 'agent1', displayName: 'Field Agent One', role: 'agent', password: 'Agent@123', agentScope: 'Leena' },
    { username: 'review1', displayName: 'Finance Reviewer', role: 'reviewer', password: 'Review@123', agentScope: '' },
    { username: 'viewer1', displayName: 'Read Only Viewer', role: 'viewer', password: 'Viewer@123', agentScope: '' }
  ];

  for (const user of defaultUsers) {
    await runExecute(
      db,
      'INSERT INTO app_users (username, display_name, password_hash, role, agent_scope, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [user.username, user.displayName, hashPassword(user.password), user.role, user.agentScope || null]
    );
  }

}

function safeUserProfile(userRow) {
  return {
    id: userRow.id,
    username: userRow.username,
    displayName: userRow.display_name || userRow.username,
    role: userRow.role,
    agentScope: userRow.agent_scope || '',
    roleTitle: ROLE_PERMISSIONS[userRow.role] ? ROLE_PERMISSIONS[userRow.role].title : userRow.role,
    permissions: ROLE_PERMISSIONS[userRow.role] ? ROLE_PERMISSIONS[userRow.role].permissions : []
  };
}

function roleMatrix() {
  return Object.keys(ROLE_PERMISSIONS).map((roleKey) => ({
    role: roleKey,
    title: ROLE_PERMISSIONS[roleKey].title,
    permissions: ROLE_PERMISSIONS[roleKey].permissions
  }));
}

app.get('/api/auth/roles', (_req, res) => {
  res.json({ roles: roleMatrix() });
});

app.get('/api/auth/config', (_req, res) => {
  res.json({
    entraEnabled: ENTRA_ENABLED,
    allowLocalLogin: !ENTRA_ENABLED || ENTRA_ALLOW_LOCAL_LOGIN,
    authority: ENTRA_AUTHORITY || null,
    tenantId: ENTRA_TENANT_ID || null,
    spaClientId: ENTRA_SPA_CLIENT_ID || null,
    apiClientId: ENTRA_API_CLIENT_ID || null,
    apiScope: ENTRA_API_SCOPE || null,
    redirectPath: '/login'
  });
});

app.post('/api/auth/login', async (req, res) => {
  if (ENTRA_ENABLED && !ENTRA_ALLOW_LOCAL_LOGIN) {
    return res.status(400).json({ error: 'Local login is disabled. Use Microsoft Entra ID sign-in.' });
  }

  const db = openDb();

  try {
    const username = normalizeValue(req.body && req.body.username).toLowerCase();
    const password = normalizeValue(req.body && req.body.password);

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    await ensureUsersTable(db);

    const user = await runGet(
      db,
      'SELECT id, username, display_name, password_hash, role, agent_scope, is_active FROM app_users WHERE lower(username) = ? LIMIT 1',
      [username]
    );

    if (!user || Number(user.is_active) !== 1 || !ALL_ROLES.includes(user.role)) {
      await writeAuditLog(db, {
        action: 'AUTH_LOGIN_FAILED',
        targetType: 'auth',
        targetId: username,
        metadata: { reason: 'invalid_credentials' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!verifyPassword(password, user.password_hash)) {
      await writeAuditLog(db, {
        action: 'AUTH_LOGIN_FAILED',
        targetType: 'auth',
        targetId: username,
        metadata: { reason: 'invalid_credentials' }
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createSession(user);
    await writeAuditLog(db, {
      actor: { id: user.id, username: user.username, role: user.role },
      action: 'AUTH_LOGIN_SUCCESS',
      targetType: 'auth',
      targetId: user.username
    });

    return res.json({
      token,
      expiresInSec: Math.floor(SESSION_TTL_MS / 1000),
      user: safeUserProfile(user),
      roles: roleMatrix()
    });
  } catch (err) {
    console.error('Login failed', err);
    return res.status(500).json({ error: 'Failed to login' });
  } finally {
    db.close();
  }
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const roleInfo = ROLE_PERMISSIONS[req.user.role] || { title: req.user.role, permissions: [] };
  return res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      role: req.user.role,
        agentScope: req.user.agentScope || '',
      authProvider: req.user.authProvider || 'local',
      roleTitle: roleInfo.title,
      permissions: roleInfo.permissions
    },
    roles: roleMatrix()
  });
});

app.post('/api/auth/logout', authRequired, (req, res) => {
  const db = openDb();
  (async () => {
    try {
      await writeAuditLog(db, {
        actor: req.user,
        action: 'AUTH_LOGOUT',
        targetType: 'auth',
        targetId: req.user.username
      });
    } catch (err) {
      console.error('Logout audit failed', err);
    } finally {
      db.close();
    }
  })();

  if (req.authType === 'local') {
    sessions.delete(req.authToken);
  }
  res.json({ success: true });
});

app.get('/api/auth/users', requirePermission('manage_users'), async (_req, res) => {
  if (ENTRA_ENABLED) {
    return res.status(400).json({ error: 'User lifecycle is managed by Microsoft Entra ID for this deployment' });
  }

  const db = openDb();
  try {
    await ensureUsersTable(db);
    const rows = await runQuery(
      db,
      `SELECT id, username, display_name, role, agent_scope, is_active, created_at
       FROM app_users
       ORDER BY lower(username) ASC`
    );

    const users = rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.display_name || row.username,
      role: row.role,
      agentScope: row.agent_scope || '',
      isActive: Number(row.is_active) === 1,
      createdAt: row.created_at
    }));

    return res.json({ users });
  } catch (err) {
    console.error('List users failed', err);
    return res.status(500).json({ error: 'Failed to load users' });
  } finally {
    db.close();
  }
});

app.get('/api/audit-logs', requirePermission('view_audit'), async (req, res) => {
  const db = openDb();
  try {
    await ensureAuditTable(db);

    const limitRaw = Number(req.query && req.query.limit ? req.query.limit : 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 200;
    const rows = await runQuery(
      db,
      `SELECT id, event_time, actor_user_id, actor_username, actor_role, action, target_type, target_id, metadata
       FROM audit_logs
       ORDER BY id DESC
       LIMIT ?`,
      [limit]
    );

    const logs = rows.map((row) => {
      let metadata = null;
      try {
        metadata = row.metadata ? JSON.parse(row.metadata) : null;
      } catch (_err) {
        metadata = { raw: row.metadata };
      }

      return {
        id: row.id,
        eventTime: row.event_time,
        actorUserId: row.actor_user_id,
        actorUsername: row.actor_username || 'system',
        actorRole: row.actor_role || 'system',
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        metadata
      };
    });

    return res.json({ logs });
  } catch (err) {
    console.error('Load audit logs failed', err);
    return res.status(500).json({ error: 'Failed to load audit logs' });
  } finally {
    db.close();
  }
});

app.post('/api/auth/users', requirePermission('manage_users'), async (req, res) => {
  if (ENTRA_ENABLED) {
    return res.status(400).json({ error: 'User lifecycle is managed by Microsoft Entra ID for this deployment' });
  }

  const db = openDb();
  try {
    await ensureUsersTable(db);

    const username = normalizeValue(req.body && req.body.username).toLowerCase();
    const displayName = normalizeValue(req.body && req.body.displayName);
    const role = normalizeValue(req.body && req.body.role).toLowerCase();
    const password = normalizeValue(req.body && req.body.password);
    const agentScope = normalizeValue(req.body && req.body.agentScope);

    if (!username || !role || !password) {
      return res.status(400).json({ error: 'username, role and password are required' });
    }
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-40 chars: letters, numbers, dot, underscore, hyphen' });
    }
    if (!ALL_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role value' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await runGet(db, 'SELECT id FROM app_users WHERE lower(username) = ? LIMIT 1', [username]);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const insertResult = await runExecute(
      db,
      'INSERT INTO app_users (username, display_name, password_hash, role, agent_scope, is_active) VALUES (?, ?, ?, ?, ?, 1)',
      [username, displayName || username, hashPassword(password), role, agentScope || null]
    );

    const created = await runGet(
      db,
      'SELECT id, username, display_name, role, agent_scope, is_active, created_at FROM app_users WHERE id = ?',
      [insertResult.lastID]
    );

    await writeAuditLog(db, {
      actor: req.user,
      action: 'USER_CREATE',
      targetType: 'user',
      targetId: created.username,
      metadata: {
        role: created.role,
        isActive: Number(created.is_active) === 1
      }
    });

    return res.status(201).json({
      user: {
        id: created.id,
        username: created.username,
        displayName: created.display_name || created.username,
        role: created.role,
        agentScope: created.agent_scope || '',
        isActive: Number(created.is_active) === 1,
        createdAt: created.created_at
      }
    });
  } catch (err) {
    console.error('Create user failed', err);
    return res.status(500).json({ error: 'Failed to create user' });
  } finally {
    db.close();
  }
});

app.patch('/api/auth/users/:id/status', requirePermission('manage_users'), async (req, res) => {
  if (ENTRA_ENABLED) {
    return res.status(400).json({ error: 'User lifecycle is managed by Microsoft Entra ID for this deployment' });
  }

  const db = openDb();
  try {
    await ensureUsersTable(db);

    const targetId = Number(req.params.id);
    const isActive = Boolean(req.body && req.body.isActive);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }
    if (targetId === Number(req.user.id) && !isActive) {
      return res.status(400).json({ error: 'You cannot deactivate your own account' });
    }

    const target = await runGet(db, 'SELECT id, username, is_active FROM app_users WHERE id = ?', [targetId]);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const previousStatus = Number(target.is_active) === 1;
    await runExecute(db, 'UPDATE app_users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, targetId]);

    await writeAuditLog(db, {
      actor: req.user,
      action: 'USER_STATUS_CHANGE',
      targetType: 'user',
      targetId: target.username,
      metadata: {
        from: previousStatus ? 'active' : 'inactive',
        to: isActive ? 'active' : 'inactive'
      }
    });

    if (!isActive) {
      for (const [token, session] of sessions.entries()) {
        if (session && Number(session.userId) === targetId) {
          sessions.delete(token);
        }
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Toggle user status failed', err);
    return res.status(500).json({ error: 'Failed to update user status' });
  } finally {
    db.close();
  }
});

app.post('/api/auth/users/:id/reset-password', requirePermission('manage_users'), async (req, res) => {
  if (ENTRA_ENABLED) {
    return res.status(400).json({ error: 'User lifecycle is managed by Microsoft Entra ID for this deployment' });
  }

  const db = openDb();
  try {
    await ensureUsersTable(db);
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'Invalid user id' });
    }

    const target = await runGet(db, 'SELECT id, username FROM app_users WHERE id = ?', [targetId]);
    if (!target) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newPassword = randomPassword(12);
    await runExecute(db, 'UPDATE app_users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), targetId]);

    await writeAuditLog(db, {
      actor: req.user,
      action: 'USER_PASSWORD_RESET',
      targetType: 'user',
      targetId: target.username
    });

    return res.json({
      success: true,
      username: target.username,
      temporaryPassword: newPassword
    });
  } catch (err) {
    console.error('Reset password failed', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  } finally {
    db.close();
  }
});

app.get('/login', (_req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/', (_req, res) => {
  res.redirect('/login');
});

app.get('/index.html', (_req, res, next) => {
  return next();
});

app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/rbac', authRequired, (req, res) => {
  res.json({
    currentRole: req.user.role,
    roles: roleMatrix()
  });
});

async function ensureStateTable(db) {
  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );
}

async function ensureNormalizedTables(db) {
  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY,
      agent_name TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS bank_accounts (
      source_id TEXT PRIMARY KEY,
      bank_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS trn_types (
      source_id TEXT PRIMARY KEY,
      trn_type_name TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS people_normalized (
      id INTEGER PRIMARY KEY,
      source_id TEXT UNIQUE,
      display_name TEXT NOT NULL,
      upi_id TEXT,
      bnktrn_id TEXT,
      agent_id INTEGER,
      agent_name TEXT,
      person_type TEXT NOT NULL DEFAULT 'Charity',
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runExecute(
    db,
    `CREATE TABLE IF NOT EXISTS transactions_normalized (
      id INTEGER PRIMARY KEY,
      source_id TEXT UNIQUE,
      tran_date TEXT,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      deposit REAL NOT NULL DEFAULT 0,
      withdrawal REAL NOT NULL DEFAULT 0,
      trn_type_tag TEXT,
      trn_type_name TEXT,
      trn_type_source_id TEXT,
      bank_account_source_id TEXT,
      matched_person_id INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await ensureColumnExists(db, 'people_normalized', 'payload_json', 'payload_json TEXT');
  await ensureColumnExists(db, 'transactions_normalized', 'payload_json', 'payload_json TEXT');

  await runExecute(db, 'CREATE INDEX IF NOT EXISTS idx_people_normalized_display_name ON people_normalized(display_name)');
  await runExecute(db, 'CREATE INDEX IF NOT EXISTS idx_people_normalized_upi_id ON people_normalized(upi_id)');
  await runExecute(db, 'CREATE INDEX IF NOT EXISTS idx_transactions_normalized_tran_date ON transactions_normalized(tran_date)');
  await runExecute(db, 'CREATE INDEX IF NOT EXISTS idx_transactions_normalized_bank_account_source_id ON transactions_normalized(bank_account_source_id)');
  await runExecute(db, 'CREATE INDEX IF NOT EXISTS idx_transactions_normalized_trn_type_source_id ON transactions_normalized(trn_type_source_id)');
}

async function seedNormalizedTablesFromLegacy(db) {
  await runExecute(db, 'DELETE FROM transactions_normalized');
  await runExecute(db, 'DELETE FROM people_normalized');
  await runExecute(db, 'DELETE FROM agents');
  await runExecute(db, 'DELETE FROM bank_accounts');
  await runExecute(db, 'DELETE FROM trn_types');

  const [fokRows, bankRows, trnTypeRows, bankNameRows] = await Promise.all([
    runQuery(db, 'SELECT * FROM FOK'),
    runQuery(db, 'SELECT * FROM Banktransaction'),
    runQuery(db, 'SELECT * FROM trntype'),
    runQuery(db, 'SELECT * FROM trnbanknametable')
  ]);

  const agentMap = new Map();
  for (const row of fokRows) {
    const agentName = normalizeValue(row.TransAdmin);
    if (!agentName || agentMap.has(agentName)) {
      continue;
    }
    const id = agentMap.size + 1;
    agentMap.set(agentName, id);
    await runExecute(db, 'INSERT INTO agents (id, agent_name, is_active) VALUES (?, ?, 1)', [id, agentName]);
  }

  const trnTypeLookup = new Map();
  for (const row of trnTypeRows) {
    const sourceId = normalizeValue(row.ID);
    if (!sourceId) continue;
    const trnTypeName = normalizeValue(row.TrnType);
    const description = normalizeValue(row.Description);
    trnTypeLookup.set(sourceId, trnTypeName);
    await runExecute(
      db,
      'INSERT OR REPLACE INTO trn_types (source_id, trn_type_name, description) VALUES (?, ?, ?)',
      [sourceId, trnTypeName, description || null]
    );
  }

  const bankLookup = new Map();
  for (const row of bankNameRows) {
    const sourceId = normalizeValue(row.ID);
    if (!sourceId) continue;
    const bankName = normalizeValue(row.BankName);
    bankLookup.set(sourceId, bankName);
    await runExecute(
      db,
      'INSERT OR REPLACE INTO bank_accounts (source_id, bank_name) VALUES (?, ?)',
      [sourceId, bankName]
    );
  }

  let personId = 0;
  for (const row of fokRows) {
    personId += 1;
    const sourceId = normalizeValue(row.id) || String(personId);
    const fullName = normalizeValue(row.full_name);
    const firstName = normalizeValue(row.first_name);
    const lastName = normalizeValue(row.last_name);
    const title = normalizeValue(row.title);
    const displayName = fullName || [firstName, lastName].filter(Boolean).join(' ') || title || 'Unknown';
    const agentName = normalizeValue(row.TransAdmin);
    const agentId = agentMap.get(agentName) || null;
    const upiId = normalizeValue(row.upi_id) || normalizeValue(row.email_id) || displayName;
    const bnktrnId = normalizeValue(row.Bnktrn_ID);

    await runExecute(
      db,
      `INSERT INTO people_normalized (
        id, source_id, display_name, upi_id, bnktrn_id, agent_id, agent_name, person_type, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        personId,
        sourceId,
        displayName,
        upiId,
        bnktrnId || null,
        agentId,
        agentName || null,
        'Charity',
        JSON.stringify({
          id: sourceId,
          name: displayName,
          upis: upiId,
          upi_id: normalizeValue(row.upi_id),
          bnktrn_id: bnktrnId || '',
          agent: agentName || '',
          type: 'Charity'
        })
      ]
    );
  }

  let transactionId = 0;
  const seenTransactionSourceIds = new Set();
  for (const row of bankRows) {
    transactionId += 1;
    const deposit = row.Deposit || 0;
    const withdrawal = row.Withdrawal || 0;
    const amount = deposit !== 0 ? deposit : -Number(withdrawal || 0);
    const originalSourceId = normalizeValue(row.TranID) || normalizeValue(row.SlNo) || String(transactionId);
    let sourceId = originalSourceId;
    if (seenTransactionSourceIds.has(sourceId)) {
      sourceId = `${sourceId}-${transactionId}`;
    }
    seenTransactionSourceIds.add(sourceId);
    const trnTypeTag = normalizeValue(row.TrnTypeTag);
    const trnTypeName = mapTrnTypeTag(row.TrnTypeTag, row.TranType, Object.fromEntries(trnTypeLookup.entries()));
    const bankSourceId = normalizeValue(row.trnbankname);

    await runExecute(
      db,
      `INSERT INTO transactions_normalized (
        id, source_id, tran_date, description, amount, deposit, withdrawal,
        trn_type_tag, trn_type_name, trn_type_source_id, bank_account_source_id, matched_person_id, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)` ,
      [
        transactionId,
        sourceId,
        normalizeValue(row.TranDate) || null,
        normalizeValue(row.Particulars) || '',
        amount,
        deposit || 0,
        withdrawal || 0,
        trnTypeTag || null,
        trnTypeName || null,
        trnTypeTag || null,
        bankSourceId || null,
        JSON.stringify({
          date: normalizeValue(row.TranDate),
          description: normalizeValue(row.Particulars) || '',
          amount,
          type: trnTypeName || 'Uncategorized',
          trnTypeTag: trnTypeTag || '',
          trnTypeName: trnTypeName || 'Uncategorized',
          bankId: bankSourceId || '',
          bankName: bankSourceId ? bankLookup.get(bankSourceId) || bankSourceId : 'Unassigned Bank',
          ref: originalSourceId,
          tran_id: sourceId
        })
      ]
    );
  }
}

async function ensureNormalizedDataReady(db) {
  await ensureNormalizedTables(db);
  const peopleCountRow = await runGet(db, 'SELECT COUNT(1) AS count FROM people_normalized');
  const transactionCountRow = await runGet(db, 'SELECT COUNT(1) AS count FROM transactions_normalized');
  const peopleCount = Number(peopleCountRow && peopleCountRow.count ? peopleCountRow.count : 0);
  const transactionCount = Number(transactionCountRow && transactionCountRow.count ? transactionCountRow.count : 0);

  if (peopleCount === 0 && transactionCount === 0) {
    await seedNormalizedTablesFromLegacy(db);
  }
}

async function persistNormalizedState(db, data) {
  const peopleList = ensureArray(data.people);
  const transactionList = ensureArray(data.transactions);

  await ensureNormalizedTables(db);

  await runExecute(db, 'BEGIN IMMEDIATE TRANSACTION');

  try {
    await runExecute(db, 'DELETE FROM transactions_normalized');
    await runExecute(db, 'DELETE FROM people_normalized');
    await runExecute(db, 'DELETE FROM agents');
    await runExecute(db, 'DELETE FROM bank_accounts');
    await runExecute(db, 'DELETE FROM trn_types');

    const agentMap = new Map();
    for (const person of peopleList) {
      const agentName = normalizeValue(person.agent);
      if (!agentName || agentMap.has(agentName)) {
        continue;
      }
      const agentId = agentMap.size + 1;
      agentMap.set(agentName, agentId);
      await runExecute(db, 'INSERT INTO agents (id, agent_name, is_active) VALUES (?, ?, 1)', [agentId, agentName]);
    }

    const bankMap = new Map();
    const trnTypeMap = new Map();
    let transactionOrdinal = 0;
    for (const transaction of transactionList) {
      transactionOrdinal += 1;
      const bankId = normalizeValue(transaction.bankId);
      const bankName = normalizeValue(transaction.bankName);
      if (bankId && !bankMap.has(bankId)) {
        bankMap.set(bankId, bankName || bankId);
      }

      const trnTypeId = normalizeValue(transaction.trnTypeTag);
      const trnTypeName = normalizeValue(transaction.trnTypeName || transaction.type);
      if (trnTypeId && !trnTypeMap.has(trnTypeId)) {
        trnTypeMap.set(trnTypeId, trnTypeName || trnTypeId);
      }
    }

    for (const [bankId, bankName] of bankMap.entries()) {
      await runExecute(db, 'INSERT INTO bank_accounts (source_id, bank_name) VALUES (?, ?)', [bankId, bankName]);
    }

    for (const [trnTypeId, trnTypeName] of trnTypeMap.entries()) {
      await runExecute(db, 'INSERT INTO trn_types (source_id, trn_type_name, description) VALUES (?, ?, ?)', [trnTypeId, trnTypeName, null]);
    }

    let personOrdinal = 0;
    for (const person of peopleList) {
      personOrdinal += 1;
      const sourceId = normalizeValue(person.source_id || person.id) || String(personOrdinal);
      const displayName = normalizeValue(person.name) || normalizeValue(person.display_name) || `Person ${personOrdinal}`;
      const agentName = normalizeValue(person.agent);
      const agentId = agentName ? (agentMap.get(agentName) || null) : null;
      const upiId = normalizeValue(person.upi_id) || normalizeValue(person.upis) || displayName;
      const bnktrnId = normalizeValue(person.bnktrn_id);
      const personType = normalizeValue(person.type || person.person_type) || 'Charity';
      const id = Number(person.id);

      await runExecute(
        db,
        `INSERT INTO people_normalized (
          id, source_id, display_name, upi_id, bnktrn_id, agent_id, agent_name, person_type, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [Number.isFinite(id) ? id : personOrdinal, sourceId, displayName, upiId || null, bnktrnId || null, agentId, agentName || null, personType, JSON.stringify(person)]
      );
    }

    const seenSourceIds = new Set();
    transactionOrdinal = 0;
    for (const transaction of transactionList) {
      transactionOrdinal += 1;
      const id = transactionOrdinal;
      const rawSourceId = normalizeValue(transaction.tran_id || transaction.ref || transaction.source_id) || String(id);
      let sourceId = rawSourceId;
      if (seenSourceIds.has(sourceId)) {
        sourceId = `${rawSourceId}-${id}`;
      }
      seenSourceIds.add(sourceId);

      const amount = Number(transaction.amount || 0);
      const deposit = amount > 0 ? amount : 0;
      const withdrawal = amount < 0 ? Math.abs(amount) : 0;
      const trnTypeTag = normalizeValue(transaction.trnTypeTag);
      const trnTypeName = normalizeValue(transaction.trnTypeName || transaction.type) || 'Uncategorized';
      const bankId = normalizeValue(transaction.bankId);

      await runExecute(
        db,
        `INSERT INTO transactions_normalized (
          id, source_id, tran_date, description, amount, deposit, withdrawal,
          trn_type_tag, trn_type_name, trn_type_source_id, bank_account_source_id, matched_person_id, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)` ,
        [
          id,
          sourceId,
          normalizeValue(transaction.date) || null,
          normalizeValue(transaction.description) || '',
          amount,
          deposit,
          withdrawal,
          trnTypeTag || null,
          trnTypeName,
          trnTypeTag || null,
          bankId || null,
          JSON.stringify(transaction)
        ]
      );
    }

    await runExecute(db, 'COMMIT');
  } catch (err) {
    try {
      await runExecute(db, 'ROLLBACK');
    } catch (_rollbackErr) {
      // Ignore rollback errors and rethrow original failure.
    }
    throw err;
  }
}

async function loadNormalizedBootstrap(db) {
  const trnTypeRows = await runQuery(
    db,
    'SELECT source_id, trn_type_name, description FROM trn_types ORDER BY source_id ASC'
  );
  const bankRows = await runQuery(
    db,
    'SELECT source_id, bank_name FROM bank_accounts ORDER BY source_id ASC'
  );
  const peopleRows = await runQuery(
    db,
    'SELECT id, source_id, display_name, upi_id, bnktrn_id, agent_id, agent_name, person_type, payload_json FROM people_normalized ORDER BY id ASC'
  );
  const transactionRows = await runQuery(
    db,
    'SELECT id, source_id, tran_date, description, amount, trn_type_tag, trn_type_name, trn_type_source_id, bank_account_source_id, payload_json FROM transactions_normalized ORDER BY id ASC'
  );

  const people = peopleRows.map((row) => {
    let payload = {};
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : {};
    } catch (_err) {
      payload = {};
    }

    return {
      ...payload,
      id: String(row.id),
      source_id: row.source_id || String(row.id),
      name: row.display_name,
      upis: payload.upis || row.upi_id || row.display_name,
      aliases: payload.aliases || '',
      upi_id: row.upi_id || '',
      bnktrn_id: row.bnktrn_id || '',
      agent: row.agent_name || '',
      agent_id: row.agent_id || null,
      type: row.person_type || 'Charity'
    };
  });

  const trnTypes = trnTypeRows.map((row) => ({
    id: row.source_id,
    name: row.trn_type_name,
    description: row.description || ''
  }));

  const bankLookup = {};
  const banks = bankRows.map((row) => {
    bankLookup[row.source_id] = row.bank_name;
    return {
      id: row.source_id,
      name: row.bank_name
    };
  });

  const transactions = transactionRows.map((row) => {
    let payload = {};
    try {
      payload = row.payload_json ? JSON.parse(row.payload_json) : {};
    } catch (_err) {
      payload = {};
    }

    return {
      ...payload,
      date: row.tran_date || '',
      description: row.description,
      amount: Number(row.amount || 0),
      type: row.trn_type_name || payload.type || 'Uncategorized',
      trnTypeTag: row.trn_type_tag || '',
      trnTypeName: row.trn_type_name || payload.trnTypeName || 'Uncategorized',
      bankId: row.bank_account_source_id || '',
      bankName: bankLookup[row.bank_account_source_id] || row.bank_account_source_id || payload.bankName || 'Unassigned Bank',
      ref: payload.ref || row.source_id || String(row.id),
      tran_id: row.source_id || String(row.id)
    };
  });

  return { people, transactions, trnTypes, banks };
}

async function buildBootstrap(db) {
  await ensureNormalizedDataReady(db);
  return loadNormalizedBootstrap(db);
}

function parsePositiveInt(value, fallback, maxValue = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return Math.min(parsed, maxValue);
}

function normalizeSortOrder(rawOrder) {
  return normalizeValue(rawOrder).toLowerCase() === 'asc' ? 'asc' : 'desc';
}

function toComparableText(value) {
  return normalizeValue(value).toLowerCase();
}

function paginateRows(rows, page, pageSize) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize;

  return {
    data: rows.slice(start, end),
    pagination: {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasNextPage: safePage < totalPages,
      hasPrevPage: safePage > 1
    }
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/bootstrap', requireRole(['admin', 'agent', 'reviewer', 'viewer']), async (_req, res) => {
  const db = openDb();

  try {
    const payload = await buildBootstrap(db);
    res.json(buildScopedStateForUser(_req.user, payload));
  } catch (err) {
    console.error('Bootstrap failed', err);
    res.status(500).json({ error: 'Failed to load bootstrap data' });
  } finally {
    db.close();
  }
});

app.get('/api/people', requireRole(['admin', 'agent', 'reviewer', 'viewer']), async (req, res) => {
  const db = openDb();

  try {
    await ensureNormalizedDataReady(db);
    const normalizedData = await loadNormalizedBootstrap(db);
    const scopedData = buildScopedStateForUser(req.user, normalizedData);

    let rows = ensureArray(scopedData.people);

    const q = toComparableText(req.query.q);
    const agent = normalizeValue(req.query.agent);
    const type = toComparableText(req.query.type);
    const sortBy = toComparableText(req.query.sortBy) || 'name';
    const order = normalizeSortOrder(req.query.order);
    const page = parsePositiveInt(req.query.page, 1, 1000000);
    const pageSize = parsePositiveInt(req.query.pageSize, 50, 500);

    if (q) {
      rows = rows.filter((person) => {
        const haystack = [
          person.id,
          person.source_id,
          person.name,
          person.upis,
          person.upi_id,
          person.bnktrn_id,
          person.agent,
          person.type
        ].map(toComparableText).join(' ');

        return haystack.includes(q);
      });
    }

    if (agent) {
      rows = rows.filter((person) => normalizeValue(person.agent) === agent);
    }

    if (type) {
      rows = rows.filter((person) => toComparableText(person.type) === type);
    }

    rows.sort((leftPerson, rightPerson) => {
      let left = '';
      let right = '';

      if (sortBy === 'agent') {
        left = toComparableText(leftPerson.agent);
        right = toComparableText(rightPerson.agent);
      } else if (sortBy === 'type') {
        left = toComparableText(leftPerson.type);
        right = toComparableText(rightPerson.type);
      } else if (sortBy === 'id') {
        left = toComparableText(leftPerson.id);
        right = toComparableText(rightPerson.id);
      } else {
        left = toComparableText(leftPerson.name);
        right = toComparableText(rightPerson.name);
      }

      const compared = left.localeCompare(right);
      return order === 'asc' ? compared : -compared;
    });

    const paged = paginateRows(rows, page, pageSize);
    return res.json({
      filters: {
        q: normalizeValue(req.query.q),
        agent,
        type,
        sortBy,
        order
      },
      data: paged.data,
      pagination: paged.pagination
    });
  } catch (err) {
    console.error('People read failed', err);
    return res.status(500).json({ error: 'Failed to load people' });
  } finally {
    db.close();
  }
});

// Create supporter
app.post('/api/people', requirePermission('write_state'), async (req, res) => {
  console.log('POST /api/people called by', req && req.user ? req.user.username : 'anonymous');
  console.log('Body:', req && req.body ? JSON.stringify(req.body) : '{}');
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const name = normalizeValue(req.body && req.body.name) || '';
    const upis = normalizeValue(req.body && req.body.upis) || '';
    const aliases = normalizeValue(req.body && req.body.aliases) || '';
    const agent = normalizeValue(req.body && req.body.agent) || '';
    const type = normalizeValue(req.body && req.body.type) || 'Charity';

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    // Determine next id
    const maxRow = await runGet(db, 'SELECT MAX(id) AS maxId FROM people_normalized');
    const nextId = (maxRow && Number(maxRow.maxId) ? Number(maxRow.maxId) + 1 : 1);

    const payload = { id: String(nextId), name, upis, aliases, agent, type };

    await runExecute(db,
      `INSERT INTO people_normalized (id, source_id, display_name, upi_id, bnktrn_id, agent_id, agent_name, person_type, payload_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [nextId, String(nextId), name, upis || null, null, agent || null, type, JSON.stringify(payload)]
    );

    await writeAuditLog(db, { actor: req.user, action: 'SUPPORTER_CREATE', targetType: 'supporter', targetId: String(nextId), metadata: payload });

    const created = await runGet(db, 'SELECT id, source_id, display_name, upi_id, bnktrn_id, agent_name, person_type, payload_json FROM people_normalized WHERE id = ?', [nextId]);
    const out = {
      ...payload,
      id: String(created.id),
      source_id: created.source_id || String(created.id),
      name: created.display_name,
      upis: created.upi_id || payload.upis || '',
      upi_id: created.upi_id || '',
      bnktrn_id: created.bnktrn_id || '',
      agent: created.agent_name || '',
      type: created.person_type || 'Charity'
    };

    console.log('Created person:', out);

    return res.status(201).json({ person: out });
  } catch (err) {
    console.error('Create supporter failed', err);
    return res.status(500).json({ error: 'Failed to create supporter' });
  } finally {
    db.close();
  }
});

// Update supporter
app.put('/api/people/:id', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) return res.status(400).json({ error: 'Invalid id' });

    const existing = await runGet(db, 'SELECT id, payload_json FROM people_normalized WHERE id = ?', [targetId]);
    if (!existing) return res.status(404).json({ error: 'Supporter not found' });

    const body = req.body || {};
    const name = normalizeValue(body.name) || null;
    const upis = normalizeValue(body.upis) || null;
    const aliases = normalizeValue(body.aliases) || null;
    const agent = normalizeValue(body.agent) || null;
    const type = normalizeValue(body.type) || null;

    const payloadObj = existing.payload_json ? JSON.parse(existing.payload_json || '{}') : {};
    if (name !== null) payloadObj.name = name;
    if (upis !== null) payloadObj.upis = upis;
    if (aliases !== null) payloadObj.aliases = aliases;
    if (agent !== null) payloadObj.agent = agent;
    if (type !== null) payloadObj.type = type;

    await runExecute(db, 'UPDATE people_normalized SET display_name = ?, upi_id = ?, payload_json = ?, agent_name = ?, person_type = ? WHERE id = ?', [payloadObj.name || existing.display_name, payloadObj.upis || null, JSON.stringify(payloadObj), payloadObj.agent || null, payloadObj.type || 'Charity', targetId]);

    await writeAuditLog(db, { actor: req.user, action: 'SUPPORTER_UPDATE', targetType: 'supporter', targetId: String(targetId), metadata: { changes: body } });

    const updated = await runGet(db, 'SELECT id, source_id, display_name, upi_id, bnktrn_id, agent_name, person_type, payload_json FROM people_normalized WHERE id = ?', [targetId]);
    const out = {
      id: String(updated.id),
      source_id: updated.source_id || String(updated.id),
      name: updated.display_name,
      upis: updated.upi_id || '',
      upi_id: updated.upi_id || '',
      bnktrn_id: updated.bnktrn_id || '',
      agent: updated.agent_name || '',
      type: updated.person_type || 'Charity'
    };
    return res.json({ person: out });
  } catch (err) {
    console.error('Update supporter failed', err);
    return res.status(500).json({ error: 'Failed to update supporter' });
  } finally {
    db.close();
  }
});

// Delete supporter
app.delete('/api/people/:id', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) return res.status(400).json({ error: 'Invalid id' });

    const existing = await runGet(db, 'SELECT id, display_name FROM people_normalized WHERE id = ?', [targetId]);
    if (!existing) return res.status(404).json({ error: 'Supporter not found' });

    // Unassign transactions
    await runExecute(db, 'UPDATE transactions_normalized SET matched_person_id = NULL WHERE matched_person_id = ?', [targetId]);
    await runExecute(db, 'DELETE FROM people_normalized WHERE id = ?', [targetId]);

    await writeAuditLog(db, { actor: req.user, action: 'SUPPORTER_DELETE', targetType: 'supporter', targetId: String(targetId), metadata: { name: existing.display_name } });

    return res.json({ success: true });
  } catch (err) {
    console.error('Delete supporter failed', err);
    return res.status(500).json({ error: 'Failed to delete supporter' });
  } finally {
    db.close();
  }
});

// Link identity (add upi or alias)
app.post('/api/people/:id/identities', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const targetId = Number(req.params.id);
    if (!Number.isFinite(targetId) || targetId <= 0) return res.status(400).json({ error: 'Invalid id' });

    const existing = await runGet(db, 'SELECT id, payload_json, upi_id FROM people_normalized WHERE id = ?', [targetId]);
    if (!existing) return res.status(404).json({ error: 'Supporter not found' });

    const body = req.body || {};
    const newUpi = normalizeValue(body.upi) || '';
    const newAlias = normalizeValue(body.alias) || '';

    const payloadObj = existing.payload_json ? JSON.parse(existing.payload_json || '{}') : {};
    payloadObj.upi_id = normalizeValue(payloadObj.upi_id || existing.upi_id || '');
    payloadObj.upis = mergeCommaValues(payloadObj.upis || payloadObj.upi_id || '', newUpi);
    if (newAlias) payloadObj.aliases = mergeCommaValues(payloadObj.aliases || '', newAlias);
    if (newUpi) payloadObj.upi_id = newUpi;

    await runExecute(db, 'BEGIN TRANSACTION');
    const serializedPayload = JSON.stringify(payloadObj);
    const updateSql = 'UPDATE people_normalized SET upi_id = ?, payload_json = ? WHERE id = ?';
    await runExecute(db, updateSql, [payloadObj.upi_id || null, serializedPayload, targetId]);

    await writeAuditLog(db, { actor: req.user, action: 'SUPPORTER_IDENTITY_LINK', targetType: 'supporter', targetId: String(targetId), metadata: { addedUpi: newUpi, addedAlias: newAlias } });
    await runExecute(db, 'COMMIT');

    const updated = await runGet(db, 'SELECT id, source_id, display_name, upi_id, bnktrn_id, agent_name, person_type, payload_json FROM people_normalized WHERE id = ?', [targetId]);
    const updatedPayload = updated.payload_json ? JSON.parse(updated.payload_json || '{}') : {};
    console.log('After update: upis=', updatedPayload.upis, 'upi_id=', updated.upi_id);
    const out = {
      id: String(updated.id),
      source_id: updated.source_id || String(updated.id),
      name: updated.display_name,
      upis: updatedPayload.upis || updated.upi_id || '',
      aliases: updatedPayload.aliases || '',
      upi_id: updated.upi_id || '',
      bnktrn_id: updated.bnktrn_id || '',
      agent: updated.agent_name || '',
      type: updated.person_type || 'Charity'
    };
    return res.json({ person: out });
  } catch (err) {
    console.error('Link identity failed', err);
    try {
      await runExecute(db, 'ROLLBACK');
    } catch (_rollbackErr) {
      console.error('Rollback failed after link identity error', _rollbackErr);
    }
    return res.status(500).json({ error: 'Failed to link identity' });
  } finally {
    db.close();
  }
});

// Merge supporter into target
app.post('/api/people/:id/merge', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const sourceId = Number(req.params.id);
    const targetId = Number(req.body && req.body.targetId);
    if (!Number.isFinite(sourceId) || !Number.isFinite(targetId) || sourceId <= 0 || targetId <= 0 || sourceId === targetId) {
      return res.status(400).json({ error: 'Invalid source or target id' });
    }

    const source = await runGet(db, 'SELECT id, display_name, upi_id, payload_json, agent_name, person_type FROM people_normalized WHERE id = ?', [sourceId]);
    const target = await runGet(db, 'SELECT id, display_name, upi_id, payload_json, agent_name, person_type FROM people_normalized WHERE id = ?', [targetId]);
    if (!source || !target) return res.status(404).json({ error: 'Source or target supporter not found' });

    const sourcePayload = source.payload_json ? JSON.parse(source.payload_json || '{}') : {};
    const targetPayload = target.payload_json ? JSON.parse(target.payload_json || '{}') : {};

    // Merge upis and aliases
    const mergedUpis = mergeCommaValues(targetPayload.upis || target.upi_id || '', sourcePayload.upis || source.upi_id || '');
    const mergedAliases = mergeCommaValues(targetPayload.aliases || '', sourcePayload.aliases || sourcePayload.name || source.display_name || '');

    if (!targetPayload.bnktrn_id && sourcePayload.bnktrn_id) targetPayload.bnktrn_id = sourcePayload.bnktrn_id;
    if (!targetPayload.agent && sourcePayload.agent) targetPayload.agent = sourcePayload.agent || source.agent_name;
    if (!targetPayload.type && sourcePayload.type) targetPayload.type = sourcePayload.type || source.person_type;
    if (sourcePayload.name && normalizeValue(sourcePayload.name).toLowerCase() !== normalizeValue(targetPayload.name || target.display_name).toLowerCase()) {
      targetPayload.aliases = mergeCommaValues(targetPayload.aliases || '', sourcePayload.name);
    }

    targetPayload.upis = mergedUpis;
    targetPayload.aliases = mergedAliases;

    await runExecute(db, 'UPDATE people_normalized SET upi_id = ?, payload_json = ?, agent_name = ?, person_type = ? WHERE id = ?', [targetPayload.upis || null, JSON.stringify(targetPayload), targetPayload.agent || target.agent_name, targetPayload.type || target.person_type, targetId]);

    // Reassign transactions
    await runExecute(db, 'UPDATE transactions_normalized SET matched_person_id = ? WHERE matched_person_id = ?', [targetId, sourceId]);

    // Delete source
    await runExecute(db, 'DELETE FROM people_normalized WHERE id = ?', [sourceId]);

    await writeAuditLog(db, { actor: req.user, action: 'SUPPORTER_MERGE', targetType: 'supporter', targetId: String(targetId), metadata: { mergedFrom: String(sourceId) } });

    const updated = await runGet(db, 'SELECT id, source_id, display_name, upi_id, bnktrn_id, agent_name, person_type, payload_json FROM people_normalized WHERE id = ?', [targetId]);
    const out = {
      id: String(updated.id),
      source_id: updated.source_id || String(updated.id),
      name: updated.display_name,
      upis: updated.upi_id || '',
      upi_id: updated.upi_id || '',
      bnktrn_id: updated.bnktrn_id || '',
      agent: updated.agent_name || '',
      type: updated.person_type || 'Charity'
    };

    return res.json({ person: out });
  } catch (err) {
    console.error('Merge supporter failed', err);
    return res.status(500).json({ error: 'Failed to merge supporters' });
  } finally {
    db.close();
  }
});

app.get('/api/transactions', requireRole(['admin', 'agent', 'reviewer', 'viewer']), async (req, res) => {
  const db = openDb();

  try {
    await ensureNormalizedDataReady(db);
    const normalizedData = await loadNormalizedBootstrap(db);
    const scopedData = buildScopedStateForUser(req.user, normalizedData);

    let rows = ensureArray(scopedData.transactions);

    const q = toComparableText(req.query.q);
    const status = toComparableText(req.query.status);
    const agent = normalizeValue(req.query.agent);
    const bank = normalizeValue(req.query.bank);
    const type = normalizeValue(req.query.type);
    const dateFrom = normalizeValue(req.query.dateFrom);
    const dateTo = normalizeValue(req.query.dateTo);
    const sortBy = toComparableText(req.query.sortBy) || 'date';
    const order = normalizeSortOrder(req.query.order);
    const page = parsePositiveInt(req.query.page, 1, 1000000);
    const pageSize = parsePositiveInt(req.query.pageSize, 50, 500);

    if (q) {
      rows = rows.filter((transaction) => {
        const haystack = [
          transaction.date,
          transaction.description,
          transaction.extractedUpi,
          transaction.matchedPersonName,
          transaction.assignedAgent,
          transaction.bankName,
          transaction.type,
          transaction.trnTypeName,
          transaction.ref,
          transaction.tran_id
        ].map(toComparableText).join(' ');

        return haystack.includes(q);
      });
    }

    if (status) {
      rows = rows.filter((transaction) => toComparableText(transaction.status) === status);
    }

    if (agent) {
      rows = rows.filter((transaction) => normalizeValue(transaction.assignedAgent) === agent);
    }

    if (bank) {
      rows = rows.filter((transaction) => normalizeValue(transaction.bankName) === bank);
    }

    if (type) {
      rows = rows.filter((transaction) => {
        const label = normalizeValue(transaction.trnTypeName || transaction.type);
        if (!label) return false;
        const parts = label.split('|').map((part) => normalizeValue(part)).filter(Boolean);
        if (parts.length === 0) return false;
        return parts.includes(type) || label === type;
      });
    }

    if (dateFrom) {
      rows = rows.filter((transaction) => !normalizeValue(transaction.date) || normalizeValue(transaction.date) >= dateFrom);
    }

    if (dateTo) {
      rows = rows.filter((transaction) => !normalizeValue(transaction.date) || normalizeValue(transaction.date) <= dateTo);
    }

    rows.sort((leftTransaction, rightTransaction) => {
      let compared = 0;

      if (sortBy === 'amount') {
        const leftAmount = Number(leftTransaction.amount || 0);
        const rightAmount = Number(rightTransaction.amount || 0);
        compared = leftAmount === rightAmount ? 0 : leftAmount < rightAmount ? -1 : 1;
      } else if (sortBy === 'agent') {
        compared = toComparableText(leftTransaction.assignedAgent).localeCompare(toComparableText(rightTransaction.assignedAgent));
      } else if (sortBy === 'status') {
        compared = toComparableText(leftTransaction.status).localeCompare(toComparableText(rightTransaction.status));
      } else {
        compared = toComparableText(leftTransaction.date).localeCompare(toComparableText(rightTransaction.date));
      }

      return order === 'asc' ? compared : -compared;
    });

    const paged = paginateRows(rows, page, pageSize);
    return res.json({
      filters: {
        q: normalizeValue(req.query.q),
        status,
        agent,
        bank,
        type,
        dateFrom,
        dateTo,
        sortBy,
        order
      },
      data: paged.data,
      pagination: paged.pagination
    });
  } catch (err) {
    console.error('Transaction read failed', err);
    return res.status(500).json({ error: 'Failed to load transactions' });
  } finally {
    db.close();
  }
});

// Create a new transaction
app.post('/api/transactions', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const payload = req.body || {};
    const description = normalizeValue(payload.description || '');
    const amount = Number(payload.amount || 0);
    const deposit = amount > 0 ? amount : 0;
    const withdrawal = amount < 0 ? Math.abs(amount) : 0;
    const trnTypeTag = normalizeValue(payload.trnTypeTag || payload.trn_type_tag || '');
    const trnTypeName = normalizeValue(payload.trnTypeName || payload.trn_type_name || payload.type || 'Uncategorized');
    const bankId = normalizeValue(payload.bankId || payload.bank_account_source_id || '');
    const sourceId = normalizeValue(payload.tran_id || payload.source_id) || String(Date.now());

    const insert = await runExecute(
      db,
      `INSERT INTO transactions_normalized (source_id, tran_date, description, amount, deposit, withdrawal, trn_type_tag, trn_type_name, trn_type_source_id, bank_account_source_id, payload_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [sourceId, normalizeValue(payload.date) || null, description, amount, deposit, withdrawal, trnTypeTag || null, trnTypeName || null, trnTypeTag || null, bankId || null, JSON.stringify(payload)]
    );

    const created = await runGet(db, 'SELECT id, source_id, tran_date, description, amount, trn_type_tag, trn_type_name, bank_account_source_id, payload_json FROM transactions_normalized WHERE id = ?', [insert.lastID]);

    await writeAuditLog(db, {
      actor: req.user,
      action: 'TRANSACTION_CREATE',
      targetType: 'transaction',
      targetId: created.source_id,
      metadata: { id: created.id }
    });

    return res.status(201).json({ transaction: created });
  } catch (err) {
    console.error('Create transaction failed', err);
    return res.status(500).json({ error: 'Failed to create transaction' });
  } finally {
    db.close();
  }
});

// Create multiple transactions in bulk
app.post('/api/transactions/bulk', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const transactions = Array.isArray(req.body) ? req.body : req.body.transactions;
    if (!Array.isArray(transactions)) {
      return res.status(400).json({ error: 'Expected an array of transactions' });
    }

    await runExecute(db, 'BEGIN TRANSACTION');
    const created = [];
    let count = 0;

    for (const payload of transactions) {
      const description = normalizeValue(payload.description || '');
      const amount = Number(payload.amount || 0);
      const deposit = amount > 0 ? amount : 0;
      const withdrawal = amount < 0 ? Math.abs(amount) : 0;
      const trnTypeTag = normalizeValue(payload.trnTypeTag || payload.trn_type_tag || '');
      const trnTypeName = normalizeValue(payload.trnTypeName || payload.trn_type_name || payload.type || 'Uncategorized');
      const bankId = normalizeValue(payload.bankId || payload.bank_account_source_id || '');
      
      const sourceId = normalizeValue(payload.tran_id || payload.source_id) || String(Date.now() + count);
      payload.source_id = sourceId;

      const matchedPersonId = normalizeValue(payload.matchedPersonId) || null;

      const insert = await runExecute(
        db,
        `INSERT INTO transactions_normalized (source_id, tran_date, description, amount, deposit, withdrawal, trn_type_tag, trn_type_name, trn_type_source_id, bank_account_source_id, matched_person_id, payload_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [sourceId, normalizeValue(payload.date) || null, description, amount, deposit, withdrawal, trnTypeTag || null, trnTypeName || null, trnTypeTag || null, bankId || null, matchedPersonId, JSON.stringify(payload)]
      );

      const row = await runGet(db, 'SELECT id, source_id, tran_date, description, amount, trn_type_tag, trn_type_name, bank_account_source_id, payload_json FROM transactions_normalized WHERE id = ?', [insert.lastID]);
      created.push(row);
      count++;
    }

    await writeAuditLog(db, {
      actor: req.user,
      action: 'TRANSACTION_BULK_CREATE',
      targetType: 'transaction',
      targetId: 'bulk',
      metadata: { count }
    });

    await runExecute(db, 'COMMIT');
    return res.status(201).json({ transactions: created });
  } catch (err) {
    try { await runExecute(db, 'ROLLBACK'); } catch (_e) {}
    console.error('Bulk create transactions failed', err);
    return res.status(500).json({ error: 'Failed to create transactions in bulk' });
  } finally {
    db.close();
  }
});

// Update an existing transaction by source_id
app.put('/api/transactions/:tranId', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const tranId = normalizeValue(req.params.tranId);
    if (!tranId) return res.status(400).json({ error: 'Invalid transaction id' });

    const existing = await runGet(db, 'SELECT id, source_id, payload_json FROM transactions_normalized WHERE source_id = ? LIMIT 1', [tranId]);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    const body = req.body || {};
    const description = typeof body.description === 'undefined' ? null : normalizeValue(body.description);
    const amount = typeof body.amount === 'undefined' ? null : Number(body.amount || 0);
    const trnTypeName = typeof body.trnTypeName === 'undefined' ? null : normalizeValue(body.trnTypeName || body.type || '');
    const trnTypeTag = typeof body.trnTypeTag === 'undefined' ? null : normalizeValue(body.trnTypeTag || '');
    const bankId = typeof body.bankId === 'undefined' ? null : normalizeValue(body.bankId || body.bank_account_source_id || '');
    const matchedPersonId = typeof body.matchedPersonId === 'undefined' ? null : (body.matchedPersonId || null);

    const updates = [];
    const params = [];
    if (description !== null) { updates.push('description = ?'); params.push(description); }
    if (amount !== null) { updates.push('amount = ?'); params.push(amount); updates.push('deposit = ?'); params.push(amount > 0 ? amount : 0); updates.push('withdrawal = ?'); params.push(amount < 0 ? Math.abs(amount) : 0); }
    if (trnTypeTag !== null) { updates.push('trn_type_tag = ?'); params.push(trnTypeTag); }
    if (trnTypeName !== null) { updates.push('trn_type_name = ?'); params.push(trnTypeName); }
    if (bankId !== null) { updates.push('bank_account_source_id = ?'); params.push(bankId); }
    if (matchedPersonId !== null) { updates.push('matched_person_id = ?'); params.push(matchedPersonId || null); }

    // Merge payload_json if provided
    let newPayload = {};
    try { newPayload = existing.payload_json ? JSON.parse(existing.payload_json) : {}; } catch (_e) { newPayload = {}; }
    Object.assign(newPayload, body);

    params.push(JSON.stringify(newPayload));
    updates.push('payload_json = ?');
    updates.push('updated_at = CURRENT_TIMESTAMP');

    const sql = `UPDATE transactions_normalized SET ${updates.join(', ')} WHERE source_id = ?`;
    params.push(tranId);

    await runExecute(db, sql, params);

    await writeAuditLog(db, {
      actor: req.user,
      action: 'TRANSACTION_UPDATE',
      targetType: 'transaction',
      targetId: tranId,
      metadata: { changes: Object.keys(body) }
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Transaction update failed', err);
    return res.status(500).json({ error: 'Failed to update transaction' });
  } finally {
    db.close();
  }
});

// Delete a transaction
app.delete('/api/transactions/:tranId', requirePermission('write_state'), async (req, res) => {
  const db = openDb();
  try {
    await ensureNormalizedTables(db);
    const tranId = normalizeValue(req.params.tranId);
    if (!tranId) return res.status(400).json({ error: 'Invalid transaction id' });

    const existing = await runGet(db, 'SELECT id, source_id FROM transactions_normalized WHERE source_id = ? LIMIT 1', [tranId]);
    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    await runExecute(db, 'DELETE FROM transactions_normalized WHERE source_id = ?', [tranId]);

    await writeAuditLog(db, {
      actor: req.user,
      action: 'TRANSACTION_DELETE',
      targetType: 'transaction',
      targetId: tranId
    });

    return res.json({ success: true });
  } catch (err) {
    console.error('Transaction delete failed', err);
    return res.status(500).json({ error: 'Failed to delete transaction' });
  } finally {
    db.close();
  }
});

app.get('/api/state', requireRole(['admin', 'agent', 'reviewer', 'viewer']), async (_req, res) => {
  const db = openDb();

  try {
    await ensureStateTable(db);

    await ensureNormalizedDataReady(db);
    const normalizedData = await loadNormalizedBootstrap(db);
    const scopedData = buildScopedStateForUser(_req.user, normalizedData);
    const serialized = JSON.stringify(normalizedData);

    let row = await runGet(db, 'SELECT id, version, updated_at FROM app_state WHERE id = 1');
    if (!row) {
      await runExecute(
        db,
        'INSERT INTO app_state (id, data, version, updated_at) VALUES (1, ?, 1, CURRENT_TIMESTAMP)',
        [serialized]
      );
      row = { id: 1, version: 1, updated_at: new Date().toISOString() };
    } else {
      await runExecute(
        db,
        'UPDATE app_state SET data = ?, updated_at = updated_at WHERE id = 1',
        [serialized]
      );
    }

    res.json({
      version: row.version,
      updatedAt: row.updated_at,
      data: scopedData
    });
  } catch (err) {
    console.error('State read failed', err);
    res.status(500).json({ error: 'Failed to read application state' });
  } finally {
    db.close();
  }
});

app.put('/api/state', requireRole(['admin', 'agent', 'reviewer']), async (req, res) => {
  const db = openDb();

  try {
    const { data, version } = req.body || {};
    if (!data || !Array.isArray(data.people) || !Array.isArray(data.transactions)) {
      return res.status(400).json({ error: 'Invalid payload: expected state data with people and transactions arrays' });
    }

    await ensureStateTable(db);
    await ensureNormalizedDataReady(db);

    const current = await runGet(db, 'SELECT id, data, version FROM app_state WHERE id = 1');
    const currentVersion = current ? Number(current.version) : 0;
    const incomingVersion = Number(version);
    const currentData = await loadNormalizedBootstrap(db);

    if (current && Number.isFinite(incomingVersion) && incomingVersion !== currentVersion) {
      await writeAuditLog(db, {
        actor: req.user,
        action: 'STATE_UPDATE_CONFLICT',
        targetType: 'app_state',
        targetId: '1',
        metadata: {
          incomingVersion,
          currentVersion
        }
      });

      return res.status(409).json({
        error: 'Version conflict',
        currentVersion,
        currentData: buildScopedStateForUser(req.user, currentData)
      });
    }

    let nextData = data;
    if (isAgentScoped(req.user)) {
      const currentScopedPeople = ensureArray(currentData.people).filter((person) => isPersonVisibleToUser(req.user, person));
      const currentScopedPersonLookup = buildScopedPersonLookup(req.user, currentScopedPeople);
      const currentScopedTransactions = ensureArray(currentData.transactions).filter((transaction) => isTransactionVisibleToUser(req.user, transaction, currentScopedPersonLookup));
      const submittedPeople = ensureArray(data.people);
      const submittedTransactions = ensureArray(data.transactions);
      const submittedScopedPersonLookup = buildScopedPersonLookup(req.user, submittedPeople);

      const validScopedPeople = submittedPeople.every((person) => isPersonVisibleToUser(req.user, person));
      const validScopedTransactions = submittedTransactions.every((transaction) => isTransactionVisibleToUser(req.user, transaction, submittedScopedPersonLookup));
      const samePeopleKeys = sameIdentitySet(currentScopedPeople, submittedPeople, personIdentity);
      const sameTransactionKeys = sameIdentitySet(currentScopedTransactions, submittedTransactions, transactionIdentity);

      if (!validScopedPeople || !validScopedTransactions || !samePeopleKeys || !sameTransactionKeys) {
        return res.status(403).json({ error: 'Forbidden: agents may only update their assigned records without creating or deleting rows' });
      }

      const scopedPeopleMap = new Map(submittedPeople.map((person) => [personIdentity(person), person]));
      const scopedTransactionsMap = new Map(submittedTransactions.map((transaction) => [transactionIdentity(transaction), transaction]));

      nextData = {
        ...currentData,
        people: ensureArray(currentData.people).map((person) => {
          const key = personIdentity(person);
          return scopedPeopleMap.has(key) ? scopedPeopleMap.get(key) : person;
        }),
        transactions: ensureArray(currentData.transactions).map((transaction) => {
          const key = transactionIdentity(transaction);
          return scopedTransactionsMap.has(key) ? scopedTransactionsMap.get(key) : transaction;
        })
      };
    }

    await persistNormalizedState(db, nextData);

    const nextVersion = currentVersion + 1;
    const normalizedData = await loadNormalizedBootstrap(db);
    await runExecute(
      db,
      `INSERT INTO app_state (id, data, version, updated_at)
       VALUES (1, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id)
       DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = CURRENT_TIMESTAMP`,
      [JSON.stringify(normalizedData), nextVersion]
    );

    await writeAuditLog(db, {
      actor: req.user,
      action: 'STATE_UPDATE',
      targetType: 'app_state',
      targetId: '1',
      metadata: {
        fromVersion: currentVersion,
        toVersion: nextVersion,
        peopleCount: Array.isArray(normalizedData.people) ? normalizedData.people.length : 0,
        transactionCount: Array.isArray(normalizedData.transactions) ? normalizedData.transactions.length : 0
      }
    });

    return res.json({ version: nextVersion });
  } catch (err) {
    console.error('State write failed', err);
    return res.status(500).json({ error: 'Failed to persist application state' });
  } finally {
    db.close();
  }
});

app.use(express.static(__dirname));

app.listen(PORT, () => {
  console.log(`Server running at http://127.0.0.1:${PORT}`);
});
