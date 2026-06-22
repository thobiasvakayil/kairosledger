// Core Application Controller

// State variables
let transactions = [];
let people = [];

let txPage = 1;
const txPageSize = 50; // 50 rows per page for extreme DOM speed

let txDateSort = 'desc'; // 'desc' = newest first, 'asc' = oldest first

let peoplePage = 1;
const peoplePageSize = 50;

const DEFAULT_AGENTS = ["Agent Alpha", "Agent Beta", "Agent Gamma", "Agent Delta", "Agent Epsilon"];

let apiStateVersion = null;
let apiSyncTimer = null;
let apiSyncInFlight = false;
let apiSyncPending = false;
let apiRetryTimer = null;
let isHydratingFromApi = false;
let currentUserRole = 'viewer';
let currentUserDisplayName = 'User';
let currentUserPermissions = [];
let currentUserAgentScope = '';
let availableRoles = [];
let adminUsers = [];
let auditLogs = [];
let supporterAuditEvents = [];

const AUTH_TOKEN_KEY = 'charity_auth_token';

// Initialize Database on load
window.onload = async function () {
  const authenticated = await ensureAuthenticated();
  if (!authenticated) return;

  const newPersonForm = document.getElementById('new-person-form');
  if (newPersonForm) {
    newPersonForm.addEventListener('submit', saveNewPerson);
  }

  initSyncControls();
  loadData();
  await hydrateFromApi();
  populatePersonAgentDropdown();

  if (people.length === 0) {
    seedDefaultDatabase();
  }

  if (transactions.length === 0) {
    loadSampleData();
  } else {
    // If transactions are loaded but matching hasn't run yet (e.g. initial seed), match all first
    if (transactions.length > 0 && !transactions[0].status) {
      matchAllTransactions();
    } else {
      renderTransactions();
      renderPeople();
      renderAgents();
    }
  }
};

function getAuthToken() {
  return localStorage.getItem(AUTH_TOKEN_KEY) || '';
}

// ------------------------------------------------------------------
// Targeted API helpers for CRUD operations (preferred over bulk state sync)
// ------------------------------------------------------------------
// utility: sleep
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// fetch with retry + exponential backoff
async function fetchWithRetry(url, options = {}, retries = 3, backoff = 600) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const resp = await fetch(url, options);
      if (resp.status === 401) { redirectToLogin(); return resp; }
      if (resp.ok) return resp;
      // Retry on server errors
      if (resp.status >= 500 && attempt < retries) {
        attempt += 1;
        await sleep(backoff * Math.pow(2, attempt - 1));
        continue;
      }
      return resp;
    } catch (err) {
      if (attempt >= retries) throw err;
      attempt += 1;
      await sleep(backoff * Math.pow(2, attempt - 1));
    }
  }
}

// Simple toast notifications
function showToast(message, type = 'info', duration = 4000) {
  try {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    // trigger show
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => { try { container.removeChild(el); } catch (e) {} }, 250);
    }, duration);
  } catch (_e) {}
}

async function apiCreatePerson(person) {
  try {
    console.log('apiCreatePerson() request body', person);
    const resp = await fetchWithRetry('/api/people', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(person)
    }, 3, 600);
    if (!resp || !resp.ok) {
      showToast('Failed to create supporter', 'error');
      return null;
    }
    const payload = await resp.json();
    if (payload && payload.person) {
      showToast('Supporter created', 'success');
      return payload.person;
    }
  } catch (e) {
    showToast('Failed to create supporter (network)', 'error');
  }
  return null;
}

async function apiUpdatePerson(personId, changes) {
  try {
    const resp = await fetchWithRetry(`/api/people/${personId}`, {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(changes)
    }, 3, 500);
    if (!resp || !resp.ok) {
      showToast('Failed to update supporter', 'error');
      return false;
    }
    showToast('Supporter saved', 'success');
    return true;
  } catch (e) { showToast('Failed to update supporter (network)', 'error'); return false; }
}

async function apiDeletePerson(personId) {
  try {
    const resp = await fetchWithRetry(`/api/people/${personId}`, {
      method: 'DELETE',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' })
    }, 2, 500);
    if (!resp || !resp.ok) { showToast('Failed to delete supporter', 'error'); return false; }
    showToast('Supporter deleted', 'success');
    return true;
  } catch (e) { showToast('Failed to delete supporter (network)', 'error'); return false; }
}

async function apiLinkIdentity(personId, upi, alias) {
  try {
    console.log('apiLinkIdentity() request', { personId, upi, alias });
    const resp = await fetchWithRetry(`/api/people/${personId}/identities`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ upi: upi || '', alias: alias || '' })
    }, 3, 400);
    if (!resp || !resp.ok) { showToast('Failed to link identity', 'error'); return null; }
    const p = await resp.json();
    showToast('Identity linked', 'success');
    return p && p.person ? p.person : null;
  } catch (e) { showToast('Failed to link identity (network)', 'error'); return null; }
}

async function apiMergePerson(sourceId, targetId) {
  try {
    const resp = await fetchWithRetry(`/api/people/${sourceId}/merge`, {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ targetId })
    }, 2, 600);
    if (!resp || !resp.ok) { showToast('Failed to merge supporters', 'error'); return null; }
    const p = await resp.json();
    showToast('Supporters merged', 'success');
    return p && p.person ? p.person : null;
  } catch (e) { showToast('Failed to merge supporters (network)', 'error'); return null; }
}

async function apiCreateTransaction(tx) {
  try {
    const resp = await fetchWithRetry('/api/transactions', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(tx)
    }, 3, 600);
    if (!resp || !resp.ok) { showToast('Failed to create transaction', 'error'); return null; }
    const payload = await resp.json();
    showToast('Transaction created', 'success');
    return payload && payload.transaction ? payload.transaction : null;
  } catch (e) { showToast('Failed to create transaction (network)', 'error'); return null; }
}

async function apiCreateTransactions(txList) {
  try {
    const resp = await fetchWithRetry('/api/transactions/bulk', {
      method: 'POST',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ transactions: txList })
    }, 2, 2000);
    if (!resp || !resp.ok) { showToast('Failed to bulk create transactions', 'error'); return null; }
    const payload = await resp.json();
    showToast(`Successfully created ${payload.transactions ? payload.transactions.length : 0} transactions`, 'success');
    return payload && payload.transactions ? payload.transactions : [];
  } catch (e) { showToast('Failed to bulk create transactions (network)', 'error'); return null; }
}

async function apiUpdateTransaction(tranId, changes) {
  try {
    const resp = await fetchWithRetry(`/api/transactions/${encodeURIComponent(tranId)}`, {
      method: 'PUT',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(changes)
    }, 2, 400);
    if (!resp || !resp.ok) { showToast('Failed to save transaction', 'error'); return false; }
    showToast('Transaction saved', 'success');
    return true;
  } catch (e) { showToast('Failed to save transaction (network)', 'error'); return false; }
}

async function apiDeleteTransaction(tranId) {
  try {
    const resp = await fetchWithRetry(`/api/transactions/${encodeURIComponent(tranId)}`, {
      method: 'DELETE',
      headers: getAuthHeaders({ 'Content-Type': 'application/json' })
    }, 2, 400);
    if (!resp || !resp.ok) { showToast('Failed to delete transaction', 'error'); return false; }
    showToast('Transaction deleted', 'success');
    return true;
  } catch (e) { showToast('Failed to delete transaction (network)', 'error'); return false; }
}

function getAuthHeaders(baseHeaders = {}) {
  const token = getAuthToken();
  return token
    ? { ...baseHeaders, Authorization: `Bearer ${token}` }
    : { ...baseHeaders };
}

function canWriteState() {
  return Array.isArray(currentUserPermissions) && currentUserPermissions.includes('write_state');
}

function canManageUsers() {
  return Array.isArray(currentUserPermissions) && currentUserPermissions.includes('manage_users');
}

function canViewAudit() {
  return Array.isArray(currentUserPermissions) && currentUserPermissions.includes('view_audit');
}

function requireWriteAccess() {
  if (canWriteState()) return true;
  updateSyncStatus('readonly', 'Your role has read-only access');
  alert('Your role has read-only access. Please contact an admin for edit permissions.');
  return false;
}

function redirectToLogin() {
  window.location.href = '/login';
}

async function ensureAuthenticated() {
  const token = getAuthToken();
  if (!token) {
    redirectToLogin();
    return false;
  }

  try {
    const response = await fetch('/api/auth/me', {
      method: 'GET',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    if (!response.ok) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      redirectToLogin();
      return false;
    }

    const payload = await response.json();
    if (!payload || !payload.user) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      redirectToLogin();
      return false;
    }

    currentUserRole = payload.user.role || 'viewer';
    currentUserDisplayName = payload.user.displayName || payload.user.username || 'User';
    currentUserPermissions = Array.isArray(payload.user.permissions) ? payload.user.permissions : [];
    currentUserAgentScope = payload.user.agentScope || '';
    availableRoles = Array.isArray(payload.roles) ? payload.roles : [];
    return true;
  } catch (_err) {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    redirectToLogin();
    return false;
  }
}

const ENTITY_READ_PAGE_SIZE = 500;

function normalizeDateValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  const text = (value || '').toString().trim();
  if (!text) return '';

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const slashMatch = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, '0');
    const month = slashMatch[2].padStart(2, '0');
    const year = slashMatch[3];
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return '';
}

function normalizeTransactionDateFields(list = transactions) {
  if (!Array.isArray(list)) return [];
  list.forEach((tx) => {
    if (!tx || typeof tx !== 'object') return;
    tx.date = normalizeDateValue(tx.date);
  });
  return list;
}

function getDateSortTimestamp(value) {
  const iso = normalizeDateValue(value);
  if (!iso) return 0;
  const ts = Date.parse(`${iso}T00:00:00`);
  return Number.isNaN(ts) ? 0 : ts;
}

async function fetchAllEntityRows(endpoint) {
  const rows = [];
  let page = 1;

  while (true) {
    const response = await fetch(`${endpoint}?page=${page}&pageSize=${ENTITY_READ_PAGE_SIZE}`, {
      method: 'GET',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    if (response.status === 401) {
      redirectToLogin();
      return null;
    }

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const pageData = payload && Array.isArray(payload.data) ? payload.data : null;
    const pagination = payload && payload.pagination ? payload.pagination : null;

    if (!pageData || !pagination) {
      return null;
    }

    rows.push(...pageData);
    if (!pagination.hasNextPage) {
      break;
    }
    page += 1;
  }

  return rows;
}

async function hydrateFromApi() {
  isHydratingFromApi = true;
  updateSyncStatus('syncing', 'Loading server state');
  try {
    // Prefer entity read endpoints as the forward-compatible read path.
    const [peopleRows, transactionRows] = await Promise.all([
      fetchAllEntityRows('/api/people'),
      fetchAllEntityRows('/api/transactions')
    ]);

    if (Array.isArray(peopleRows) && Array.isArray(transactionRows)) {
      people = peopleRows;
      transactions = transactionRows;
      normalizeTransactionDateFields(transactions);
      saveData({ skipApiSync: true });
      await ensureApiVersion();
      updateSyncStatus('synced', `Server version ${apiStateVersion || 'current'}`);
      return;
    }

    const stateResponse = await fetch('/api/state', {
      method: 'GET',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    if (stateResponse.status === 401) {
      redirectToLogin();
      return;
    }

    if (stateResponse.ok) {
      const statePayload = await stateResponse.json();
      if (
        statePayload &&
        statePayload.data &&
        Array.isArray(statePayload.data.people) &&
        Array.isArray(statePayload.data.transactions)
      ) {
        people = statePayload.data.people;
        transactions = statePayload.data.transactions;
        normalizeTransactionDateFields(transactions);
        apiStateVersion = Number(statePayload.version || 1);
        saveData({ skipApiSync: true });
        updateSyncStatus('synced', `Server version ${apiStateVersion}`);
        return;
      }
    }

    // Backward-compatible fallback for bootstrapping without persisted app state.
    const response = await fetch('/api/bootstrap', {
      method: 'GET',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    if (response.status === 401) {
      redirectToLogin();
      return;
    }

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.people) || !Array.isArray(payload.transactions)) {
      return;
    }

    people = payload.people;
    transactions = payload.transactions;
  normalizeTransactionDateFields(transactions);

    saveData({ skipApiSync: true });
    updateSyncStatus('idle', 'Using bootstrap payload');
  } catch (_err) {
    // Keep localStorage/seed fallback if API isn't available.
    updateSyncStatus('idle', 'API unavailable, local mode');
  } finally {
    isHydratingFromApi = false;
  }
}

function initSyncControls() {
  const rolePill = document.getElementById('user-role-pill');
  const userName = document.getElementById('user-display-name');
  if (rolePill) {
    rolePill.textContent = (currentUserRole || 'viewer').toUpperCase();
    rolePill.title = `Role permissions: ${currentUserPermissions.join(', ') || 'none'}`;
  }
  if (userName) {
    userName.textContent = currentUserDisplayName;
    userName.title = `${currentUserDisplayName} (${currentUserRole})`;
  }

  const adminTab = document.getElementById('tab-admin');
  if (adminTab) {
    adminTab.style.display = canManageUsers() ? 'inline-flex' : 'none';
  }

  const auditSection = document.getElementById('audit-log-section');
  if (auditSection) {
    auditSection.style.display = canViewAudit() ? 'block' : 'none';
  }

  const disableWrites = !canWriteState();
  const writeButtons = [
    document.querySelector('button[onclick="addNewTransactionRow()"]'),
    document.querySelector('button[onclick="clearAllData()"]'),
    document.querySelector('button[onclick="openNewPersonModal()"]')
  ];
  writeButtons.forEach((btn) => {
    if (!btn) return;
    btn.disabled = disableWrites;
    btn.title = disableWrites ? 'Your role has read-only access' : '';
  });

  const uploadInput = document.getElementById('csv-file-input');
  if (uploadInput) {
    uploadInput.disabled = disableWrites;
  }

  if (disableWrites) {
    updateSyncStatus('readonly', 'Your role has read-only access');
    return;
  }

  updateSyncStatus('idle', 'Waiting for changes');
}

async function logoutUser() {
  try {
    const token = getAuthToken();
    if (token) {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: getAuthHeaders({
          'Content-Type': 'application/json'
        })
      });
    }
  } catch (_err) {
    // Ignore network issues on logout and continue clearing local auth.
  } finally {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    redirectToLogin();
  }
}

function updateSyncStatus(state, detail) {
  const badge = document.getElementById('sync-status');
  if (!badge) return;

  const labels = {
    idle: 'Idle',
    pending: 'Pending',
    syncing: 'Syncing',
    synced: 'Synced',
    conflict: 'Conflict',
    error: 'Error',
    readonly: 'Read-only'
  };

  badge.classList.remove('sync-idle', 'sync-pending', 'sync-syncing', 'sync-synced', 'sync-conflict', 'sync-error', 'sync-readonly');
  badge.classList.add(`sync-${state}`);
  badge.textContent = labels[state] || 'Idle';
  badge.title = detail || labels[state] || 'Idle';
}

function scheduleApiRetry(delayMs = 2500) {
  if (apiRetryTimer) {
    clearTimeout(apiRetryTimer);
  }

  apiRetryTimer = setTimeout(() => {
    apiRetryTimer = null;
    scheduleApiStateSync(10);
  }, delayMs);
}

// -------------------------------------------------------------
// Database Persistence & Seeding
// -------------------------------------------------------------

function loadData() {
  try {
    const savedTx = localStorage.getItem('charity_ledger_transactions');
    const savedPeople = localStorage.getItem('charity_ledger_people');
    const savedSupporterAudit = localStorage.getItem('charity_ledger_supporter_audit');

    transactions = savedTx ? JSON.parse(savedTx) : [];
    people = savedPeople ? JSON.parse(savedPeople) : [];
    supporterAuditEvents = savedSupporterAudit ? JSON.parse(savedSupporterAudit) : [];
    normalizeTransactionDateFields(transactions);

    // Fallback to SQLite converted seed database if local storage is blank
    if (people.length === 0 && typeof SEED_DATABASE !== 'undefined') {
      people = SEED_DATABASE.people || [];
      transactions = SEED_DATABASE.transactions || [];
      saveData({ skipApiSync: true });
    }

    rebuildUpiIndex();
  } catch (e) {
    console.error("Error reading from localStorage", e);
    transactions = [];
    people = [];
    supporterAuditEvents = [];
  }
}

function saveData(options = {}) {
  normalizeTransactionDateFields(transactions);
  localStorage.setItem('charity_ledger_transactions', JSON.stringify(transactions));
  localStorage.setItem('charity_ledger_people', JSON.stringify(people));
  localStorage.setItem('charity_ledger_supporter_audit', JSON.stringify(supporterAuditEvents));
  rebuildUpiIndex();
  updateStats();
  renderAgents();

  if (!options.skipApiSync && !isHydratingFromApi) {
    scheduleApiStateSync();
  }
}

function scheduleApiStateSync(delayMs = 500) {
  apiSyncPending = true;
  updateSyncStatus('pending', 'Local changes waiting to sync');

  if (!canWriteState()) {
    updateSyncStatus('readonly', 'Current role cannot write state');
    return;
  }

  if (apiSyncInFlight) {
    return;
  }

  if (apiSyncTimer) {
    clearTimeout(apiSyncTimer);
  }

  apiSyncTimer = setTimeout(() => {
    apiSyncTimer = null;
    syncStateToApi();
  }, delayMs);
}

async function ensureApiVersion() {
  if (apiStateVersion !== null) {
    return;
  }

  try {
    const response = await fetch('/api/state', {
      method: 'GET',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    if (response.status === 401) {
      redirectToLogin();
      return;
    }

    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    apiStateVersion = Number(payload.version || 1);
  } catch (_err) {
    // API may be unavailable; keep local-only behavior.
  }
}

async function syncStateToApi() {
  if (apiSyncInFlight || !apiSyncPending) {
    return;
  }

  apiSyncInFlight = true;
  updateSyncStatus('syncing', 'Saving to server');

  try {
    apiSyncPending = false;
    await ensureApiVersion();

    const response = await fetch('/api/state', {
      method: 'PUT',
      headers: getAuthHeaders({
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify({
        version: apiStateVersion,
        data: {
          people,
          transactions
        }
      })
    });

    if (response.status === 403) {
      apiSyncPending = true;
      updateSyncStatus('readonly', 'Current role is not allowed to update state');
      return;
    }

    if (response.status === 401) {
      updateSyncStatus('error', 'Session expired; redirecting to login');
      localStorage.removeItem(AUTH_TOKEN_KEY);
      redirectToLogin();
      return;
    }

    if (response.status === 409) {
      const conflict = await response.json();
      if (conflict && conflict.currentData) {
        people = conflict.currentData.people || [];
        transactions = conflict.currentData.transactions || [];
        apiStateVersion = Number(conflict.currentVersion || apiStateVersion || 1);
        saveData({ skipApiSync: true });
        updateSyncStatus('conflict', 'Loaded latest server state after conflict');
        alert('Data changed by another user. Latest server copy was loaded. Please re-apply your edit.');
      }
      return;
    }

    if (!response.ok) {
      apiSyncPending = true;
      updateSyncStatus('error', `Server sync failed (${response.status})`);
      scheduleApiRetry(3000);
      return;
    }

    const payload = await response.json();
    if (payload && Number.isFinite(Number(payload.version))) {
      apiStateVersion = Number(payload.version);
      updateSyncStatus('synced', `Server version ${apiStateVersion}`);
      if (apiRetryTimer) {
        clearTimeout(apiRetryTimer);
        apiRetryTimer = null;
      }
    }
  } catch (_err) {
    apiSyncPending = true;
    updateSyncStatus('error', 'Network/API unavailable; retrying');
    scheduleApiRetry(3000);
  } finally {
    apiSyncInFlight = false;
    if (apiSyncPending && !apiSyncTimer) {
      scheduleApiStateSync(120);
    }
  }
}

function seedDefaultDatabase() {
  if (typeof SEED_DATABASE !== 'undefined') {
    people = SEED_DATABASE.people || [];
    saveData();
    renderPeople();
    matchAllTransactions();
    return;
  }
  
  people = [
    {
      id: "1",
      name: "Rohit Sharma",
      upis: "rohit@paytm, ROHIT SHARMA",
      agent: "Agent Alpha",
      type: "Charity"
    },
    {
      id: "2",
      name: "Priya Patel",
      upis: "priya@okaxis, PRIYA PATEL",
      agent: "Agent Beta",
      type: "Subscription"
    },
    {
      id: "3",
      name: "Amit Verma",
      upis: "amit@ybl, AMIT VERMA",
      agent: "Agent Gamma",
      type: "Charity"
    },
    {
      id: "4",
      name: "Sneha Reddy",
      upis: "sneha@oksbi, SNEHA REDDY",
      agent: "Agent Delta",
      type: "Subscription"
    },
    {
      id: "5",
      name: "Vikram Singh",
      upis: "vikram@oksbi, VIKRAM SINGH",
      agent: "Agent Epsilon",
      type: "Charity"
    }
  ];
  saveData();
  renderPeople();
  // Rematch transactions after seeding directory
  matchAllTransactions();
}

function loadSampleData() {
  if (typeof SEED_DATABASE !== 'undefined') {
    transactions = SEED_DATABASE.transactions || [];
    matchAllTransactions();
    return;
  }

  transactions = [
    { date: "2026-05-10", description: "UPI-ROHIT SHARMA-rohit@paytm-492049102941", amount: 500, type: "Charity", ref: "492049102941" },
    { date: "2026-05-11", description: "UPI/PRIYA PATEL/priya@okaxis/10294827419", amount: 1200, type: "Subscription", ref: "10294827419" },
    { date: "2026-05-12", description: "UPI-AMIT VERMA-amit@ybl-930294819284", amount: 2000, type: "Charity", ref: "930294819284" },
    { date: "2026-05-13", description: "UPI/SNEHA REDDY/sneha@oksbi/492048201948", amount: 300, type: "Subscription", ref: "492048201948" },
    { date: "2026-05-14", description: "UPI-VIKRAM SINGH-vikram@oksbi-129482019472", amount: 1500, type: "Charity", ref: "129482019472" },
    { date: "2026-05-15", description: "UPI-NEW DONOR-newdonor@okicici-820194820194", amount: 2500, type: "Charity", ref: "820194820194" }
  ];

  matchAllTransactions();
}

function clearAllData() {
  if (!requireWriteAccess()) return;
  if (confirm("Would you like to reset all data and reload the database from your converted SQLite file?")) {
    localStorage.removeItem('charity_ledger_transactions');
    localStorage.removeItem('charity_ledger_people');
    
    if (typeof SEED_DATABASE !== 'undefined') {
      people = SEED_DATABASE.people || [];
      transactions = SEED_DATABASE.transactions || [];
      saveData();
      matchAllTransactions();
    } else {
      transactions = [];
      people = [];
      saveData();
    }
    
    renderTransactions();
    renderPeople();
    alert("Database successfully re-seeded!");
  }
}

// -------------------------------------------------------------
// UPI Extraction & Matching Logic
// -------------------------------------------------------------

/**
 * Intelligent parser to extract UPI user identification or ID from messy banking strings
 */
function extractUPIIdentifier(desc) {
  if (!desc) return "";

  const str = desc.trim();

  // Pattern 1: Standard Indian bank UPI transfer pattern separated by slashes: UPI/Name/ID/Ref or UPI/ID/Name/Ref
  // Example: UPI/PRIYA PATEL/priya@okaxis/10294827419
  if (str.includes('/')) {
    const parts = str.split('/');
    // Check elements for email-like UPI IDs
    for (let part of parts) {
      if (part.includes('@')) {
        return part.trim();
      }
    }
    // If no explicit @ handle, look for the likely sender name (element index 1 or 2, usually longer text)
    if (parts.length > 1) {
      // Pick the first substantial alphabetical-only string representing a name
      for (let i = 1; i < parts.length; i++) {
        if (/^[A-Za-z\s]+$/.test(parts[i].trim()) && parts[i].trim().length > 3) {
          return parts[i].trim();
        }
      }
      return parts[1].trim();
    }
  }

  // Pattern 2: Hyphen separated transaction line: UPI-NAME-UPIID-RefNo
  // Example: UPI-ROHIT SHARMA-rohit@paytm-492049102941
  if (str.includes('-')) {
    const parts = str.split('-');
    for (let part of parts) {
      if (part.includes('@')) {
        return part.trim();
      }
    }
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        if (/^[A-Za-z\s]+$/.test(parts[i].trim()) && parts[i].trim().length > 3) {
          return parts[i].trim();
        }
      }
      return parts[1].trim();
    }
  }

  // Fallback: search for any email/upi handles using regex
  const upiRegex = /([a-zA-Z0-9.\-_]+@[a-zA-Z0-9.\-_]+)/;
  const match = str.match(upiRegex);
  if (match) {
    return match[1];
  }

  // Final fallback: clean up and return first 25 characters
  return str.substring(0, 25);
}

let upiMap = {};

function normalizeLookupKey(value) {
  return (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[“”‘’]/g, '')
    .replace(/[^a-z0-9@.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAgentOptions() {
  const agentSet = new Set();

  people.forEach((person) => {
    if (person.agent) {
      agentSet.add(person.agent.trim());
    }
  });

  if (agentSet.size === 0) {
    DEFAULT_AGENTS.forEach((agent) => agentSet.add(agent));
  }

  return Array.from(agentSet).sort((a, b) => a.localeCompare(b));
}

function rebuildUpiIndex() {
  upiMap = {};
  if (!Array.isArray(people)) return;

  people.forEach((person) => {
    const aliases = new Set();
    if (person.upis) {
      person.upis.split(/[;,]+/).forEach((alias) => aliases.add(alias));
    }
    if (person.aliases) {
      person.aliases.split(/[;,]+/).forEach((alias) => aliases.add(alias));
    }
    if (person.alternate_names) {
      person.alternate_names.split(/[;,]+/).forEach((alias) => aliases.add(alias));
    }
    if (person.upi_id) {
      aliases.add(person.upi_id);
    }
    if (person.bnktrn_id) {
      aliases.add(person.bnktrn_id);
    }
    if (person.name) {
      aliases.add(person.name);
    }
    if (person.id) {
      aliases.add(String(person.id));
    }

    aliases.forEach((alias) => {
      const key = normalizeLookupKey(alias);
      if (key) {
        upiMap[key] = person;
      }
    });
  });
}

function getSupporterSearchText(person) {
  const pieces = [];
  if (person.name) pieces.push(person.name);
  if (person.upis) pieces.push(person.upis);
  if (person.aliases) pieces.push(person.aliases);
  if (person.alternate_names) pieces.push(person.alternate_names);
  if (person.upi_id) pieces.push(person.upi_id);
  if (person.bnktrn_id) pieces.push(person.bnktrn_id);
  return normalizeLookupKey(pieces.join(' '));
}

function scoreSupporterMatch(person, query, tx) {
  const normalizedText = getSupporterSearchText(person);
  let score = 0;
  if (!query) {
    score += 5;
  } else if (normalizedText.includes(query)) {
    score += 30;
  }

  if (tx && tx.extractedUpi) {
    const extractedKey = normalizeLookupKey(tx.extractedUpi);
    if (extractedKey && normalizedText.includes(extractedKey)) {
      score += 40;
    }
  }

  if (tx && tx.description) {
    const descKey = normalizeLookupKey(tx.description);
    if (descKey && normalizedText.includes(descKey)) {
      score += 10;
    }
  }

  return score;
}

/**
 * Searches the master people database to find a matching registered profile (highly optimized O(1) hash lookup)
 */
function findDatabaseMatch(upiIdentifier, txRef, txDescription = '') {
  const query = normalizeLookupKey(upiIdentifier);
  if (query && upiMap[query]) {
    return upiMap[query];
  }

  const refKey = normalizeLookupKey(txRef);
  if (refKey && upiMap[refKey]) {
    return upiMap[refKey];
  }

  const descriptionKey = normalizeLookupKey(txDescription);
  const fallback = people
    .map((person) => ({ person, score: scoreSupporterMatch(person, query || descriptionKey, { extractedUpi: query, description: descriptionKey }) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  return fallback ? fallback.person : null;
}

/**
 * Runs matching logic across the full transactions array
 */
function matchAllTransactions() {
  const updates = [];

  transactions.forEach((tx, idx) => {
    // 1. Auto extract identifier
    tx.extractedUpi = extractUPIIdentifier(tx.description);

    // 2. Search database matching
    const match = findDatabaseMatch(tx.extractedUpi, tx.ref || tx.tran_id, tx.description);

    let changed = false;
    
    if (match) {
      if (tx.matchedPersonId !== match.id) changed = true;
      tx.matchedPersonId = match.id;
      tx.matchedPersonName = match.name;
      tx.assignedAgent = match.agent;
      tx.status = "Matched";
      if (!tx.type) {
        tx.type = match.type || "Charity";
        changed = true;
      }
    } else {
      if (tx.matchedPersonId !== "") changed = true;
      tx.matchedPersonId = "";
      tx.matchedPersonName = "";
      tx.assignedAgent = "";
      tx.status = "Unmatched";
      if (!tx.type) {
        tx.type = "Charity";
        changed = true;
      }
    }

    if (changed) {
      const txId = tx.tran_id || tx.ref || tx.source_id;
      if (txId) {
        updates.push({
          txId,
          changes: {
            matchedPersonId: tx.matchedPersonId || null,
            assignedAgent: tx.assignedAgent || null,
            type: tx.type || null
          }
        });
      }
    }
  });

  saveData();

  if (updates.length > 0) {
    (async () => {
      // Fire and forget or await Promise.all
      await Promise.all(updates.map(u => apiUpdateTransaction(u.txId, u.changes)));
      await hydrateFromApi();
      renderTransactions();
    })();
  } else {
    renderTransactions();
  }
}

// -------------------------------------------------------------
// Spreadsheet Rendering & Grid Controls
// -------------------------------------------------------------

// Switch between Sheets tabs
function switchTab(tabName) {
  if (tabName === 'admin' && !canManageUsers()) {
    alert('Only administrators can access user management.');
    return;
  }

  document.querySelectorAll('.sheet-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

  document.getElementById(`tab-${tabName}`).classList.add('active');
  document.getElementById(`content-${tabName}`).classList.add('active');

  if (tabName === 'admin') {
    loadAdminUsers();
    loadAuditLogs();
  }
}

function renderAuditLogs() {
  const tbody = document.getElementById('audit-logs-tbody');
  const grid = document.getElementById('audit-logs-grid');
  const emptyState = document.getElementById('empty-state-audit');
  const info = document.getElementById('audit-log-info');
  const searchEl = document.getElementById('search-audit-logs');
  if (!tbody || !grid || !emptyState || !info) return;

  const search = (searchEl && searchEl.value ? searchEl.value : '').toLowerCase().trim();
  const filtered = auditLogs.filter((log) => {
    const haystack = [
      log.action,
      log.actorUsername,
      log.actorRole,
      log.targetType,
      log.targetId,
      JSON.stringify(log.metadata || {})
    ].join(' ').toLowerCase();
    return !search || haystack.includes(search);
  });

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    grid.style.display = 'none';
    emptyState.style.display = 'flex';
    info.textContent = 'No audit events match the current search.';
    return;
  }

  grid.style.display = 'table';
  emptyState.style.display = 'none';
  info.textContent = `Showing ${filtered.length} of ${auditLogs.length} audit events`;

  filtered.forEach((log, idx) => {
    const tr = document.createElement('tr');
    const detailsRaw = log.metadata ? JSON.stringify(log.metadata) : '';
    const detailsText = detailsRaw.length > 180 ? `${detailsRaw.slice(0, 180)}...` : detailsRaw;
    const targetText = [log.targetType || '', log.targetId || ''].filter(Boolean).join(': ');

    tr.innerHTML = `
      <td class="row-number">${idx + 1}</td>
      <td>${log.eventTime || ''}</td>
      <td>${log.action || ''}</td>
      <td>${log.actorUsername || 'system'}</td>
      <td>${(log.actorRole || 'system').toUpperCase()}</td>
      <td>${targetText}</td>
      <td title="${detailsRaw.replace(/"/g, '&quot;')}">${detailsText}</td>
    `;

    tbody.appendChild(tr);
  });
}

async function loadAuditLogs() {
  if (!canViewAudit()) return;
  const info = document.getElementById('audit-log-info');
  if (info) info.textContent = 'Loading audit events...';

  try {
    const response = await fetch('/api/audit-logs?limit=300', {
      method: 'GET',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    if (response.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      redirectToLogin();
      return;
    }

    if (response.status === 403) {
      if (info) info.textContent = 'You do not have permission to view audit logs.';
      return;
    }

    if (!response.ok) {
      if (info) info.textContent = `Failed to load audit logs (${response.status}).`;
      return;
    }

    const payload = await response.json();
    auditLogs = Array.isArray(payload.logs) ? payload.logs : [];
    if (Array.isArray(supporterAuditEvents) && supporterAuditEvents.length > 0) {
      auditLogs = auditLogs.concat(supporterAuditEvents.map((entry) => ({
        id: `local-${entry.id}`,
        eventTime: entry.eventTime,
        actorUsername: entry.actorUsername,
        actorRole: entry.actorRole,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: entry.metadata
      })));
    }
    renderAuditLogs();
  } catch (_err) {
    if (info) info.textContent = 'Unable to load audit events right now.';
  }
}

function renderAdminUsers() {
  const tbody = document.getElementById('admin-users-tbody');
  const grid = document.getElementById('admin-users-grid');
  const emptyState = document.getElementById('empty-state-admin');
  const info = document.getElementById('admin-user-info');
  const searchEl = document.getElementById('search-admin-users');
  if (!tbody || !grid || !emptyState || !info) return;

  const search = (searchEl && searchEl.value ? searchEl.value : '').toLowerCase().trim();
  const filtered = adminUsers.filter((user) => {
    const status = user.isActive ? 'active' : 'inactive';
    return !search ||
      user.username.toLowerCase().includes(search) ||
      (user.displayName || '').toLowerCase().includes(search) ||
      (user.role || '').toLowerCase().includes(search) ||
      status.includes(search);
  });

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    grid.style.display = 'none';
    emptyState.style.display = 'flex';
    info.textContent = 'No users match the current search.';
    return;
  }

  grid.style.display = 'table';
  emptyState.style.display = 'none';
  info.textContent = `Showing ${filtered.length} of ${adminUsers.length} users`;

  filtered.forEach((user, idx) => {
    const tr = document.createElement('tr');
    const statusClass = user.isActive ? 'badge-matched' : 'badge-unmatched';
    const statusText = user.isActive ? 'Active' : 'Inactive';

    tr.innerHTML = `
      <td class="row-number">${idx + 1}</td>
      <td>${user.username}</td>
      <td>${user.displayName || user.username}</td>
      <td>${(user.role || '').toUpperCase()}</td>
      <td><span class="badge ${statusClass}">${statusText}</span></td>
      <td>${user.createdAt || ''}</td>
      <td style="display:flex; gap:0.45rem;">
        <button class="btn btn-sm" onclick="toggleAdminUserStatus(${user.id}, ${user.isActive ? 'false' : 'true'})">${user.isActive ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-sm" onclick="resetAdminUserPassword(${user.id})">Reset Password</button>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

async function loadAdminUsers() {
  if (!canManageUsers()) return;
  const info = document.getElementById('admin-user-info');
  if (info) info.textContent = 'Loading users...';

  try {
    const response = await fetch('/api/auth/users', {
      method: 'GET',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    if (response.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      redirectToLogin();
      return;
    }
    if (response.status === 403) {
      if (info) info.textContent = 'You do not have permission to view users.';
      return;
    }
    if (!response.ok) {
      if (info) info.textContent = `Failed to load users (${response.status}).`;
      return;
    }

    const payload = await response.json();
    adminUsers = Array.isArray(payload.users) ? payload.users : [];

    populateAdminRoleOptions();
    renderAdminUsers();
  } catch (_err) {
    if (info) info.textContent = 'Unable to load users right now.';
  }
}

function populateAdminRoleOptions() {
  const roleSelect = document.getElementById('admin-new-role');
  if (!roleSelect) return;

  const roleList = availableRoles.length > 0
    ? availableRoles.map((r) => r.role)
    : ['admin', 'agent', 'reviewer', 'viewer'];

  roleSelect.innerHTML = roleList
    .map((role) => `<option value="${role}">${role.toUpperCase()}</option>`)
    .join('');

  roleSelect.value = 'agent';
}

async function createAdminUser() {
  if (!canManageUsers()) return;

  const usernameEl = document.getElementById('admin-new-username');
  const displayEl = document.getElementById('admin-new-display');
  const roleEl = document.getElementById('admin-new-role');
  const passwordEl = document.getElementById('admin-new-password');
  const info = document.getElementById('admin-user-info');

  const username = usernameEl ? usernameEl.value.trim() : '';
  const displayName = displayEl ? displayEl.value.trim() : '';
  const role = roleEl ? roleEl.value : '';
  const password = passwordEl ? passwordEl.value : '';

  if (!username || !role || !password) {
    if (info) info.textContent = 'Username, role and temporary password are required.';
    return;
  }

  try {
    const response = await fetch('/api/auth/users', {
      method: 'POST',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ username, displayName, role, password })
    });

    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      redirectToLogin();
      return;
    }

    if (!response.ok) {
      if (info) info.textContent = payload.error || `Failed to create user (${response.status}).`;
      return;
    }

    if (info) info.textContent = `User ${username} created successfully.`;
    if (usernameEl) usernameEl.value = '';
    if (displayEl) displayEl.value = '';
    if (passwordEl) passwordEl.value = '';

    await loadAdminUsers();
  } catch (_err) {
    if (info) info.textContent = 'Unable to create user right now.';
  }
}

async function toggleAdminUserStatus(userId, isActive) {
  if (!canManageUsers()) return;
  const info = document.getElementById('admin-user-info');

  try {
    const response = await fetch(`/api/auth/users/${userId}/status`, {
      method: 'PATCH',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ isActive })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (info) info.textContent = payload.error || `Failed to update status (${response.status}).`;
      return;
    }

    if (info) info.textContent = 'User status updated.';
    await loadAdminUsers();
  } catch (_err) {
    if (info) info.textContent = 'Unable to update user status.';
  }
}

async function resetAdminUserPassword(userId) {
  if (!canManageUsers()) return;
  if (!confirm('Reset password for this user? A new temporary password will be generated.')) return;

  const info = document.getElementById('admin-user-info');

  try {
    const response = await fetch(`/api/auth/users/${userId}/reset-password`, {
      method: 'POST',
      headers: getAuthHeaders({
        'Content-Type': 'application/json'
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (info) info.textContent = payload.error || `Failed to reset password (${response.status}).`;
      return;
    }

    const message = `Temporary password for ${payload.username}: ${payload.temporaryPassword}`;
    if (info) info.textContent = 'Password reset successful. See alert for temporary password.';
    alert(message);
  } catch (_err) {
    if (info) info.textContent = 'Unable to reset password right now.';
  }
}

// Render Sheet 1: Transactions Grid
function renderTransactions() {
  const tbody = document.getElementById('transactions-tbody');
  const emptyState = document.getElementById('empty-state-tx');
  const searchQuery = document.getElementById('search-tx').value.toLowerCase();
  const filterDateStart = normalizeDateValue(document.getElementById('filter-date-start')?.value);
  const filterDateEnd = normalizeDateValue(document.getElementById('filter-date-end')?.value);
  const filterStatus = document.getElementById('filter-status').value;
  const filterAgent = document.getElementById('filter-agent').value;
  const filterBank = document.getElementById('filter-bank').value;
  const filterTrnType = document.getElementById('filter-trntype').value;

  tbody.innerHTML = '';

  // Update Date header arrow indicator
  const dateHeader = document.getElementById('th-date');
  if (dateHeader) dateHeader.querySelector('.sort-arrow').textContent = txDateSort === 'desc' ? ' ▼' : ' ▲';
  populateAgentFilter();
  populateBankFilter();
  populateTrnTypeFilter();

  // Filtered transactions list
  const filtered = transactions.filter((tx, originalIndex) => {
    // Search filter covers the text fields shown in the grid.
    const matchesSearch =
      (tx.description && tx.description.toLowerCase().includes(searchQuery)) ||
      (tx.extractedUpi && tx.extractedUpi.toLowerCase().includes(searchQuery)) ||
      (tx.matchedPersonName && tx.matchedPersonName.toLowerCase().includes(searchQuery));

    const txDate = normalizeDateValue(tx.date);
    let matchesDateRange = true;
    if (filterDateStart && txDate && txDate < filterDateStart) {
      matchesDateRange = false;
    }
    if (filterDateEnd && txDate && txDate > filterDateEnd) {
      matchesDateRange = false;
    }
    if ((filterDateStart || filterDateEnd) && !txDate) {
      matchesDateRange = false;
    }

    // Status filter
    let matchesStatus = true;
    if (filterStatus === 'matched') matchesStatus = tx.status === 'Matched';
    if (filterStatus === 'unmatched') matchesStatus = tx.status === 'Unmatched';

    // TrnType filter
    let matchesTrnType = true;
    const txTrnTypeName = (tx.trnTypeName || tx.type || '').trim();
    if (filterTrnType !== 'all') {
      const txTypes = txTrnTypeName.split('|').map((t) => t.trim()).filter(Boolean);
      matchesTrnType = txTypes.includes(filterTrnType) || txTrnTypeName === filterTrnType;
    }

    // Agent filter
    let matchesAgent = true;
    if (filterAgent !== 'all') matchesAgent = (tx.assignedAgent || '') === filterAgent;

    // Bank filter
    let matchesBank = true;
    if (filterBank !== 'all') matchesBank = (tx.bankName || 'Unassigned Bank') === filterBank;

    // Keep index references
    tx.originalIndex = originalIndex;

    return matchesSearch && matchesDateRange && matchesStatus && matchesTrnType && matchesAgent && matchesBank;
  });

  if (transactions.length === 0) {
    emptyState.style.display = 'flex';
    document.getElementById('transactions-grid').style.display = 'none';
    document.getElementById('tx-pagination').style.display = 'none';
    return;
  } else {
    emptyState.style.display = 'none';
    document.getElementById('transactions-grid').style.display = 'table';
  }

  // Sort by date
  filtered.sort((a, b) => {
    const da = getDateSortTimestamp(a.date);
    const db = getDateSortTimestamp(b.date);
    if (da < db) return txDateSort === 'desc' ? 1 : -1;
    if (da > db) return txDateSort === 'desc' ? -1 : 1;
    return 0;
  });

  // Calculate Pagination
  const totalPages = Math.ceil(filtered.length / txPageSize) || 1;
  if (txPage > totalPages) txPage = totalPages;
  if (txPage < 1) txPage = 1;

  const start = (txPage - 1) * txPageSize;
  const end = start + txPageSize;
  const pageItems = filtered.slice(start, end);

  // Update pagination indicators
  document.getElementById('tx-page-info').innerText = `Page ${txPage} of ${totalPages} (Rows ${start + 1} - ${Math.min(end, filtered.length)} of ${filtered.length})`;
  document.getElementById('tx-pagination').style.display = totalPages > 1 ? 'flex' : 'none';

  pageItems.forEach((tx, displayIdx) => {
    const row = document.createElement('tr');
    const readOnly = !canWriteState();
    const editableFlag = readOnly ? 'false' : 'true';

    // Format amount
    const amountVal = parseFloat(tx.amount || 0).toFixed(2);

    // Status badge HTML
    const isMatched = tx.status === "Matched";
    const statusBadgeClass = isMatched ? "badge-matched" : "badge-unmatched";
    const statusText = isMatched ? "Matched" : "Action Required";

    // Person Dropdown OR Quick Add HTML (Optimized click-to-activate dropdown)
    let personSelectorHTML = '';
    if (isMatched) {
      if (readOnly) {
        personSelectorHTML = `
          <div class="cell-select-wrapper">
            <span style="display: block; padding: 0.2rem 0.4rem;">${tx.matchedPersonName || 'Select Supporter'}</span>
          </div>
        `;
      } else {
        personSelectorHTML = `
          <div class="cell-select-wrapper" onclick="activatePersonSelect(this, ${tx.originalIndex}, '${tx.matchedPersonId}')">
            <span style="border-bottom: 1px dotted var(--text-secondary); cursor: pointer; display: block; padding: 0.2rem 0.4rem;">${tx.matchedPersonName || 'Select Supporter'}</span>
          </div>
        `;
      }
    } else {
      personSelectorHTML = `
        <button class="cell-action-btn" onclick="openQuickAddFromRow(${tx.originalIndex})" ${readOnly ? 'disabled' : ''}>
          👤 Register Supporter
        </button>
      `;
    }

    // Agent Dropdown HTML
    const txAgents = getAgentOptions();
    const agentSelectorHTML = `
      <div class="cell-select-wrapper">
        <select class="cell-select" onchange="handleRowAgentChange(${tx.originalIndex}, this.value)" ${readOnly ? 'disabled' : ''}>
          <option value="" ${!tx.assignedAgent ? 'selected' : ''}>— None —</option>
          ${txAgents.map(agent => `<option value="${agent}" ${agent === tx.assignedAgent ? 'selected' : ''}>${agent}</option>`).join('')}
        </select>
      </div>
    `;

    // Transaction type class
    const txTypeLabel = tx.trnTypeName || tx.type || 'Uncategorized';
    const lowerType = txTypeLabel.toLowerCase();
    const typeBadgeClass = lowerType.includes('donation') ? "badge-charity" : "badge-sub";

    row.innerHTML = `
      <td class="row-number">${start + displayIdx + 1}</td>
      <td>
        <span class="cell-date">${normalizeDateValue(tx.date)}</span>
      </td>
      <td class="cell-editable upi-desc" contenteditable="${editableFlag}" onblur="handleCellEdit(${tx.originalIndex}, 'description', this.innerText)" title="${tx.description}">${tx.description || ''}</td>
      <td><span style="font-family: monospace; font-size: 0.8rem; opacity: 0.85;">${tx.extractedUpi || ''}</span></td>
      <td>
        <span class="badge ${typeBadgeClass}">${txTypeLabel}</span>
      </td>
      <td class="transaction-types-cell">
        ${renderTransactionTypesCell(tx, tx.originalIndex)}
      </td>
      <td class="cell-editable" contenteditable="${editableFlag}" style="text-align: right; font-weight: 600;" onblur="handleCellEdit(${tx.originalIndex}, 'amount', this.innerText)">${amountVal}</td>
      <td>${personSelectorHTML}</td>
      <td>${agentSelectorHTML}</td>
    `;

    tbody.appendChild(row);
  });

  updateStats();
}

// Page Turning for Transactions
function changeTxPage(delta) {
  txPage += delta;
  renderTransactions();
}

function toggleDateSort() {
  txDateSort = txDateSort === 'desc' ? 'asc' : 'desc';
  txPage = 1;
  renderTransactions();
}

// Click-to-activate Dropdown for Supporters
function activatePersonSelect(wrapper, txIndex, currentPersonId) {
  if (!canWriteState()) return;
  // If already clicked and has a dropdown, ignore click
  if (wrapper.querySelector('select')) return;

  const select = document.createElement('select');
  select.className = 'cell-select';

  // Build the list dynamically ON DEMAND (only 1 drop-down is alive at any point!)
  let options = people.map(p => `<option value="${p.id}" ${p.id === currentPersonId ? 'selected' : ''}>${p.name}</option>`).join('');
  options += `<option value="unassign">— Unassign —</option>`;
  select.innerHTML = options;

  select.onchange = function () {
    handleRowPersonChange(txIndex, this.value);
  };

  select.onblur = function () {
    wrapper.innerHTML = `<span style="border-bottom: 1px dotted var(--text-secondary); cursor: pointer; display: block; padding: 0.2rem 0.4rem;">${select.options[select.selectedIndex].text}</span>`;
  };

  wrapper.innerHTML = '';
  wrapper.appendChild(select);
  select.focus();
}

// Render Sheet 2: People Grid
function renderPeople() {
  const tbody = document.getElementById('people-tbody');
  const emptyState = document.getElementById('empty-state-people');
  const searchQuery = document.getElementById('search-people').value.toLowerCase();

  tbody.innerHTML = '';

  const filtered = people.filter((p, originalIndex) => {
    p.originalIndex = originalIndex;
    return (
      p.name.toLowerCase().includes(searchQuery) ||
      p.upis.toLowerCase().includes(searchQuery) ||
      p.agent.toLowerCase().includes(searchQuery)
    );
  });

  if (people.length === 0) {
    emptyState.style.display = 'flex';
    document.getElementById('people-grid').style.display = 'none';
    document.getElementById('people-pagination').style.display = 'none';
    return;
  } else {
    emptyState.style.display = 'none';
    document.getElementById('people-grid').style.display = 'table';
  }

  // Calculate Pagination
  const totalPages = Math.ceil(filtered.length / peoplePageSize) || 1;
  if (peoplePage > totalPages) peoplePage = totalPages;
  if (peoplePage < 1) peoplePage = 1;

  const start = (peoplePage - 1) * peoplePageSize;
  const end = start + peoplePageSize;
  const pageItems = filtered.slice(start, end);

  // Update indicators
  document.getElementById('people-page-info').innerText = `Page ${peoplePage} of ${totalPages} (Profiles ${start + 1} - ${Math.min(end, filtered.length)} of ${filtered.length})`;
  document.getElementById('people-pagination').style.display = totalPages > 1 ? 'flex' : 'none';

  pageItems.forEach((p, displayIdx) => {
    const row = document.createElement('tr');
    const personAgents = getAgentOptions();
    const readOnly = !canWriteState();
    const editableFlag = readOnly ? 'false' : 'true';

    const aliasSummary = p.aliases ? `<div style="font-size:0.8rem; color:var(--text-secondary); margin-top:0.3rem; white-space:normal;">Aliases: ${p.aliases}</div>` : '';
    const upiDisplay = p.upis || '';

    row.innerHTML = `
      <td class="row-number">${start + displayIdx + 1}</td>
      <td class="cell-editable" contenteditable="${editableFlag}" onblur="handlePeopleEdit(${p.originalIndex}, 'name', this.innerText)">${p.name}</td>
      <td>
        <div class="cell-editable" contenteditable="${editableFlag}" style="font-family: monospace; font-size: 0.8rem;" onblur="handlePeopleEdit(${p.originalIndex}, 'upis', this.innerText)">${upiDisplay}</div>
        ${aliasSummary}
      </td>
      <td>
        <div class="cell-select-wrapper">
          <select class="cell-select" onchange="handlePeopleAgentChange(${p.originalIndex}, this.value)" ${readOnly ? 'disabled' : ''}>
            ${personAgents.map(agent => `<option value="${agent}" ${agent === p.agent ? 'selected' : ''}>${agent}</option>`).join('')}
          </select>
        </div>
      </td>
      <td>
        <div class="cell-select-wrapper">
          <select class="cell-select" onchange="handlePeopleTypeChange(${p.originalIndex}, this.value)" ${readOnly ? 'disabled' : ''}>
            <option value="Charity" ${p.type === 'Charity' ? 'selected' : ''}>Donation</option>
            <option value="Subscription" ${p.type === 'Subscription' ? 'selected' : ''}>Subscription</option>
          </select>
        </div>
      </td>
      <td style="display:flex; gap:0.45rem; flex-wrap:wrap; align-items:center;">
        <button class="btn btn-sm" onclick="openMergePersonModal('${p.id}')" ${readOnly ? 'disabled' : ''}>
          Merge
        </button>
        <button class="btn btn-danger btn-sm" onclick="deletePerson(${p.originalIndex})" ${readOnly ? 'disabled' : ''}>
          Remove
        </button>
      </td>
    `;

    tbody.appendChild(row);
  });
}

// Page Turning for People Directory
function changePeoplePage(delta) {
  peoplePage += delta;
  renderPeople();
}

function populateAgentFilter() {
  const select = document.getElementById('filter-agent');
  if (!select) return;

  const current = select.value || 'all';
  const agentSet = new Set();

  people.forEach((p) => {
    if (p.agent) agentSet.add(p.agent);
  });

  transactions.forEach((t) => {
    if (t.assignedAgent) agentSet.add(t.assignedAgent);
  });

  const agents = Array.from(agentSet).sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="all">Agents</option>${agents.map(agent => `<option value="${agent}">${agent}</option>`).join('')}`;
  if (agents.includes(current)) {
    select.value = current;
  } else {
    select.value = 'all';
  }
}

function populateBankFilter() {
  const select = document.getElementById('filter-bank');
  if (!select) return;

  const current = select.value || 'all';
  const bankSet = new Set();

  if (typeof SEED_DATABASE !== 'undefined' && Array.isArray(SEED_DATABASE.banks)) {
    SEED_DATABASE.banks.forEach((bank) => {
      const name = (bank && bank.name ? bank.name : '').trim();
      if (name) bankSet.add(name);
    });
  }

  transactions.forEach((tx) => {
    const name = (tx.bankName || '').trim();
    if (name) bankSet.add(name);
  });

  if (transactions.some((tx) => !tx.bankName)) {
    bankSet.add('Unassigned Bank');
  }

  const banks = Array.from(bankSet).sort((a, b) => a.localeCompare(b));
  select.innerHTML = `<option value="all">Account Types</option>${banks.map((bank) => `<option value="${bank}">${bank}</option>`).join('')}`;

  if (banks.includes(current)) {
    select.value = current;
  } else {
    select.value = 'all';
  }
}

function populateTrnTypeFilter() {
  const select = document.getElementById('filter-trntype');
  if (!select) return;

  const formatTrnTypeLabel = (text, maxLen = 30) => {
    const value = (text || '').trim();
    if (value.length <= maxLen) return value;
    return `${value.slice(0, maxLen).trim()}......`;
  };

  const current = select.value || 'all';
  const typeSet = new Set();

  if (typeof SEED_DATABASE !== 'undefined' && Array.isArray(SEED_DATABASE.trnTypes)) {
    SEED_DATABASE.trnTypes.forEach((item) => {
      const name = (item && item.name ? item.name : '').trim();
      if (name) typeSet.add(name);
    });
  }

  const excluded = new Set(['cash', 'clg', 'ib', 'imps', 'mb', 'neft', 'sbint', 'tfr', 'upi']);

  transactions.forEach((tx) => {
    const name = (tx.trnTypeName || tx.type || '').trim();
    if (!name) return;
    name.split('|').map((part) => part.trim()).filter(Boolean).forEach((part) => {
      if (!excluded.has(part.toLowerCase())) {
        typeSet.add(part);
      }
    });
  });

  const names = Array.from(typeSet).sort((a, b) => a.localeCompare(b));

  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = 'all';
  defaultOption.textContent = 'Transaction Types';
  defaultOption.title = 'Transaction Types';
  select.appendChild(defaultOption);

  names.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = formatTrnTypeLabel(name);
    option.title = name;
    select.appendChild(option);
  });

  if (names.includes(current)) {
    select.value = current;
  } else {
    select.value = 'all';
  }

  select.title = select.value === 'all' ? 'Transaction Types' : select.value;
}

function renderAgents() {
  const tbody = document.getElementById('agents-tbody');
  const emptyState = document.getElementById('empty-state-agents');
  const grid = document.getElementById('agents-grid');
  const searchInput = document.getElementById('search-agents');

  if (!tbody || !emptyState || !grid) return;

  const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const metrics = {};

  people.forEach((p) => {
    const agent = (p.agent || '').trim();
    if (!agent) return;
    if (!metrics[agent]) {
      metrics[agent] = { peopleCount: 0, matchedCount: 0, unmatchedCount: 0, totalAmount: 0 };
    }
    metrics[agent].peopleCount += 1;
  });

  transactions.forEach((tx) => {
    const agent = (tx.assignedAgent || '').trim();
    if (!agent) return;
    if (!metrics[agent]) {
      metrics[agent] = { peopleCount: 0, matchedCount: 0, unmatchedCount: 0, totalAmount: 0 };
    }
    if (tx.status === 'Matched') {
      metrics[agent].matchedCount += 1;
    } else {
      metrics[agent].unmatchedCount += 1;
    }
    metrics[agent].totalAmount += parseFloat(tx.amount || 0);
  });

  const rows = Object.keys(metrics)
    .filter((agent) => !searchQuery || agent.toLowerCase().includes(searchQuery))
    .sort((a, b) => a.localeCompare(b));

  tbody.innerHTML = '';

  if (rows.length === 0) {
    grid.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }

  grid.style.display = 'table';
  emptyState.style.display = 'none';

  rows.forEach((agent, idx) => {
    const item = metrics[agent];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="row-number">${idx + 1}</td>
      <td>${agent}</td>
      <td>${item.peopleCount}</td>
      <td>${item.matchedCount}</td>
      <td>${item.unmatchedCount}</td>
      <td style="text-align: right; font-weight: 600;">₹ ${item.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    `;
    tbody.appendChild(tr);
  });
}

function populatePersonAgentDropdown() {
  const select = document.getElementById('person-agent');
  if (!select) return;

  const agents = getAgentOptions();
  const current = select.value;
  select.innerHTML = agents.map(agent => `<option value="${agent}">${agent}</option>`).join('');

  // If the current user has an agent scope, prefer it as the default selection
  if (currentUserAgentScope && agents.includes(currentUserAgentScope)) {
    select.value = currentUserAgentScope;
  } else if (agents.includes(current)) {
    select.value = current;
  } else if (agents.length > 0) {
    select.value = agents[0];
  }
}

// -------------------------------------------------------------
// Interactive Editing Actions
// -------------------------------------------------------------

// Add empty manual transaction row
function addNewTransactionRow() {
  if (!requireWriteAccess()) return;
  const today = normalizeDateValue(new Date());
  transactions.unshift({
    date: today,
    description: "Manual UPI payment description...",
    amount: 0.00,
    type: "Charity",
    ref: ""
  });

  // Persist to backend and refresh authoritative state
  (async () => {
    const created = await apiCreateTransaction(transactions[0]);
    if (created) {
      await hydrateFromApi();
    } else {
      // fallback to local view
      matchAllTransactions();
      renderTransactions();
      alert('Failed to create transaction on server; saved locally only.');
    }
  })();
}

// Delete transaction row
function deleteTransactionRow(index) {
  if (!requireWriteAccess()) return;
  if (confirm("Delete this transaction row?")) {
    const tx = transactions[index];
    const txId = tx && (tx.tran_id || tx.ref || tx.tran_id || tx.source_id);
    (async () => {
      if (txId) {
        const ok = await apiDeleteTransaction(txId);
        if (ok) {
          await hydrateFromApi();
          return;
        }
      }
      // fallback local delete
      transactions.splice(index, 1);
      saveData();
      renderTransactions();
    })();
  }
}

// Handle transaction cell text edit
function handleCellEdit(index, field, newValue) {
  if (!canWriteState()) return;
  let val = newValue.trim();

  if (field === 'date') {
    val = normalizeDateValue(val);
  }

  if (field === 'amount') {
    val = parseFloat(val.replace(/[^\d.]/g, '')) || 0;
  }

  transactions[index][field] = val;

  // Re-run match logic if description was modified
  if (field === 'description') {
    transactions[index].extractedUpi = extractUPIIdentifier(val);
    const match = findDatabaseMatch(transactions[index].extractedUpi, transactions[index].ref || transactions[index].tran_id, val);
    if (match) {
      transactions[index].matchedPersonId = match.id;
      transactions[index].matchedPersonName = match.name;
      transactions[index].assignedAgent = match.agent;
      transactions[index].status = "Matched";
    } else {
      transactions[index].matchedPersonId = "";
      transactions[index].matchedPersonName = "";
      transactions[index].assignedAgent = "";
      transactions[index].status = "Unmatched";
    }
  }

  saveData();
  renderTransactions();

  // Persist single-transaction update to API
  (async () => {
    const tx = transactions[index];
    const txId = tx && (tx.tran_id || tx.ref || tx.tran_id || tx.source_id || tx.tran_id);
    const changes = {};
    changes[field] = val;
    if (field === 'description') {
      changes.extractedUpi = tx.extractedUpi;
      changes.matchedPersonId = tx.matchedPersonId;
      changes.assignedAgent = tx.assignedAgent;
      changes.type = tx.type;
    }
    if (txId) {
      const ok = await apiUpdateTransaction(txId, changes);
      if (ok) {
        await hydrateFromApi();
      } else {
        updateSyncStatus('error', 'Failed to save transaction');
      }
    } else {
      // No server id; attempt create
      const created = await apiCreateTransaction(tx);
      if (created) await hydrateFromApi();
    }
  })();
}

// Handle person row cell text edit
function handlePeopleEdit(index, field, newValue) {
  if (!canWriteState()) return;
  const old = { ...people[index] };
  people[index][field] = newValue.trim();
  renderPeople();
  matchAllTransactions(); // Remap matching records

  // Persist person update
  (async () => {
    const person = people[index];
    const ok = await apiUpdatePerson(person.id, { [field]: person[field] });
    if (ok) {
      await hydrateFromApi();
    } else {
      // revert
      people[index] = old;
      renderPeople();
      alert('Failed to update supporter on server. Changes reverted.');
    }
  })();
}

// Handle row dropdown changing the linked supporter
function handleRowPersonChange(txIndex, personId) {
  if (!canWriteState()) return;
  if (personId === 'unassign') {
    transactions[txIndex].matchedPersonId = "";
    transactions[txIndex].matchedPersonName = "";
    transactions[txIndex].assignedAgent = "";
    transactions[txIndex].status = "Unmatched";
    // persist
    (async () => {
      const tx = transactions[txIndex];
      const txId = tx && (tx.tran_id || tx.ref || tx.source_id);
      if (txId) {
        const ok = await apiUpdateTransaction(txId, { matchedPersonId: null });
        if (ok) await hydrateFromApi();
      } else {
        saveData();
      }
    })();
  } else {
    const match = people.find(p => p.id === personId);
    if (match) {
      transactions[txIndex].matchedPersonId = match.id;
      transactions[txIndex].matchedPersonName = match.name;
      transactions[txIndex].assignedAgent = match.agent;
      transactions[txIndex].type = match.type || "Charity";
      transactions[txIndex].status = "Matched";

      // Auto register the transaction description's extracted UPI into that person's mapping
      const ext = transactions[txIndex].extractedUpi;
      if (ext && !match.upis.includes(ext)) {
        // persist identity link
        (async () => {
          const updated = await apiLinkIdentity(match.id, ext, '');
          if (updated) {
            await hydrateFromApi();
            matchAllTransactions();
          } else {
            match.upis += `, ${ext}`;
            saveData();
            renderPeople();
          }
        })();
      }
    }
  }
  saveData();
  renderTransactions();
}

// Handle transaction row changing the agent manually
function handleRowAgentChange(txIndex, agentName) {
  if (!canWriteState()) return;
  transactions[txIndex].assignedAgent = agentName;
  renderTransactions();

  (async () => {
    const tx = transactions[txIndex];
    const txId = tx && (tx.tran_id || tx.ref || tx.source_id);
    if (txId) {
      const ok = await apiUpdateTransaction(txId, { assignedAgent: agentName });
      if (ok) await hydrateFromApi();
    } else {
      saveData();
    }
  })();
}

// Handle people directory changes
function handlePeopleAgentChange(personIndex, agentName) {
  if (!canWriteState()) return;
  people[personIndex].agent = agentName;
  renderPeople();
  matchAllTransactions();

  (async () => {
    const person = people[personIndex];
    const ok = await apiUpdatePerson(person.id, { agent: agentName });
    if (ok) await hydrateFromApi();
  })();
}

function handlePeopleTypeChange(personIndex, typeVal) {
  if (!canWriteState()) return;
  people[personIndex].type = typeVal;
  renderPeople();
  matchAllTransactions();

  (async () => {
    const person = people[personIndex];
    const ok = await apiUpdatePerson(person.id, { type: typeVal });
    if (ok) await hydrateFromApi();
  })();
}

function deletePerson(index) {
  if (!requireWriteAccess()) return;
  if (confirm(`Remove ${people[index].name} from directories? Associated records will lose matching tags.`)) {
    const person = people[index];
    (async () => {
      const ok = await apiDeletePerson(person.id);
      if (ok) {
        await hydrateFromApi();
        matchAllTransactions();
        renderPeople();
      } else {
        // fallback local remove
        people.splice(index, 1);
        saveData();
        renderPeople();
        matchAllTransactions();
      }
    })();
  }
}

// -------------------------------------------------------------
// Quick-Add Register Modal Dialog
// -------------------------------------------------------------

function normalizeSupporterValue(value) {
  return (value || '').toString().trim();
}

function buildSupporterList(value) {
  return normalizeSupporterValue(value)
    .split(/[;,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergeCommaValues(existing, incoming) {
  const merged = [];
  const seen = new Set();
  buildSupporterList(existing).forEach((item) => {
    const key = normalizeLookupKey(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  });
  buildSupporterList(incoming).forEach((item) => {
    const key = normalizeLookupKey(item);
    if (key && !seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  });
  return merged.join(', ');
}

function updatePersonModalActionLabel() {
  const submitButton = document.getElementById('person-modal-submit-btn');
  const selectedId = document.getElementById('modal-selected-supporter-id').value;
  if (submitButton) {
    submitButton.textContent = selectedId ? 'Link Identity & Match' : 'Create Profile & Match';
  }
}

function setSelectedSupporterId(id) {
  const input = document.getElementById('modal-selected-supporter-id');
  if (input) {
    input.value = id || '';
  }
  updatePersonModalActionLabel();
}

function clearSelectedSupporter() {
  setSelectedSupporterId('');
  const summary = document.getElementById('person-selected-supporter');
  if (summary) {
    summary.style.display = 'none';
  }
}

function renderSelectedSupporterSummary(person) {
  const summary = document.getElementById('person-selected-supporter');
  const details = document.getElementById('person-selected-supporter-summary');
  if (!summary || !details) return;

  const ids = [person.upis, person.upi_id].filter(Boolean).join(', ');
  const aliasText = [person.aliases, person.alternate_names].filter(Boolean).join(', ');
  details.innerHTML = `
    <div><strong>${person.name}</strong></div>
    <div style="font-size:0.88rem; margin-top:0.35rem; color:var(--text-secondary);">Agent: ${person.agent || 'Unassigned'} • Type: ${person.type || 'Charity'}</div>
    <div style="font-size:0.85rem; margin-top:0.45rem; color:var(--text-secondary);">Known IDs: ${ids || 'None'}</div>
    <div style="font-size:0.85rem; color:var(--text-secondary);">Aliases: ${aliasText || 'None'}</div>
  `;
  summary.style.display = 'block';
}

function updatePersonSearchResults() {
  const query = document.getElementById('person-search')?.value || '';
  const txIndex = Number(document.getElementById('modal-tx-index')?.value || '');
  const tx = Number.isFinite(txIndex) ? transactions[txIndex] : null;
  const results = findSupporterSuggestions(query, tx);
  const container = document.getElementById('person-search-results');
  if (!container) return;

  if (!Array.isArray(results) || results.length === 0) {
    container.innerHTML = '<div style="font-size:0.9rem; color:var(--text-secondary);">No existing supporter matches found yet. You can create a new profile or broaden your search.</div>';
    return;
  }

  container.innerHTML = results.map((person) => {
    const ids = [person.upis, person.upi_id].filter(Boolean).join(', ');
    const aliasText = person.aliases ? `Aliases: ${person.aliases}` : '';
    return `
      <button type="button" class="btn btn-sm" style="display:block; width:100%; text-align:left; margin-bottom:0.4rem;" onclick="selectSupporterMatch('${person.id}')">
        <div style="font-weight:700;">${person.name}</div>
        <div style="font-size:0.82rem; color:var(--text-secondary);">${ids || 'No known UPI IDs'}${aliasText ? ' • ' + aliasText : ''}</div>
      </button>
    `;
  }).join('');
}

function findSupporterSuggestions(query, tx) {
  const normalizedQuery = normalizeLookupKey(query || '');
  return people
    .map((person) => {
      const text = getSupporterSearchText(person);
      let score = 0;
      if (normalizedQuery && text.includes(normalizedQuery)) {
        score += 40;
      }
      if (tx && tx.extractedUpi) {
        const extractedKey = normalizeLookupKey(tx.extractedUpi);
        if (extractedKey && text.includes(extractedKey)) {
          score += 50;
        }
      }
      if (tx && tx.description) {
        const descKey = normalizeLookupKey(tx.description);
        if (descKey && text.includes(descKey)) {
          score += 15;
        }
      }
      if (!normalizedQuery && !tx) {
        score += 5;
      }
      return { person, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.person);
}

function selectSupporterMatch(personId) {
  console.debug('selectSupporterMatch()', personId);
  const person = people.find((p) => p.id === personId);
  if (!person) return;
  setSelectedSupporterId(personId);
  renderSelectedSupporterSummary(person);
}

function setSelectedSupporterId(id) {
  console.debug('setSelectedSupporterId()', id);
  const input = document.getElementById('modal-selected-supporter-id');
  if (input) {
    input.value = id || '';
  }
  updatePersonModalActionLabel();
}

function openNewPersonModal() {
  if (!requireWriteAccess()) return;
  document.getElementById('modal-context-alert').style.display = 'none';
  document.getElementById('modal-tx-index').value = '';
  document.getElementById('person-search').value = '';
  document.getElementById('person-name').value = '';
  document.getElementById('person-upi').value = '';
  document.getElementById('person-type').value = 'Charity';
  clearSelectedSupporter();
  updatePersonSearchResults();
  document.getElementById('person-modal').classList.add('active');
}

function openQuickAddFromRow(txIndex) {
  if (!requireWriteAccess()) return;
  const tx = transactions[txIndex];

  document.getElementById('modal-context-alert').style.display = 'block';
  document.getElementById('modal-tx-index').value = txIndex;
  clearSelectedSupporter();

  let suggestedName = tx.extractedUpi || tx.description || '';
  if (suggestedName.includes('@')) {
    suggestedName = suggestedName.split('@')[0].replace(/[.\-_]/g, ' ');
  }
  suggestedName = suggestedName.replace(/\b\w/g, (c) => c.toUpperCase());

  document.getElementById('person-search').value = tx.extractedUpi || tx.description || '';
  document.getElementById('person-name').value = suggestedName;
  document.getElementById('person-upi').value = tx.extractedUpi || '';
  document.getElementById('person-type').value = tx.type || 'Charity';
  updatePersonSearchResults();

  document.getElementById('person-modal').classList.add('active');
}

function closePersonModal() {
  document.getElementById('person-modal').classList.remove('active');
}

function addSupporterValue(person, field, rawValue) {
  const value = normalizeSupporterValue(rawValue);
  if (!value) return false;
  const values = buildSupporterList(person[field]);
  const key = normalizeLookupKey(value);
  if (values.map((item) => normalizeLookupKey(item)).includes(key)) return false;
  values.push(value);
  person[field] = values.join(', ');
  return true;
}

function recordSupporterAudit(action, person, metadata = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    eventTime: new Date().toISOString(),
    actorUsername: currentUserDisplayName || 'unknown',
    actorRole: currentUserRole || 'unknown',
    action,
    targetType: 'supporter',
    targetId: person.id,
    metadata
  };
  supporterAuditEvents.unshift(entry);
}

function linkSupporterIdentity(person, enteredName, enteredUpi, txIndex) {
  const previousValues = {
    name: person.name,
    upis: person.upis || '',
    aliases: person.aliases || ''
  };

  let changed = false;
  if (enteredUpi) {
    if (enteredUpi.includes('@')) {
      changed = addSupporterValue(person, 'upis', enteredUpi) || changed;
      if (!person.upi_id) {
        person.upi_id = enteredUpi;
      }
    } else {
      changed = addSupporterValue(person, 'aliases', enteredUpi) || changed;
    }
  }

  if (enteredName && normalizeLookupKey(enteredName) !== normalizeLookupKey(person.name)) {
    changed = addSupporterValue(person, 'aliases', enteredName) || changed;
  }

  if (changed) {
    recordSupporterAudit('SUPPORTER_LINKED', person, {
      previousValues,
      newValues: {
        upis: person.upis || '',
        aliases: person.aliases || ''
      }
    });
  }

  if (Number.isFinite(txIndex) && transactions[txIndex]) {
    transactions[txIndex].matchedPersonId = person.id;
    transactions[txIndex].matchedPersonName = person.name;
    transactions[txIndex].assignedAgent = person.agent;
    transactions[txIndex].type = person.type || 'Charity';
    transactions[txIndex].status = 'Matched';
  }
}

async function saveNewPerson(e) {
  console.log('Save clicked');
  const event = e || window.event;
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  if (!requireWriteAccess()) return;

  const name = document.getElementById('person-name').value.trim();
  const upi = document.getElementById('person-upi').value.trim();
  const agent = document.getElementById('person-agent').value;
  const type = document.getElementById('person-type').value;
  const txIndexVal = document.getElementById('modal-tx-index').value;
  const selectedId = document.getElementById('modal-selected-supporter-id').value;
  const txIndex = Number(txIndexVal);
  console.log('Selected person:', selectedId);
  console.log('Transaction:', txIndexVal, 'parsed txIndex=', txIndex);
  console.debug('saveNewPerson()', { name, upi, agent, type, selectedId, txIndex });

  if (!name || !upi) {
    console.log('Validation failed: missing name or upi', { name, upi });
    alert('Both full name and associated UPI / alias are required.');
    return;
  }

  if (selectedId) {
    const existing = people.find((p) => p.id === selectedId);
    console.log('Existing supporter resolved:', existing);
    if (existing) {
      // call server to link identity
      try {
        console.log('Before API call: apiLinkIdentity');
        const updated = await apiLinkIdentity(existing.id, upi, name);
        console.log('After API call: apiLinkIdentity', { updated });
        if (updated) {
          if (Number.isFinite(txIndex) && transactions[txIndex]) {
            const tx = transactions[txIndex];
            const txId = tx && (tx.tran_id || tx.ref || tx.source_id);
            if (txId) {
              await apiUpdateTransaction(txId, { matchedPersonId: existing.id });
            } else {
              tx.matchedPersonId = existing.id;
              await apiCreateTransaction(tx);
            }
          }
          await hydrateFromApi();
          populatePersonAgentDropdown();
          closePersonModal();
          matchAllTransactions();
          return;
        } else {
          linkSupporterIdentity(existing, name, upi, txIndex);
          recordSupporterAudit('SUPPORTER_UPDATED', existing, { note: 'Linked identity from registration modal (local)' });
          saveData();
          renderPeople();
        }
      } catch (_err) {
        console.log('Exception during apiLinkIdentity', _err);
        linkSupporterIdentity(existing, name, upi, txIndex);
        recordSupporterAudit('SUPPORTER_UPDATED', existing, { note: 'Linked identity from registration modal (local)' });
        saveData();
        renderPeople();
      }
    }
  } else {
    // create on server
    try {
      const created = await apiCreatePerson({ name, upis: upi, aliases: '', agent, type });
      if (created) {
        console.log('After API call: apiCreatePerson', { created });
        if (Number.isFinite(txIndex) && transactions[txIndex]) {
          // link transaction to created person
          const tx = transactions[txIndex];
          const txId = tx && (tx.tran_id || tx.ref || tx.source_id);
          if (txId) {
            await apiUpdateTransaction(txId, { matchedPersonId: created.id });
          } else {
            tx.matchedPersonId = created.id;
            await apiCreateTransaction(tx);
          }
        }
        await hydrateFromApi();
        populatePersonAgentDropdown();
        closePersonModal();
        matchAllTransactions();
        return;
      }
    } catch (_err) {
      console.log('Exception during apiCreatePerson', _err);
      // fall through to local fallback below
    }

    // Fallback: local-only create if server persistence failed
    const newId = Date.now().toString();
    const newSupporter = { id: newId, name, upis: upi, aliases: '', alternate_names: '', agent, type };
    people.push(newSupporter);
    if (Number.isFinite(txIndex) && transactions[txIndex]) {
      transactions[txIndex].matchedPersonId = newSupporter.id;
      transactions[txIndex].matchedPersonName = newSupporter.name;
      transactions[txIndex].assignedAgent = newSupporter.agent;
      transactions[txIndex].type = newSupporter.type || 'Charity';
      transactions[txIndex].status = 'Matched';
    }
    recordSupporterAudit('SUPPORTER_CREATE', newSupporter, { name: newSupporter.name, upis: newSupporter.upis, agent: newSupporter.agent, type: newSupporter.type });
    saveData();
    renderPeople();
    matchAllTransactions();
  }

  populatePersonAgentDropdown();
  renderPeople();
  matchAllTransactions();
  closePersonModal();
}

function openMergePersonModal(sourcePersonId) {
  if (!requireWriteAccess()) return;
  const source = people.find((p) => p.id === sourcePersonId);
  if (!source) return;

  const select = document.getElementById('merge-target-person');
  if (!select) return;

  select.innerHTML = people
    .filter((person) => person.id !== sourcePersonId)
    .map((person) => `<option value="${person.id}">${person.name}${person.upis ? ` (${person.upis})` : ''}</option>`)
    .join('');

  document.getElementById('merge-source-person-id').value = sourcePersonId;
  document.getElementById('merge-source-summary').innerHTML = `
    <div><strong>${source.name}</strong></div>
    <div style="font-size:0.9rem; color:var(--text-secondary);">UPI IDs: ${source.upis || 'None'}</div>
    <div style="font-size:0.9rem; color:var(--text-secondary);">Aliases: ${source.aliases || 'None'}</div>
  `;

  document.getElementById('merge-modal').classList.add('active');
}

function closeMergeModal() {
  document.getElementById('merge-modal').classList.remove('active');
}

function confirmMergeSupporter() {
  const sourceId = document.getElementById('merge-source-person-id').value;
  const targetId = document.getElementById('merge-target-person').value;
  if (!sourceId || !targetId || sourceId === targetId) {
    alert('Select a different supporter to merge into.');
    return;
  }

  const source = people.find((p) => p.id === sourceId);
  const target = people.find((p) => p.id === targetId);
  if (!source || !target) return;

  // perform server-side merge
  (async () => {
    const updated = await apiMergePerson(sourceId, targetId);
    closeMergeModal();
    if (updated) {
      await hydrateFromApi();
      matchAllTransactions();
      renderPeople();
      renderTransactions();
    } else {
      mergeSupporterRecords(source, target);
      saveData();
      renderPeople();
      matchAllTransactions();
      alert('Merge completed locally; failed to persist to server.');
    }
  })();
}

function mergeSupporterRecords(source, target) {
  const previousTarget = {
    upis: target.upis || '',
    aliases: target.aliases || ''
  };

  target.upis = mergeCommaValues(target.upis, source.upis);
  target.aliases = mergeCommaValues(target.aliases, source.aliases || source.name);
  if (!target.bnktrn_id && source.bnktrn_id) {
    target.bnktrn_id = source.bnktrn_id;
  }
  if (!target.agent && source.agent) {
    target.agent = source.agent;
  }
  if (!target.type && source.type) {
    target.type = source.type;
  }
  if (source.name && normalizeLookupKey(source.name) !== normalizeLookupKey(target.name)) {
    addSupporterValue(target, 'aliases', source.name);
  }

  transactions.forEach((tx) => {
    if (tx.matchedPersonId === source.id) {
      tx.matchedPersonId = target.id;
      tx.matchedPersonName = target.name;
      tx.assignedAgent = target.agent;
      tx.status = 'Matched';
    }
  });

  const sourceIndex = people.findIndex((p) => p.id === source.id);
  if (sourceIndex !== -1) {
    people.splice(sourceIndex, 1);
  }

  recordSupporterAudit('SUPPORTER_MERGE', target, {
    mergedFrom: source.id,
    previousTarget,
    sourceValues: {
      name: source.name,
      upis: source.upis || '',
      aliases: source.aliases || ''
    }
  });
}

// -------------------------------------------------------------
// CSV Operations: Import & Export
// -------------------------------------------------------------

function handleCSVUpload(e) {
  if (!requireWriteAccess()) return;
  const file = e.target.files[0];
  if (!file) return;

  const fileName = file.name.toLowerCase();
  
  if (fileName.endsWith('.xls') || fileName.endsWith('.xlsx')) {
    handleExcelUpload(file);
  } else {
    handleCSVFileUpload(file);
  }
}

function handleCSVFileUpload(file) {
  const reader = new FileReader();
  reader.onload = function (evt) {
    const text = evt.target.result;
    parseAndLoadTransactionsFromCSV(text);
  };
  reader.readAsText(file);
}

function handleExcelUpload(file) {
  // Check if XLSX library is available
  if (typeof XLSX === 'undefined') {
    console.error('XLSX library not loaded. Attempting to reload...');
    alert('Excel processing library is loading. Please try again in a moment.');
    location.reload();
    return;
  }

  const reader = new FileReader();
  reader.onerror = function () {
    console.error('FileReader error:', reader.error);
    alert('Failed to read the file. Please try again.');
  };
  reader.onload = function (evt) {
    try {
      const data = new Uint8Array(evt.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      
      if (!workbook || !workbook.SheetNames || workbook.SheetNames.length === 0) {
        alert('Error: Excel file is empty or invalid.');
        return;
      }

      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

      console.log(`Total rows in Excel: ${rawData.length}`);

      if (rawData.length <= 29) {
        alert('Error: The file does not have enough rows to process. Expected at least 30 rows.');
        return;
      }

      // Skip top 20 and bottom 9 rows
      const slicedData = rawData.slice(20, rawData.length - 9);

      if (slicedData.length === 0) {
        alert('Error: No data found after skipping rows.');
        return;
      }

      // Identify desired columns
      const headerRow = slicedData[0] || [];
      console.log('Header row:', headerRow);

      const desiredColumns = [
        'Date',
        'Particulars',
        'Tran Type',
        'Tran ID',
        'Cheque Details',
        'Withdrawals',
        'Deposits'
      ];

      // Match header columns case-insensitively and preserve the matched column labels
      const targetMatchings = [];
      const headerLower = headerRow.map(h => (h === null || h === undefined) ? '' : String(h).trim().toLowerCase());

      desiredColumns.forEach(targetCol => {
        const targetLower = targetCol.toLowerCase();
        const index = headerLower.findIndex(h => h === targetLower || h.includes(targetLower));
        if (index !== -1) {
          targetMatchings.push({ label: targetCol, index });
          console.log(`Found column "${targetCol}" at index ${index}`);
        } else {
          console.warn(`Warning: Column "${targetCol}" not found in header row`);
        }
      });

      if (targetMatchings.length === 0) {
        alert('Error: None of the required columns found in the Excel file. Check column headers.');
        return;
      }

      // Extract only the matched columns (skip header row, start from index 1)
      const filteredData = slicedData.slice(1).map(row => {
        return targetMatchings.map(m => row[m.index] !== undefined ? row[m.index] : '');
      });

      console.log(`Extracted ${filteredData.length} data rows`);
      importExcelRows(filteredData, targetMatchings);
    } catch (error) {
      console.error('Error parsing Excel file:', error);
      console.error('Stack:', error.stack);
      alert(`Failed to parse Excel file: ${error.message}`);
    }
  };
  reader.readAsArrayBuffer(file);
}

function parseAndLoadTransactionsFromCSV(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return;

  // Identify Headers and support quoted CSV fields
  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());

  const dateIdx = headers.findIndex(h => h.includes('date'));
  const descIdx = headers.findIndex(h => h.includes('particular'));
  const typeIdx = headers.findIndex(h => h === 'tran type' || h.includes('type'));
  const idIdx = headers.findIndex(h => h.includes('tran id'));
  const withdrawIdx = headers.findIndex(h => h.includes('withdraw'));
  const depositIdx = headers.findIndex(h => h.includes('deposit'));
  const amtIdx = headers.findIndex(h => h.includes('amt') || h.includes('amount') || h.includes('value'));

  const newTxList = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;

    const columns = parseCSVLine(lines[i]);

    const dateVal = dateIdx !== -1 && columns[dateIdx]
      ? normalizeDateValue(columns[dateIdx])
      : normalizeDateValue(new Date());

    const descVal = descIdx !== -1 && columns[descIdx]
      ? columns[descIdx]
      : 'Unknown UPI transaction';

    const refVal = idIdx !== -1 && columns[idIdx] ? columns[idIdx].trim() : '';

    const withdrawRaw = withdrawIdx !== -1 && columns[withdrawIdx] ? columns[withdrawIdx] : '';
    const depositRaw = depositIdx !== -1 && columns[depositIdx] ? columns[depositIdx] : '';
    const genericAmtRaw = amtIdx !== -1 && columns[amtIdx] ? columns[amtIdx] : '';

    const parseAmount = (value) => {
      const normalized = (value || '').toString().trim().replace(/[^\d.\-]/g, '');
      return parseFloat(normalized) || 0;
    };

    let amtVal = 0;
    const depositVal = parseAmount(depositRaw);
    const withdrawVal = parseAmount(withdrawRaw);

    if (depositIdx !== -1 && depositVal !== 0) {
      amtVal = depositVal;
    } else if (withdrawIdx !== -1 && withdrawVal !== 0) {
      amtVal = -Math.abs(withdrawVal);
    } else {
      amtVal = parseAmount(genericAmtRaw);
    }

    const rawType = typeIdx !== -1 && columns[typeIdx] ? columns[typeIdx] : '';
    const typeVal = normalizeTransactionType(rawType, descVal);

    newTxList.push({
      date: dateVal,
      description: descVal,
      amount: amtVal,
      type: typeVal,
      ref: refVal,
      transactionTypes: inferTransactionTypeCategories(rawType, descVal)
    });
  }

  if (newTxList.length > 0) {
    importTransactionsList(newTxList);
  }
}

function importTransactionsList(newTxList) {
  if (newTxList.length === 0) return;

  (async () => {
    // Auto-match before creating
    newTxList.forEach((tx) => {
      tx.extractedUpi = extractUPIIdentifier(tx.description);
      const match = findDatabaseMatch(tx.extractedUpi, tx.ref || tx.tran_id, tx.description);
      if (match) {
        tx.matchedPersonId = match.id;
        tx.matchedPersonName = match.name;
        tx.assignedAgent = match.agent;
        tx.type = match.type || tx.type || "Charity";
        tx.status = "Matched";
      } else {
        tx.status = "Unmatched";
      }
    });

    const created = await apiCreateTransactions(newTxList);
    if (created && created.length > 0) {
      await hydrateFromApi();
    } else {
      alert("Failed to import transactions to server.");
    }
  })();
}

function importExcelRows(filteredData, targetMatchings) {
  const columnIndex = {};
  targetMatchings.forEach((match, idx) => {
    columnIndex[match.label.toLowerCase()] = idx;
  });

  const parseAmount = (value) => {
    const normalized = (value || '').toString().trim().replace(/[^\d.\-]/g, '');
    return parseFloat(normalized) || 0;
  };

  const newTxList = filteredData.map((row) => {
    const dateVal = columnIndex['date'] !== undefined && row[columnIndex['date']] ? normalizeDateValue(row[columnIndex['date']]) : normalizeDateValue(new Date());
    const descVal = columnIndex['particulars'] !== undefined && row[columnIndex['particulars']] ? String(row[columnIndex['particulars']]).trim() : 'Unknown UPI transaction';
    const refVal = columnIndex['tran id'] !== undefined && row[columnIndex['tran id']] ? String(row[columnIndex['tran id']]).trim() : '';
    const withdrawRaw = columnIndex['withdrawals'] !== undefined && row[columnIndex['withdrawals']] ? row[columnIndex['withdrawals']] : '';
    const depositRaw = columnIndex['deposits'] !== undefined && row[columnIndex['deposits']] ? row[columnIndex['deposits']] : '';
    const genericAmtRaw = '';
    const depositVal = parseAmount(depositRaw);
    const withdrawVal = parseAmount(withdrawRaw);

    let amtVal = 0;
    if (depositRaw && depositVal !== 0) {
      amtVal = depositVal;
    } else if (withdrawRaw && withdrawVal !== 0) {
      amtVal = -Math.abs(withdrawVal);
    } else {
      amtVal = parseAmount(genericAmtRaw);
    }

    const rawType = columnIndex['tran type'] !== undefined && row[columnIndex['tran type']] ? String(row[columnIndex['tran type']]).trim() : '';
    const typeVal = normalizeTransactionType(rawType, descVal);

    return {
      date: dateVal,
      description: descVal,
      amount: amtVal,
      type: typeVal,
      ref: refVal,
      transactionTypes: inferTransactionTypeCategories(rawType, descVal)
    };
  });

  importTransactionsList(newTxList);
}

function normalizeTransactionType(rawType, description) {
  const typeText = (rawType || '').toString().trim().toLowerCase();
  const descText = (description || '').toString().trim().toLowerCase();

  const subscriptionPattern = /sub|renew|recurr|membership|installment|monthly|annual|cycle|subscription|subscr/;
  const charityPattern = /donat|charit|gift|support|contribut|ngo|campaign|sponsor|volunt|fund/;

  if (typeText) {
    if (subscriptionPattern.test(typeText)) {
      return 'Subscription';
    }
    if (charityPattern.test(typeText)) {
      return 'Charity';
    }
    if (/credit|deposit/.test(typeText)) {
      return 'Charity';
    }
    if (/debit|withdraw/.test(typeText)) {
      return 'Charity';
    }
    return String(rawType).trim();
  }

  // No type label: infer from description
  if (subscriptionPattern.test(descText)) {
    return 'Subscription';
  }
  if (charityPattern.test(descText)) {
    return 'Charity';
  }

  return 'Charity';
}

function inferTransactionTypeCategories(rawType, description) {
  const typeText = (rawType || '').toString().trim().toLowerCase();
  const descText = (description || '').toString().trim().toLowerCase();

  const subscriptionPattern = /sub|renew|recurr|membership|installment|monthly|annual|cycle|subscription|subscr/;
  const charityPattern = /donat|charit|gift|support|contribut|ngo|campaign|sponsor|volunt|fund/;

  if (typeText && subscriptionPattern.test(typeText)) {
    return ['Subscription'];
  }

  if (typeText && charityPattern.test(typeText)) {
    return ['Charity'];
  }

  if (descText && subscriptionPattern.test(descText)) {
    return ['Subscription'];
  }

  if (descText && charityPattern.test(descText)) {
    return ['Charity'];
  }

  return [];
}

function sanitizeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function splitAtomicTransactionTypes(value) {
  if (!value) return [];
  return String(value)
    .split(/[\|,;\/&]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((unique, part) => {
      const normalized = part.replace(/\s+/g, ' ');
      if (!unique.includes(normalized)) unique.push(normalized);
      return unique;
    }, []);
}

function escapeJsString(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function getTransactionTypeOptions() {
  const excluded = new Set(['cash', 'clg', 'ib', 'imps', 'mb', 'neft', 'sbint', 'tfr', 'upi']);
  const typeSet = new Set();

  if (typeof SEED_DATABASE !== 'undefined' && Array.isArray(SEED_DATABASE.trnTypes)) {
    SEED_DATABASE.trnTypes.forEach((item) => {
      const name = (item && item.name ? item.name : '').trim();
      splitAtomicTransactionTypes(name).forEach((atomic) => {
        if (atomic && !excluded.has(atomic.toLowerCase())) {
          typeSet.add(atomic);
        }
      });
    });
  }

  transactions.forEach((tx) => {
    const label = (tx.trnTypeName || tx.type || '').trim();
    splitAtomicTransactionTypes(label).forEach((atomic) => {
      if (atomic && !excluded.has(atomic.toLowerCase())) {
        typeSet.add(atomic);
      }
    });

    if (Array.isArray(tx.transactionTypes)) {
      tx.transactionTypes.flatMap(splitAtomicTransactionTypes).forEach((atomic) => {
        if (atomic && !excluded.has(atomic.toLowerCase())) {
          typeSet.add(atomic);
        }
      });
    }
  });

  return Array.from(typeSet).sort((a, b) => a.localeCompare(b));
}

function renderTransactionTypesCell(tx, txIndex) {
  const options = getTransactionTypeOptions();
  const selectedTypes = Array.isArray(tx.transactionTypes)
    ? tx.transactionTypes.flatMap(splitAtomicTransactionTypes).filter((value, idx, all) => value && all.indexOf(value) === idx)
    : [];
  const selectedHTML = selectedTypes.length > 0
    ? selectedTypes.map((value) => `<span class="type-chip">${sanitizeHtml(value)}</span>`).join(' ')
    : '<span class="type-chip placeholder">Select...</span>';
  const optionsHTML = options.map((option) => {
    const safeOption = escapeJsString(option);
    const checked = selectedTypes.includes(option) ? 'checked' : '';
    return `<label class="transaction-type-option"><input type="checkbox" onchange="handleTransactionTypeToggle(${txIndex}, '${safeOption}', this.checked)" ${checked}> ${sanitizeHtml(option)}</label>`;
  }).join('');

  return `
    <div class="transaction-types-wrapper" onclick="toggleTransactionTypeDropdown(event, ${txIndex})">
      <div class="transaction-type-tags">${selectedHTML}</div>
      <span class="transaction-types-caret">▾</span>
    </div>
    <div class="transaction-types-panel" id="transaction-types-panel-${txIndex}" onclick="event.stopPropagation()">
      ${optionsHTML || '<div class="transaction-type-empty">No available types</div>'}
    </div>
  `;
}

function handleTransactionTypeToggle(txIndex, typeValue, checked) {
  const tx = transactions[txIndex];
  if (!tx) return;
  tx.transactionTypes = Array.isArray(tx.transactionTypes) ? [...tx.transactionTypes] : [];

  if (checked) {
    if (!tx.transactionTypes.includes(typeValue)) {
      tx.transactionTypes.push(typeValue);
    }
  } else {
    tx.transactionTypes = tx.transactionTypes.filter((value) => value !== typeValue);
  }

  renderTransactions();
  
  (async () => {
    const txId = tx && (tx.tran_id || tx.ref || tx.source_id);
    if (txId) {
      const ok = await apiUpdateTransaction(txId, { transactionTypes: tx.transactionTypes });
      if (ok) await hydrateFromApi();
    } else {
      saveData();
    }
  })();
}

function toggleTransactionTypeDropdown(event, txIndex) {
  event.stopPropagation();
  closeTransactionTypeDropdowns();
  const panel = document.getElementById(`transaction-types-panel-${txIndex}`);
  if (!panel) return;
  panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
}

function closeTransactionTypeDropdowns() {
  document.querySelectorAll('.transaction-types-panel').forEach((panel) => {
    panel.style.display = 'none';
  });
}

document.addEventListener('click', closeTransactionTypeDropdowns);

// Simple CSV line parser taking care of quotes
function parseCSVLine(text) {
  let p = '', c = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    let char = text.charAt(i);
    if (char === '"') {
      q = !q;
    } else if (char === ',' && !q) {
      c.push(p.trim());
      p = '';
    } else {
      p += char;
    }
  }
  c.push(p.trim());
  return c;
}

// Export parsed Excel matched spreadsheet as fully standard CSV download
function exportToCSV() {
  if (transactions.length === 0) {
    alert("Nothing to export yet!");
    return;
  }

  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Date,Raw Transaction Log,Extracted UPI,Type,Amount (INR),Matched Person,Assigned Agent,Status\r\n";

  transactions.forEach(tx => {
    const rawDesc = tx.description ? tx.description.replace(/"/g, '""') : '';
    const dateVal = tx.date || '';
    const extUpi = tx.extractedUpi || '';
    const typeVal = tx.type || '';
    const amountVal = tx.amount || 0;
    const nameVal = tx.matchedPersonName ? tx.matchedPersonName.replace(/"/g, '""') : '';
    const agentVal = tx.assignedAgent || '';
    const statusVal = tx.status || '';

    csvContent += `"${dateVal}","${rawDesc}","${extUpi}","${typeVal}",${amountVal},"${nameVal}","${agentVal}","${statusVal}"\r\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `matched_charity_ledger_${new Date().toISOString().split('T')[0]}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// -------------------------------------------------------------
// Live Statistics Summary Panel
// -------------------------------------------------------------

function updateStats() {
  const totalCount = transactions.length;
  const matchedCount = transactions.filter(t => t.status === 'Matched').length;
  const unmatchedCount = totalCount - matchedCount;

  const totalCharity = transactions
    .filter(t => (t.trnTypeName || t.type || '').toLowerCase().includes('donation'))
    .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

  const totalSub = transactions
    .filter(t => (t.trnTypeName || t.type || '').toLowerCase().includes('subscription'))
    .reduce((sum, t) => sum + parseFloat(t.amount || 0), 0);

  document.getElementById('stat-total').innerText = totalCount;
  document.getElementById('stat-matched').innerText = matchedCount;
  document.getElementById('stat-unmatched').innerText = unmatchedCount;

  // Format to standard Indian Rupee presentation (e.g. ₹ 1,500.00)
  document.getElementById('stat-charity-val').innerText = '₹ ' + totalCharity.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.getElementById('stat-sub-val').innerText = '₹ ' + totalSub.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}