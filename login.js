const AUTH_TOKEN_KEY = 'charity_auth_token';
let authConfig = null;
let msalApp = null;

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showEl(id, visible) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('auth-hidden', !visible);
}

async function loadAuthConfig() {
  try {
    const response = await fetch('/api/auth/config', { method: 'GET' });
    if (!response.ok) {
      return {
        entraEnabled: false,
        allowLocalLogin: true
      };
    }
    return await response.json();
  } catch (_err) {
    return {
      entraEnabled: false,
      allowLocalLogin: true
    };
  }
}

function createMsalApp(config) {
  if (!window.msal || !config || !config.spaClientId || !config.authority) return null;
  return new window.msal.PublicClientApplication({
    auth: {
      clientId: config.spaClientId,
      authority: config.authority,
      redirectUri: `${window.location.origin}/login`,
      navigateToLoginRequestUrl: false
    },
    cache: {
      cacheLocation: 'localStorage',
      storeAuthStateInCookie: false
    }
  });
}

async function acquireEntraToken() {
  if (!msalApp || !authConfig || !authConfig.apiScope) {
    throw new Error('Microsoft sign-in is not configured for this environment');
  }

  const loginRequest = {
    scopes: [authConfig.apiScope]
  };

  const result = await msalApp.loginPopup(loginRequest);
  const account = result.account || (msalApp.getAllAccounts && msalApp.getAllAccounts()[0]) || null;
  if (!account) {
    throw new Error('Microsoft sign-in did not return an account');
  }

  const tokenResult = await msalApp.acquireTokenSilent({
    ...loginRequest,
    account
  }).catch(() => msalApp.acquireTokenPopup({ ...loginRequest, account }));

  if (!tokenResult || !tokenResult.accessToken) {
    throw new Error('Microsoft sign-in did not return an access token');
  }

  localStorage.setItem(AUTH_TOKEN_KEY, tokenResult.accessToken);
}

async function tryAutoLogin() {
  const token = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  if (!token) return;

  try {
    const response = await fetch('/api/auth/me', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      }
    });

    if (response.ok) {
      window.location.href = '/app';
      return;
    }
  } catch (_err) {
    // Continue to manual login form.
  }

  localStorage.removeItem(AUTH_TOKEN_KEY);
}

async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username, password })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && payload.error ? payload.error : 'Login failed';
    throw new Error(message);
  }

  if (!payload.token) {
    throw new Error('Authentication token was not returned');
  }

  localStorage.setItem(AUTH_TOKEN_KEY, payload.token);
}

async function submitEntraLogin() {
  const errorEl = document.getElementById('login-error');
  const loginBtn = document.getElementById('entra-login-btn');
  if (errorEl) errorEl.textContent = '';
  if (loginBtn) {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';
  }

  try {
    await acquireEntraToken();
    window.location.href = '/app';
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || 'Microsoft sign-in failed. Please try again.';
    }
  } finally {
    if (loginBtn) {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Continue with Microsoft';
    }
  }
}

function initLoginForm() {
  const form = document.getElementById('login-form');
  const loginBtn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');

  if (!form || !loginBtn || !errorEl) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';

    const formData = new FormData(form);
    const username = String(formData.get('username') || '').trim();
    const password = String(formData.get('password') || '').trim();

    if (!username || !password) {
      errorEl.textContent = 'Username and password are required.';
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in...';

    try {
      await login(username, password);
      window.location.href = '/app';
    } catch (err) {
      errorEl.textContent = err.message || 'Login failed. Please try again.';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
  });
}

function initEntraButton() {
  const button = document.getElementById('entra-login-btn');
  if (!button) return;
  button.addEventListener('click', submitEntraLogin);
}

async function configureAuthUi() {
  authConfig = await loadAuthConfig();
  msalApp = createMsalApp(authConfig);

  const hasEntra = Boolean(authConfig && authConfig.entraEnabled && msalApp);
  const allowLocal = Boolean(authConfig && authConfig.allowLocalLogin);

  showEl('entra-card', hasEntra);
  showEl('local-divider', hasEntra && allowLocal);
  showEl('login-form', allowLocal || !hasEntra);

  const statusEl = document.getElementById('entra-status');
  if (statusEl) {
    statusEl.textContent = hasEntra
      ? 'Your organization controls sign-in, MFA, and password policies.'
      : 'Local sign-in is available for development and fallback use.';
  }

  if (!allowLocal && !hasEntra) {
    setText('login-error', 'Authentication is not configured on this server.');
  }
}

(async function init() {
  await configureAuthUi();
  await tryAutoLogin();
  initLoginForm();
  initEntraButton();
})();
