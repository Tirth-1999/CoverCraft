// CoverCraft Background Service Worker v3

importScripts('../config.defaults.js', '../portfolio.defaults.js', '../firebase.defaults.js', '../shared/core.js');

try { importScripts('../config.js'); } catch (_) {}
try { importScripts('../portfolio.js'); } catch (_) {}
try { importScripts('../firebase.js'); } catch (_) {}

var Core = CoverCraftCore;
var STORAGE_KEYS = Core.STORAGE_KEYS;
var DEFAULT_MODEL = 'openrouter/free';
var VISION_MODEL = 'google/gemma-3-12b-it:free';
var FAST_EXTRACT_MODEL = 'google/gemma-3-12b-it:free';
var FAST_GROQ_EXTRACT_MODEL = 'groq/llama-3.1-8b-instant';
var ALLOWED_FREE_MODELS = [
  'openrouter/free',
  'google/gemma-3-12b-it:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m2.5:free'
];
var GROQ_MODELS = [
  'groq/llama-3.1-8b-instant',
  'groq/llama-3.3-70b-versatile',
  'groq/meta-llama/llama-4-scout-17b-16e-instruct',
  'groq/moonshotai/kimi-k2-instruct',
  'groq/moonshotai/kimi-k2-instruct-0905',
  'groq/openai/gpt-oss-120b',
  'groq/openai/gpt-oss-20b',
  'groq/qwen/qwen3-32b'
];
var DISABLED_MODELS = [
  'groq/compound',
  'groq/compound-mini'
];
var MAX_LEGACY_LOGS = 200;
var mutationQueue = Promise.resolve();
var CLOUD_AUTH_STORAGE_KEY = 'covercraft_cloud_auth_v1';
var CLOUD_META_STORAGE_KEY = 'covercraft_cloud_meta_v1';
var CLOUD_AUTH_FLOW_STORAGE_KEY = 'covercraft_cloud_auth_flow_v1';
var GUEST_SESSIONS_BACKUP_KEY = 'covercraft_guest_sessions_backup_v1';
var GUEST_PORTFOLIO_BACKUP_KEY = 'covercraft_guest_portfolio_backup_v1';
var FIREBASE_CONFIG = typeof COVERCRAFT_FIREBASE === 'object' && COVERCRAFT_FIREBASE ? COVERCRAFT_FIREBASE : {};

var DEFAULT_SETTINGS = {
  openrouterKey: COVERCRAFT_CONFIG && COVERCRAFT_CONFIG.openrouterKey || '',
  groqKey: COVERCRAFT_CONFIG && COVERCRAFT_CONFIG.groqKey || '',
  tavilyKey: COVERCRAFT_CONFIG && COVERCRAFT_CONFIG.tavilyKey || '',
  model: DEFAULT_MODEL,
  customModel: '',
  coverLetterType: 'formal',
  triggerMode: 'manual',
  cloudSyncEnabled: true
};

function localGet(keys) {
  return new Promise(function(resolve) {
    chrome.storage.local.get(keys, function(data) {
      resolve(data || {});
    });
  });
}

function localSet(obj) {
  return new Promise(function(resolve) {
    chrome.storage.local.set(obj, function() {
      resolve();
    });
  });
}

function syncGet(keys) {
  return new Promise(function(resolve) {
    chrome.storage.sync.get(keys, function(data) {
      resolve(data || {});
    });
  });
}

function syncSet(obj) {
  return new Promise(function(resolve) {
    chrome.storage.sync.set(obj, function() {
      resolve();
    });
  });
}

function buildTextFileDataUrl(text, mimeType) {
  return 'data:' + (mimeType || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(String(text || ''));
}

function getFirebaseConfig() {
  return {
    apiKey: FIREBASE_CONFIG.apiKey || '',
    authDomain: FIREBASE_CONFIG.authDomain || '',
    projectId: FIREBASE_CONFIG.projectId || '',
    storageBucket: FIREBASE_CONFIG.storageBucket || '',
    messagingSenderId: FIREBASE_CONFIG.messagingSenderId || '',
    appId: FIREBASE_CONFIG.appId || '',
    googleClientId: FIREBASE_CONFIG.googleClientId || ''
  };
}

function hasUsableGoogleClientId(value) {
  var clientId = String(value || '').trim();
  if (!clientId) return false;
  if (clientId === 'PASTE_YOUR_GOOGLE_OAUTH_CLIENT_ID_HERE') return false;
  return /\.apps\.googleusercontent\.com$/i.test(clientId);
}

function isFirebaseConfigured() {
  var config = getFirebaseConfig();
  return !!(config.apiKey && config.projectId && config.authDomain && hasUsableGoogleClientId(config.googleClientId));
}

function localTimeMs(value) {
  var ms = Date.parse(value || '');
  return isNaN(ms) ? 0 : ms;
}

function resolveCloudSyncEnabled(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof fallback === 'boolean') return fallback;
  return DEFAULT_SETTINGS.cloudSyncEnabled;
}

async function getCloudAuthSession() {
  var data = await localGet([CLOUD_AUTH_STORAGE_KEY, CLOUD_META_STORAGE_KEY]);
  return {
    auth: data[CLOUD_AUTH_STORAGE_KEY] || null,
    meta: data[CLOUD_META_STORAGE_KEY] || {}
  };
}

async function saveCloudAuthSession(auth) {
  var payload = {};
  payload[CLOUD_AUTH_STORAGE_KEY] = auth || null;
  await localSet(payload);
}

async function saveCloudMeta(meta) {
  var current = await getCloudAuthSession();
  var payload = {};
  payload[CLOUD_META_STORAGE_KEY] = Object.assign({}, current.meta || {}, meta || {});
  await localSet(payload);
}

async function clearCloudAuthSession() {
  var payload = {};
  payload[CLOUD_AUTH_STORAGE_KEY] = null;
  payload[CLOUD_META_STORAGE_KEY] = Object.assign({}, (await getCloudAuthSession()).meta || {}, {
    lastError: '',
    lastSyncedAt: '',
    signedOutAt: Core.nowIso()
  });
  await localSet(payload);
}

async function getPendingCloudAuthFlow() {
  var data = await localGet([CLOUD_AUTH_FLOW_STORAGE_KEY]);
  return data[CLOUD_AUTH_FLOW_STORAGE_KEY] || null;
}

async function savePendingCloudAuthFlow(flow) {
  var payload = {};
  payload[CLOUD_AUTH_FLOW_STORAGE_KEY] = flow || null;
  await localSet(payload);
}

async function clearPendingCloudAuthFlow() {
  var payload = {};
  payload[CLOUD_AUTH_FLOW_STORAGE_KEY] = null;
  await localSet(payload);
}

function syncableSettings(settings) {
  return {
    model: settings.model || DEFAULT_MODEL,
    coverLetterType: settings.coverLetterType || 'formal',
    triggerMode: settings.triggerMode || 'manual',
    cloudSyncEnabled: resolveCloudSyncEnabled(settings && settings.cloudSyncEnabled)
  };
}

function encodeFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    if (!isFinite(value)) return { nullValue: null };
    if (Math.floor(value) === value) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.length ? value.map(encodeFirestoreValue) : []
      }
    };
  }
  if (typeof value === 'object') {
    var fields = {};
    Object.keys(value).forEach(function(key) {
      if (value[key] === undefined) return;
      fields[key] = encodeFirestoreValue(value[key]);
    });
    return { mapValue: { fields: fields } };
  }
  return { stringValue: String(value) };
}

function encodeFirestoreFields(input) {
  var fields = {};
  Object.keys(input || {}).forEach(function(key) {
    if (input[key] === undefined) return;
    fields[key] = encodeFirestoreValue(input[key]);
  });
  return fields;
}

function decodeFirestoreValue(node) {
  if (!node || typeof node !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(node, 'stringValue')) return node.stringValue;
  if (Object.prototype.hasOwnProperty.call(node, 'booleanValue')) return !!node.booleanValue;
  if (Object.prototype.hasOwnProperty.call(node, 'integerValue')) return Number(node.integerValue || 0);
  if (Object.prototype.hasOwnProperty.call(node, 'doubleValue')) return Number(node.doubleValue || 0);
  if (Object.prototype.hasOwnProperty.call(node, 'nullValue')) return null;
  if (Object.prototype.hasOwnProperty.call(node, 'arrayValue')) {
    var values = node.arrayValue && node.arrayValue.values || [];
    return values.map(decodeFirestoreValue);
  }
  if (Object.prototype.hasOwnProperty.call(node, 'mapValue')) {
    var out = {};
    var fields = node.mapValue && node.mapValue.fields || {};
    Object.keys(fields).forEach(function(key) {
      out[key] = decodeFirestoreValue(fields[key]);
    });
    return out;
  }
  return null;
}

function decodeFirestoreDocument(documentData) {
  if (!documentData || !documentData.fields) return null;
  return decodeFirestoreValue({ mapValue: { fields: documentData.fields } }) || {};
}

function firestoreDocumentUrl(path) {
  var config = getFirebaseConfig();
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(config.projectId) + '/databases/(default)/documents/' + path;
}

async function refreshCloudIdToken(auth) {
  var config = getFirebaseConfig();
  if (!auth || !auth.refreshToken) throw new Error('Missing Firebase refresh token.');
  var response = await fetch('https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(config.apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refreshToken)
  });
  var data = await response.json().catch(function() { return {}; });
  if (!response.ok) throw new Error(data.error && data.error.message || data.error_description || 'Could not refresh the Firebase session.');
  var nextAuth = Object.assign({}, auth, {
    idToken: data.id_token || auth.idToken || '',
    refreshToken: data.refresh_token || auth.refreshToken || '',
    expiresAt: new Date(Date.now() + (Number(data.expires_in || 3600) * 1000)).toISOString(),
    uid: data.user_id || auth.uid || '',
    projectId: data.project_id || auth.projectId || getFirebaseConfig().projectId
  });
  await saveCloudAuthSession(nextAuth);
  return nextAuth;
}

async function ensureCloudAuthReady() {
  if (!isFirebaseConfigured()) throw new Error('Firebase is not configured yet.');
  var bundle = await getCloudAuthSession();
  var auth = bundle.auth;
  if (!auth || !auth.idToken) return null;
  if (!auth.expiresAt || (localTimeMs(auth.expiresAt) - Date.now()) < 120000) {
    auth = await refreshCloudIdToken(auth);
  }
  return auth;
}

async function firestoreRequest(method, path, body, auth, query) {
  var tokenAuth = auth || await ensureCloudAuthReady();
  if (!tokenAuth || !tokenAuth.idToken) throw new Error('Sign in with Google to enable CoverCraft cloud sync.');
  var url = firestoreDocumentUrl(path) + (query || '');
  var response = await fetch(url, {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + tokenAuth.idToken,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 404) return null;
  var data = await response.json().catch(function() { return {}; });
  if (!response.ok) {
    throw new Error(data.error && data.error.message || ('Firestore HTTP ' + response.status));
  }
  return data;
}

async function listFirestoreDocuments(path) {
  var auth = await ensureCloudAuthReady();
  var documents = [];
  var pageToken = '';
  do {
    var query = '?pageSize=200';
    if (pageToken) query += '&pageToken=' + encodeURIComponent(pageToken);
    var data = await firestoreRequest('GET', path, null, auth, query);
    var items = data && data.documents || [];
    items.forEach(function(documentData) {
      var decoded = decodeFirestoreDocument(documentData);
      if (decoded) documents.push(decoded);
    });
    pageToken = data && data.nextPageToken || '';
  } while (pageToken);
  return documents;
}

async function patchFirestoreDocument(path, payload) {
  return firestoreRequest('PATCH', path, { fields: encodeFirestoreFields(payload || {}) });
}

async function deleteFirestoreDocument(path) {
  return firestoreRequest('DELETE', path, null);
}

async function mergeRemoteSessionsIntoLocal(remoteSessions) {
  if (!Array.isArray(remoteSessions) || !remoteSessions.length) return;
  var state = await getSessionState();
  remoteSessions.forEach(function(session) {
    if (!session || !session.id) return;
    var existing = state.sessions[session.id];
    if (!existing || localTimeMs(session.updatedAt) >= localTimeMs(existing.updatedAt)) {
      state.sessions[session.id] = session;
    }
  });
  state.order = Object.keys(state.sessions).sort(function(a, b) {
    return localTimeMs(state.sessions[b] && state.sessions[b].updatedAt) - localTimeMs(state.sessions[a] && state.sessions[a].updatedAt);
  });
  await saveSessionState(state);
}

async function mergeRemoteAppStateIntoLocal(remoteState, options) {
  if (!remoteState || typeof remoteState !== 'object') return;
  var opts = options || {};

  if (remoteState.settings && typeof remoteState.settings === 'object') {
    var rawSettings = await syncGet(['model', 'customModel', 'coverLetterType', 'triggerMode', 'cloudSyncEnabled']);
    var nextSettings = {
      model: rawSettings.model || remoteState.settings.model || DEFAULT_MODEL,
      customModel: rawSettings.customModel || '',
      coverLetterType: rawSettings.coverLetterType || remoteState.settings.coverLetterType || 'formal',
      triggerMode: rawSettings.triggerMode || remoteState.settings.triggerMode || 'manual',
      cloudSyncEnabled: resolveCloudSyncEnabled(rawSettings.cloudSyncEnabled, resolveCloudSyncEnabled(remoteState.settings.cloudSyncEnabled))
    };
    await syncSet(nextSettings);
  }

  if (remoteState.portfolio && typeof remoteState.portfolio === 'object') {
    var localPortfolio = await getPortfolioBundle();
    var looksEmpty = !localPortfolio.rawPortfolio || !Object.keys(localPortfolio.rawPortfolio).length || (!localPortfolio.validation.normalized.name && !localPortfolio.validation.normalized.experiences.length);
    if (looksEmpty || opts.forcePortfolioReplace) {
      var portfolioPayload = {};
      portfolioPayload[STORAGE_KEYS.activePortfolio] = remoteState.portfolio;
      portfolioPayload[STORAGE_KEYS.activePortfolioSource] = remoteState.portfolioSource || 'cloud_sync';
      await localSet(portfolioPayload);
    }
  }
}

async function getRemoteCloudState() {
  var auth = await ensureCloudAuthReady();
  if (!auth || !auth.uid) throw new Error('Sign in with Google to enable CoverCraft cloud sync.');
  var appDoc = await firestoreRequest('GET', 'users/' + auth.uid + '/state/main', null, auth);
  var sessions = await listFirestoreDocuments('users/' + auth.uid + '/sessions');
  return {
    app: decodeFirestoreDocument(appDoc),
    sessions: sessions
  };
}

async function syncCloudState(reason) {
  var settings = await loadSettings();
  if (!settings.cloudSyncEnabled) return { ok: true, skipped: 'disabled' };
  var auth = await ensureCloudAuthReady();
  if (!auth || !auth.uid) throw new Error('Sign in with Google to enable cloud sync.');

  var state = await getSessionState();
  var portfolioBundle = await getPortfolioBundle();
  var now = Core.nowIso();

  await patchFirestoreDocument('users/' + auth.uid, {
    uid: auth.uid,
    email: auth.email || '',
    displayName: auth.displayName || '',
    photoURL: auth.photoURL || '',
    lastSeenAt: now
  });

  await patchFirestoreDocument('users/' + auth.uid + '/state/main', {
    settings: syncableSettings(settings),
    portfolio: portfolioBundle.rawPortfolio || {},
    portfolioSource: portfolioBundle.source || 'local_file',
    portfolioVersion: portfolioBundle.version || '',
    updatedAt: now,
    syncReason: reason || 'manual'
  });

  var ids = state.order.slice();
  for (var i = 0; i < ids.length; i++) {
    var session = state.sessions[ids[i]];
    if (!session) continue;
    await patchFirestoreDocument('users/' + auth.uid + '/sessions/' + session.id, Object.assign({}, session, {
      title: Core.sessionTitle(session),
      syncedAt: now
    }));
  }

  var verifiedAppDoc = await firestoreRequest('GET', 'users/' + auth.uid + '/state/main', null, auth);
  var verifiedState = decodeFirestoreDocument(verifiedAppDoc);
  if (!verifiedState || !verifiedState.updatedAt) {
    throw new Error('Cloud sync could not verify the Firestore write. Check whether Firestore Database is enabled for project ' + getFirebaseConfig().projectId + ' and whether the users/{uid} rules are deployed.');
  }

  await saveCloudMeta({
    lastSyncedAt: now,
    lastError: '',
    lastSyncReason: reason || 'manual',
    lastSyncedCount: ids.length,
    lastVerifiedAt: Core.nowIso()
  });
  return { ok: true, syncedAt: now, count: ids.length };
}

async function clearCloudSessions() {
  var auth = await ensureCloudAuthReady();
  if (!auth || !auth.uid) return;
  var remoteSessions = await listFirestoreDocuments('users/' + auth.uid + '/sessions');
  for (var i = 0; i < remoteSessions.length; i++) {
    if (remoteSessions[i] && remoteSessions[i].id) {
      await deleteFirestoreDocument('users/' + auth.uid + '/sessions/' + remoteSessions[i].id);
    }
  }
  await patchFirestoreDocument('users/' + auth.uid + '/state/main', {
    updatedAt: Core.nowIso(),
    settings: syncableSettings(await loadSettings())
  });
}

async function maybeSyncCloud(reason) {
  try {
    return await syncCloudState(reason);
  } catch (err) {
    await saveCloudMeta({ lastError: err.message || 'Cloud sync failed.' });
    return { ok: false, error: err.message };
  }
}

function randomUrlSafe(bytes) {
  var array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  var text = '';
  for (var i = 0; i < array.length; i++) text += String.fromCharCode(array[i]);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildGoogleOAuthUrl(config, redirectUrl, state, nonce) {
  var url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.googleClientId);
  url.searchParams.set('redirect_uri', redirectUrl);
  url.searchParams.set('response_type', 'id_token');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return url.toString();
}

function parseOAuthResultUrl(resultUrl) {
  if (!resultUrl) return {};
  var url = new URL(resultUrl);
  var hash = String(url.hash || '').replace(/^#/, '');
  return Object.fromEntries(new URLSearchParams(hash).entries());
}

function parseJsonSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function launchWebAuthFlow(details) {
  return new Promise(function(resolve, reject) {
    chrome.identity.launchWebAuthFlow(details, function(resultUrl) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Google sign-in failed.'));
        return;
      }
      resolve(resultUrl || '');
    });
  });
}

async function launchGoogleIdTokenFlow(config) {
  if (!chrome.identity || typeof chrome.identity.getRedirectURL !== 'function' || typeof chrome.identity.launchWebAuthFlow !== 'function') {
    throw new Error('Chrome identity API is not available.');
  }
  if (!hasUsableGoogleClientId(config.googleClientId)) {
    throw new Error('Firebase auth config is incomplete. Add the real Google OAuth client ID to src/firebase.js for the extension OAuth flow.');
  }
  var redirectUrl = chrome.identity.getRedirectURL('firebase');
  var state = randomUrlSafe(24);
  var nonce = randomUrlSafe(24);
  var authUrl = buildGoogleOAuthUrl(config, redirectUrl, state, nonce);
  var resultUrl = await launchWebAuthFlow({
    url: authUrl,
    interactive: true
  });
  var result = parseOAuthResultUrl(resultUrl);
  if (result.error) throw new Error(result.error_description || result.error || 'Google sign-in failed.');
  if (!result.id_token) throw new Error('Google sign-in did not return an ID token.');
  if (result.state !== state) throw new Error('Google sign-in state verification failed.');
  return {
    idToken: result.id_token,
    redirectUrl: redirectUrl
  };
}

async function exchangeGoogleIdTokenForFirebase(config, googleAuth) {
  var requestUri = googleAuth && googleAuth.redirectUrl || 'https://covercraft.extension';
  var response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=' + encodeURIComponent(config.apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: 'id_token=' + encodeURIComponent(googleAuth.idToken) + '&providerId=google.com',
      requestUri: requestUri,
      returnSecureToken: true,
      returnIdpCredential: true
    })
  });
  var data = await response.json().catch(function() { return {}; });
  if (!response.ok) {
    throw new Error(data.error && data.error.message || 'Firebase sign-in failed.');
  }
  return data;
}

function buildFirebaseAuthFromGoogleResponse(data) {
  var raw = parseJsonSafe(data && data.rawUserInfo || '', {});
  return {
    uid: data.localId || '',
    email: data.email || raw.email || '',
    displayName: data.displayName || raw.name || '',
    photoURL: data.photoUrl || raw.picture || '',
    idToken: data.idToken || '',
    refreshToken: data.refreshToken || '',
    expiresAt: new Date(Date.now() + (Number(data.expiresIn || 3600) * 1000)).toISOString(),
    providerId: 'google.com'
  };
}

async function signInToCloudWithGoogle() {
  var config = getFirebaseConfig();
  var googleAuth = await launchGoogleIdTokenFlow(config);
  var firebaseAuth = await exchangeGoogleIdTokenForFirebase(config, googleAuth);
  return buildFirebaseAuthFromGoogleResponse(firebaseAuth);
}

async function finalizeFirebaseAuth(response) {
  if (!response || !response.ok || !response.auth) {
    throw new Error(response && response.error || 'Google sign-in failed.');
  }
  var config = getFirebaseConfig();
  var auth = Object.assign({}, response.auth, { projectId: config.projectId });
  await saveCloudAuthSession(auth);
  await saveCloudMeta({ lastError: '', signedInAt: Core.nowIso() });
  return auth;
}

async function getCloudStatus() {
  var settings = await loadSettings();
  var bundle = await getCloudAuthSession();
  var flow = await getPendingCloudAuthFlow();
  var auth = bundle.auth;
  var meta = bundle.meta || {};
  return {
    configured: isFirebaseConfigured(),
    signedIn: !!(auth && auth.uid),
    user: auth ? {
      uid: auth.uid || '',
      email: auth.email || '',
      displayName: auth.displayName || '',
      photoURL: auth.photoURL || '',
      expiresAt: auth.expiresAt || ''
    } : null,
    enabled: !!settings.cloudSyncEnabled,
    lastSyncedAt: meta.lastSyncedAt || '',
    lastError: meta.lastError || '',
    authInProgress: !!flow
  };
}

async function loadSettings() {
  var data = await syncGet(['openrouterKey', 'groqKey', 'tavilyKey', 'model', 'customModel', 'coverLetterType', 'triggerMode', 'cloudSyncEnabled']);
  var model = data.model === 'custom' && data.customModel ? data.customModel : (data.model || DEFAULT_SETTINGS.model);
  if (DISABLED_MODELS.indexOf(model) !== -1) model = DEFAULT_SETTINGS.model;
  if (data.model !== 'custom' && ALLOWED_FREE_MODELS.indexOf(model) === -1 && GROQ_MODELS.indexOf(model) === -1) model = DEFAULT_SETTINGS.model;
  return {
    openrouterKey: data.openrouterKey || DEFAULT_SETTINGS.openrouterKey,
    groqKey: data.groqKey || DEFAULT_SETTINGS.groqKey,
    tavilyKey: data.tavilyKey || DEFAULT_SETTINGS.tavilyKey,
    model: model,
    customModel: data.customModel || '',
    coverLetterType: data.coverLetterType || DEFAULT_SETTINGS.coverLetterType,
    triggerMode: data.triggerMode || DEFAULT_SETTINGS.triggerMode,
    cloudSyncEnabled: resolveCloudSyncEnabled(data.cloudSyncEnabled)
  };
}

async function getPortfolioBundle() {
  var data = await localGet([STORAGE_KEYS.activePortfolio, STORAGE_KEYS.activePortfolioSource]);
  var source = data[STORAGE_KEYS.activePortfolioSource] || 'local_file';
  var rawPortfolio = data[STORAGE_KEYS.activePortfolio] || PORTFOLIO || {};
  var validation = Core.normalizePortfolio(rawPortfolio);
  return {
    portfolio: validation.normalized,
    rawPortfolio: rawPortfolio,
    validation: validation,
    source: source,
    owner: Core.ownerSnapshot(validation.normalized),
    version: Core.portfolioFingerprint(validation.normalized)
  };
}

async function getSessionState() {
  await migrateLegacyLogsIfNeeded();
  var data = await localGet([STORAGE_KEYS.sessions, STORAGE_KEYS.sessionOrder]);
  return {
    sessions: data[STORAGE_KEYS.sessions] || {},
    order: data[STORAGE_KEYS.sessionOrder] || []
  };
}

function saveSessionState(state) {
  var payload = {};
  payload[STORAGE_KEYS.sessions] = state.sessions;
  payload[STORAGE_KEYS.sessionOrder] = state.order;
  return localSet(payload);
}

async function replaceLocalSessionState(nextSessions) {
  var normalizedSessions = {};
  (Array.isArray(nextSessions) ? nextSessions : []).forEach(function(session) {
    if (!session || !session.id) return;
    normalizedSessions[session.id] = session;
  });
  var nextOrder = Object.keys(normalizedSessions).sort(function(a, b) {
    return localTimeMs(normalizedSessions[b] && normalizedSessions[b].updatedAt) - localTimeMs(normalizedSessions[a] && normalizedSessions[a].updatedAt);
  });
  await saveSessionState({
    sessions: normalizedSessions,
    order: nextOrder
  });
}

async function backupGuestLocalState() {
  var state = await getSessionState();
  var portfolioBundle = await getPortfolioBundle();
  var payload = {};
  payload[GUEST_SESSIONS_BACKUP_KEY] = {
    sessions: state.sessions || {},
    order: state.order || []
  };
  payload[GUEST_PORTFOLIO_BACKUP_KEY] = {
    portfolio: portfolioBundle.rawPortfolio || {},
    source: portfolioBundle.source || 'local_file'
  };
  await localSet(payload);
}

async function restoreGuestLocalState() {
  var data = await localGet([GUEST_SESSIONS_BACKUP_KEY, GUEST_PORTFOLIO_BACKUP_KEY]);
  var sessionBackup = data[GUEST_SESSIONS_BACKUP_KEY] || null;
  var portfolioBackup = data[GUEST_PORTFOLIO_BACKUP_KEY] || null;
  var payload = {};
  payload[STORAGE_KEYS.sessions] = sessionBackup && sessionBackup.sessions ? sessionBackup.sessions : {};
  payload[STORAGE_KEYS.sessionOrder] = sessionBackup && sessionBackup.order ? sessionBackup.order : [];
  if (portfolioBackup) {
    payload[STORAGE_KEYS.activePortfolio] = portfolioBackup.portfolio || {};
    payload[STORAGE_KEYS.activePortfolioSource] = portfolioBackup.source || 'local_file';
  }
  payload[GUEST_SESSIONS_BACKUP_KEY] = null;
  payload[GUEST_PORTFOLIO_BACKUP_KEY] = null;
  await localSet(payload);
}

function queueMutation(work) {
  var next = mutationQueue.then(function() {
    return work();
  });
  mutationQueue = next.catch(function(err) {
    console.error('[CoverCraft]', err);
  });
  return next;
}

function moveIdToFront(order, id) {
  var next = order.filter(function(existingId) { return existingId !== id; });
  next.unshift(id);
  return next;
}

function getLatestSessionForUrl(state, pageUrl) {
  var normalizedUrl = Core.normalizeUrl(pageUrl);
  for (var i = 0; i < state.order.length; i++) {
    var session = state.sessions[state.order[i]];
    if (session && session.page && session.page.normalizedUrl === normalizedUrl) {
      return session;
    }
  }
  return null;
}

function getCachedResearchForCompany(state, companyName, excludeSessionId) {
  var target = String(companyName || '').trim().toLowerCase();
  if (!target) return null;
  for (var i = 0; i < state.order.length; i++) {
    var session = state.sessions[state.order[i]];
    if (!session || session.id === excludeSessionId) continue;
    var sameCompany = session.job && String(session.job.companyName || '').trim().toLowerCase() === target;
    if (sameCompany && session.research && session.research.summary) {
      return Core.clone({
        summary: session.research.summary,
        sources: session.research.sources || [],
        query1: session.research.query1 || '',
        query2: session.research.query2 || '',
        fetchedAt: session.research.fetchedAt || session.updatedAt || Core.nowIso(),
        reusedFromSessionId: session.id,
        error: null
      });
    }
  }
  return null;
}

function ensureSessionBase(state, payload, portfolioVersion) {
  var normalizedUrl = Core.normalizeUrl(payload.pageUrl || '');
  var rawText = String(payload.rawPageText || '');
  var scrapeHash = Core.shortHash(rawText);
  var sessionId = Core.buildSessionId(normalizedUrl, scrapeHash, portfolioVersion);
  var session = state.sessions[sessionId] || Core.createEmptySession();

  session.id = sessionId;
  session.page.url = payload.pageUrl || session.page.url;
  session.page.normalizedUrl = normalizedUrl;
  session.page.hostname = (function() {
    try { return new URL(payload.pageUrl || session.page.url || '').hostname; }
    catch (_) { return ''; }
  })();
  session.page.lastSeenAt = Core.nowIso();
  session.scrape.hash = scrapeHash;
  session.scrape.rawText = rawText;
  session.scrape.preview = rawText.slice(0, 500);
  session.scrape.wordCount = Core.wordCount(rawText);
  session.scrape.charCount = rawText.length;
  session.latestStyle = payload.coverLetterType || session.latestStyle || 'formal';
  session.latestModel = payload.model || session.latestModel || DEFAULT_MODEL;
  session.portfolioVersion = portfolioVersion;
  ensureSessionPipeline(session);
  session.updatedAt = Core.nowIso();
  if (!session.createdAt) session.createdAt = session.updatedAt;

  state.sessions[sessionId] = session;
  state.order = moveIdToFront(state.order, sessionId);
  return session;
}

function pushSessionActivity(session, activity) {
  session.activities = Array.isArray(session.activities) ? session.activities : [];
  session.activities.unshift(activity);
  session.activities = session.activities.slice(0, 40);
}

function ensureSessionPipeline(session) {
  session.pipeline = session.pipeline && typeof session.pipeline === 'object' ? session.pipeline : {};
  session.pipeline.kind = session.pipeline.kind || '';
  session.pipeline.status = session.pipeline.status || 'idle';
  session.pipeline.stage = session.pipeline.stage || '';
  session.pipeline.label = session.pipeline.label || '';
  session.pipeline.progress = typeof session.pipeline.progress === 'number' ? session.pipeline.progress : 0;
  session.pipeline.error = session.pipeline.error || '';
  session.pipeline.updatedAt = session.pipeline.updatedAt || '';
  return session.pipeline;
}

function setSessionPipeline(session, kind, stage, label, errorText, progress, status) {
  var pipeline = ensureSessionPipeline(session);
  pipeline.kind = kind || pipeline.kind || '';
  pipeline.status = status || 'running';
  pipeline.stage = stage || '';
  pipeline.label = label || '';
  pipeline.progress = typeof progress === 'number' ? progress : pipeline.progress;
  pipeline.error = errorText || '';
  pipeline.updatedAt = Core.nowIso();
  session.updatedAt = pipeline.updatedAt;
}

async function savePipelineState(state, session, kind, stage, label, errorText, progress, status) {
  if (!state || !session) return;
  setSessionPipeline(session, kind, stage, label, errorText, progress, status);
  await saveSessionState(state);
  broadcastSessionUpdate(session);
}

function clearSessionPipeline(session, kind, label) {
  session.pipeline = {
    kind: kind || '',
    status: 'success',
    stage: 'complete',
    label: label || '',
    progress: 100,
    error: '',
    updatedAt: Core.nowIso()
  };
  session.updatedAt = session.pipeline.updatedAt;
}

function broadcastSessionUpdate(session) {
  try {
    chrome.runtime.sendMessage({
      type: 'SESSION_PIPELINE_UPDATE',
      session: serializeSession(session)
    }, function() {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
}

async function appendLegacyLog(entry) {
  var data = await localGet([STORAGE_KEYS.legacyLogs]);
  var logs = Array.isArray(data[STORAGE_KEYS.legacyLogs]) ? data[STORAGE_KEYS.legacyLogs] : [];
  logs.unshift(entry);
  logs = logs.slice(0, MAX_LEGACY_LOGS);
  var payload = {};
  payload[STORAGE_KEYS.legacyLogs] = logs;
  await localSet(payload);
}

function sanitizeModelFromSettings(settings, payloadModel) {
  var selected = String(payloadModel || settings.model || DEFAULT_MODEL || '').trim();
  if (selected === 'custom') selected = String(settings.customModel || DEFAULT_MODEL || '').trim();
  if (!selected) return DEFAULT_MODEL;
  if (DISABLED_MODELS.indexOf(selected) !== -1) return DEFAULT_MODEL;
  if (ALLOWED_FREE_MODELS.indexOf(selected) !== -1) return selected;
  if (GROQ_MODELS.indexOf(selected) !== -1) return selected;
  if (/^groq\//i.test(selected)) return selected;
  if (/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(selected)) return selected;
  return DEFAULT_MODEL;
}

function chooseExtractionModel(settings) {
  if (settings && settings.groqKey) return FAST_GROQ_EXTRACT_MODEL;
  if (settings && settings.openrouterKey) return FAST_EXTRACT_MODEL;
  return FAST_GROQ_EXTRACT_MODEL;
}

function repairJSON(str) {
  var s = String(str || '').trim();
  s = s.replace(/,\s*([}\]])/g, '$1');
  if ((s.match(/"/g) || []).length % 2 !== 0) s += '"';
  var opens = 0;
  var braces = 0;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '[') opens++;
    else if (s[i] === ']') opens--;
    else if (s[i] === '{') braces++;
    else if (s[i] === '}') braces--;
  }
  s = s.replace(/,\s*$/, '');
  while (opens > 0) { s += ']'; opens--; }
  while (braces > 0) { s += '}'; braces--; }
  return s;
}

function cleanJsonText(text) {
  return String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/```json|```/gi, '')
    .replace(/\u0000/g, '')
    .trim();
}

function extractJsonCandidate(text) {
  var clean = cleanJsonText(text);
  if (!clean) return '';
  var firstBrace = clean.indexOf('{');
  var lastBrace = clean.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) return clean.slice(firstBrace, lastBrace + 1).trim();
  var firstBracket = clean.indexOf('[');
  var lastBracket = clean.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) return clean.slice(firstBracket, lastBracket + 1).trim();
  return clean;
}

function safeParseJson(text, fallbackMessage) {
  var candidates = [];
  var base = extractJsonCandidate(text);
  if (base) candidates.push(base);
  if (base) candidates.push(repairJSON(base));
  var clean = cleanJsonText(text);
  if (clean && clean !== base) candidates.push(clean);
  if (clean && clean !== base) candidates.push(repairJSON(clean));

  var seen = {};
  for (var i = 0; i < candidates.length; i++) {
    var candidate = String(candidates[i] || '').trim();
    if (!candidate || seen[candidate]) continue;
    seen[candidate] = true;
    try {
      return JSON.parse(candidate);
    } catch (_) {}
  }

  throw new Error(fallbackMessage || 'CoverCraft could not parse the JSON output. Please try again.');
}

function firstMeaningfulLines(rawText, limit) {
  return String(rawText || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(function(line) { return line.replace(/\s+/g, ' ').trim(); })
    .filter(Boolean)
    .slice(0, limit || 40);
}

function lineLooksLikeNoise(line) {
  var text = String(line || '').trim();
  if (!text) return true;
  if (text.length > 140) return true;
  if (/^(apply|save|share|search|filter|menu|back|next|previous|home|jobs|job search|recommended|messages|feedback)$/i.test(text)) return true;
  if (/\b(we'?re hiring|hiring now|job opening|position open|looking for|seeking candidates|apply now)\b/i.test(text) && text.length < 90) return true;
  if (/\b(jobright(?:\.ai)?|linkedin|indeed|glassdoor|greenhouse|lever|workday|ashby|simplify|ziprecruiter|monster|wellfound|dice)\b/i.test(text) && text.length < 80) return true;
  if (/(posted|applicants?|days? ago|hours? ago|minutes? ago|full[- ]time|part[- ]time|remote|hybrid|onsite|visa|sponsor)/i.test(text) && text.length < 50) return true;
  if (/^[\d\s,+./()-]+$/.test(text)) return true;
  return false;
}

function looksLikeRoleTitle(line) {
  var text = String(line || '').trim();
  if (!text || lineLooksLikeNoise(text)) return false;
  if (text.length < 4 || text.length > 100) return false;
  return /(analyst|engineer|scientist|manager|developer|intern|specialist|associate|consultant|coordinator|architect|administrator|strategist|researcher|lead|director|officer|writer|designer)/i.test(text);
}

function deriveFromPageTitle(pageTitle) {
  var text = String(pageTitle || '').replace(/\s+/g, ' ').trim();
  if (!text) return { jobTitle: '', companyName: '' };

  var direct = text.match(/^(.*?)\s+(?:at|@)\s+(.+?)(?:\s*[|–—-].*)?$/i);
  if (direct) {
    var directCompany = cleanEntityText(direct[2]);
    return {
      jobTitle: cleanEntityText(direct[1]),
      companyName: looksLikePlatformCompany(directCompany) ? '' : directCompany
    };
  }

  var segments = text.split(/\s*[|–—]\s*/).map(function(segment) {
    return cleanEntityText(segment);
  }).filter(Boolean).filter(function(segment) {
    return !looksLikePlatformCompany(segment);
  });

  for (var i = 0; i < segments.length; i++) {
    if (!looksLikeRoleTitle(segments[i])) continue;
    return {
      jobTitle: segments[i],
      companyName: cleanEntityText(segments[i + 1] || segments[i - 1] || '')
    };
  }

  return { jobTitle: '', companyName: '' };
}

function cleanEntityText(text) {
  return String(text || '')
    .replace(/^[\s:|-]+/, '')
    .replace(/[\s|·•]+$/, '')
    .trim();
}

function sanitizeJobTitleCandidate(text, companyName) {
  var value = cleanEntityText(text)
    .replace(/^(?:job title|position title|position|role|opening|opportunity)\s*[:\-]\s*/i, '')
    .replace(/^(?:we'?re hiring(?: for)?|hiring(?: for)?|now hiring(?: for)?|seeking|looking for|position open for|open position(?: for)?|job opening(?: for)?|apply for|opportunity for)\s+/i, '')
    .replace(/\s+\b(?:position|role|opening)\b\s*$/i, '')
    .replace(/\s+\|\s+.*$/, '')
    .trim();

  var company = cleanEntityText(companyName || '');
  if (!company) {
    var merged = value.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (merged) value = cleanEntityText(merged[1]);
  } else {
    var escapedCompany = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value
      .replace(new RegExp('\\s+(?:at|@)\\s+' + escapedCompany + '$', 'i'), '')
      .replace(new RegExp('\\b' + escapedCompany + '\\b', 'i'), '')
      .trim();
  }

  return cleanEntityText(value);
}

function sanitizeCompanyCandidate(text) {
  var value = cleanEntityText(text)
    .replace(/^(?:company|organization|employer)\s*[:\-]\s*/i, '')
    .replace(/\s+\|\s+.*$/, '')
    .trim();
  if (looksLikePlatformCompany(value)) return '';
  return value;
}

function scoreJobTitleCandidate(title) {
  var text = String(title || '').trim();
  if (!text) return -100;
  var score = 0;
  if (looksLikeRoleTitle(text)) score += 6;
  if (text.length >= 6 && text.length <= 90) score += 2;
  if (/\b(hiring|seeking|looking for|job opening|position open|apply now|opportunity)\b/i.test(text)) score -= 6;
  if (looksLikePlatformCompany(text)) score -= 8;
  if (/\b(remote|hybrid|onsite|full[- ]time|part[- ]time)\b/i.test(text) && !looksLikeRoleTitle(text)) score -= 2;
  if (text.indexOf('|') !== -1) score -= 2;
  return score;
}

function scoreCompanyCandidate(name) {
  var text = String(name || '').trim();
  if (!text) return -100;
  var score = 0;
  if (!looksLikePlatformCompany(text)) score += 4;
  if (!looksLikeRoleTitle(text)) score += 2;
  if (text.length >= 2 && text.length <= 80) score += 1;
  if (/\b(hiring|seeking|looking for|job opening|position)\b/i.test(text)) score -= 6;
  if (looksLikePlatformCompany(text)) score -= 10;
  return score;
}

function chooseBestCandidate(candidates, scorer) {
  var seen = {};
  var best = '';
  var bestScore = -Infinity;
  (candidates || []).forEach(function(candidate) {
    var text = String(candidate || '').trim();
    if (!text) return;
    var key = text.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    var score = scorer(text);
    if (score > bestScore) {
      best = text;
      bestScore = score;
    }
  });
  return best;
}

function looksLikePlatformCompany(text) {
  return /\b(jobright(?:\.ai)?|linkedin|indeed|glassdoor|greenhouse|lever|workday|ashby|simplify|ziprecruiter|monster|wellfound|dice)\b/i.test(String(text || '').trim());
}

function heuristicExtractJobDetails(rawText, hints) {
  var text = String(rawText || '');
  var lines = firstMeaningfulLines(text, 50);
  var title = String(hints && hints.titleHint || '').trim();
  var company = String(hints && hints.companyHint || '').trim();
  var location = '';
  var pageTitleGuess = deriveFromPageTitle(hints && hints.pageTitle || '');

  if (!title) {
    if (pageTitleGuess.jobTitle) title = pageTitleGuess.jobTitle;
  }

  if (!title) {
    for (var i = 0; i < lines.length; i++) {
      if (looksLikeRoleTitle(lines[i])) {
        title = cleanEntityText(lines[i]);
        break;
      }
    }
  }

  if (!company) {
    if (pageTitleGuess.companyName) company = pageTitleGuess.companyName;
  }

  if (!company) {
    var companyMatch = text.match(/(?:company|organization|employer)\s*[:\-]\s*([^\n|]+)/i);
    if (companyMatch) company = cleanEntityText(companyMatch[1]);
  }

  if (!company && title) {
    var titleAt = title.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (titleAt) {
      title = cleanEntityText(titleAt[1]);
      company = cleanEntityText(titleAt[2]);
      if (looksLikePlatformCompany(company)) company = '';
    }
  }

  if (!company) {
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      if (!line || line === title || lineLooksLikeNoise(line)) continue;
      if (/^(company|organization|employer)\s*[:\-]/i.test(line)) {
        company = cleanEntityText(line.replace(/^(company|organization|employer)\s*[:\-]\s*/i, ''));
        if (looksLikePlatformCompany(company)) company = '';
        break;
      }
      if (j > 0 && lines[j - 1] === title && line.length <= 90 && !looksLikeRoleTitle(line)) {
        company = cleanEntityText(line.split(/[|·•]/)[0]);
        if (looksLikePlatformCompany(company)) company = '';
        break;
      }
      if (!company) {
        var lineAt = line.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
        if (lineAt && looksLikeRoleTitle(lineAt[1])) {
          title = title || cleanEntityText(lineAt[1]);
          company = cleanEntityText(lineAt[2]);
          if (looksLikePlatformCompany(company)) company = '';
          if (company) break;
        }
      }
    }
  }

  if (!location) {
    var locationMatch = text.match(/(?:location|based in)\s*[:\-]\s*([^\n|]+)/i);
    if (locationMatch) location = cleanEntityText(locationMatch[1]);
  }

  return {
    jobTitle: title || '',
    companyName: company || '',
    location: location || '',
    jobId: '',
    seniorityLevel: '',
    keywords: [],
    responsibilities: [],
    requirements: []
  };
}

function finalizeExtractedJobDetails(parsed, rawText, hints) {
  parsed = parsed || {};
  hints = hints || {};
  var pageTitleGuess = deriveFromPageTitle(hints.pageTitle || '');
  var heuristic = heuristicExtractJobDetails(rawText, hints);

  var hintedTitle = String(hints.titleHint || '').trim();
  var hintedCompany = String(hints.companyHint || '').trim();
  var titleCandidates = [
    hintedTitle,
    sanitizeJobTitleCandidate(parsed.jobTitle || '', parsed.companyName || ''),
    sanitizeJobTitleCandidate(heuristic.jobTitle || '', heuristic.companyName || ''),
    sanitizeJobTitleCandidate(pageTitleGuess.jobTitle || '', pageTitleGuess.companyName || '')
  ];
  var companyCandidates = [
    hintedCompany,
    sanitizeCompanyCandidate(parsed.companyName || ''),
    sanitizeCompanyCandidate(heuristic.companyName || ''),
    sanitizeCompanyCandidate(pageTitleGuess.companyName || '')
  ];

  var company = hintedCompany || chooseBestCandidate(companyCandidates, scoreCompanyCandidate);
  var title = hintedTitle || chooseBestCandidate(titleCandidates.map(function(candidate) {
    return sanitizeJobTitleCandidate(candidate, company);
  }), scoreJobTitleCandidate);

  if (title && !company) {
    var merged = title.match(/^(.*?)\s+(?:at|@)\s+(.+)$/i);
    if (merged) {
      title = sanitizeJobTitleCandidate(merged[1], '');
      company = sanitizeCompanyCandidate(merged[2]);
    }
  }

  if (company && title && title.toLowerCase().indexOf(company.toLowerCase()) !== -1) {
    title = sanitizeJobTitleCandidate(title, company);
  }

  return {
    jobTitle: title || '',
    companyName: company || '',
    location: parsed.location || heuristic.location || '',
    jobId: parsed.jobId || '',
    seniorityLevel: parsed.seniorityLevel || '',
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.slice(0, 12) : [],
    responsibilities: Array.isArray(parsed.responsibilities) ? parsed.responsibilities.slice(0, 6) : [],
    requirements: Array.isArray(parsed.requirements) ? parsed.requirements.slice(0, 6) : []
  };
}

async function aiChatMessages(messages, options) {
  var settings = await loadSettings();
  var allowRouterModelFallback = !!(options && options.allowRouterModelFallback);
  var requestedModel = String(options && options.model || settings.model || DEFAULT_MODEL || '').trim() || DEFAULT_MODEL;
  var useGroq = /^groq\//i.test(requestedModel) || GROQ_MODELS.indexOf(requestedModel) !== -1;
  var apiKey = useGroq ? settings.groqKey : settings.openrouterKey;
  if (!apiKey) throw new Error(useGroq ? 'Missing Groq API key. Add it in CoverCraft settings.' : 'Missing OpenRouter API key. Add it in CoverCraft settings.');

  var body = {
    model: useGroq ? requestedModel.replace(/^groq\//, '') : requestedModel,
    messages: messages,
    temperature: options && options.temperature != null ? options.temperature : 0.2,
    max_tokens: options && options.maxTokens || 1200
  };

  async function runOpenRouterRequest(requestBody) {
    var headers = {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    };
    if (!useGroq) {
      headers['HTTP-Referer'] = 'https://covercraft.extension';
      headers['X-Title'] = 'CoverCraft';
    }
    var response = await fetch(useGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });
    var data = await response.json().catch(function() { return {}; });
    return {
      ok: response.ok,
      status: response.status,
      data: data
    };
  }

  function wait(ms) {
    return new Promise(function(resolve) {
      setTimeout(resolve, ms);
    });
  }

  function summarizeGroqRateLimit(message) {
    var text = String(message || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    var lowered = text.toLowerCase();
    if (/requests per minute|rpm/.test(lowered)) return 'This model hit its requests-per-minute limit.';
    if (/requests per day|rpd/.test(lowered)) return 'This model hit its daily request limit.';
    if (/tokens per minute|tpm/.test(lowered)) return 'This model hit its tokens-per-minute limit.';
    if (/tokens per day|tpd/.test(lowered)) return 'This model hit its daily token limit.';
    if (/retry|try again in|wait/i.test(text)) return text;
    return text;
  }

  function normalizeOpenRouterError(errorMessage, status) {
    var message = String(errorMessage || '').trim() || ((useGroq ? 'Groq' : 'OpenRouter') + ' HTTP ' + status);
    var requestedModelLabel = requestedModel.replace(/^groq\//, '');
    if (useGroq && (status === 429 || /rate limit|too many requests/i.test(message))) {
      var detail = summarizeGroqRateLimit(message);
      return 'Groq rate limit reached for ' + requestedModelLabel + '. ' +
        (detail ? detail + ' ' : '') +
        'Switch to another Groq model or wait for the limit window to reset.';
    }
    if (useGroq && /authentication|invalid api key|unauthorized/i.test(message)) return 'Groq rejected the API key. Check the Groq key in CoverCraft settings.';
    if (useGroq && /does not exist or you do not have access/i.test(message)) {
      return 'Groq says "' + requestedModelLabel + '" is not available to this API key, project, or account. Check Groq Model Permissions, the active project for this key, and whether the model appears in the /openai/v1/models list for your account.';
    }
    if (useGroq && /model/i.test(message) && /not found|unsupported|does not exist|decommissioned|disabled/i.test(message)) {
      return 'Groq model "' + requestedModelLabel + '" is unavailable for this account or endpoint. Pick another Groq model.';
    }
    if (useGroq && /tool/i.test(message) && /unsupported|not supported|disabled/i.test(message)) {
      return 'Groq model "' + requestedModelLabel + '" rejected this request shape. Try another Groq model or fall back to OpenRouter free routing.';
    }
    if (/guardrail restrictions|data policy/i.test(message)) {
      return 'OpenRouter blocked the selected provider route because of privacy or guardrail settings. Check https://openrouter.ai/settings/privacy if this keeps happening.';
    }
    if (/provider returned error/i.test(message)) {
      return 'The selected model provider failed upstream for "' + requestedModelLabel + '". CoverCraft retried, but the provider is still failing. Try again or switch models.';
    }
    return message;
  }

  function shouldRetrySameModel(errorMessage, status) {
    var text = String(errorMessage || '').toLowerCase();
    if (useGroq && status === 429) return false;
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    return text.indexOf('provider returned error') !== -1 ||
      text.indexOf('temporarily unavailable') !== -1 ||
      text.indexOf('timeout') !== -1 ||
      text.indexOf('overloaded') !== -1;
  }

  function shouldRetryWithDefaultProviderRouting(errorMessage, status) {
    var text = String(errorMessage || '').toLowerCase();
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;
    return text.indexOf('provider returned error') !== -1 ||
      text.indexOf('guardrail restrictions') !== -1 ||
      text.indexOf('data policy') !== -1 ||
      text.indexOf('no endpoints found') !== -1 ||
      text.indexOf('temporarily unavailable') !== -1 ||
      text.indexOf('no provider') !== -1;
  }

  function shouldRetryWithFreeRouter(model, errorMessage, status) {
    if (useGroq) return false;
    if (!model || model === DEFAULT_MODEL) return false;
    var text = String(errorMessage || '').toLowerCase();
    if (status === 404) return true;
    return text.indexOf('no endpoints found') !== -1 ||
      text.indexOf('provider returned error') !== -1 ||
      text.indexOf('temporarily unavailable') !== -1 ||
      text.indexOf('no provider') !== -1 ||
      text.indexOf('route') !== -1 ||
      text.indexOf('model') !== -1;
  }

  var result = await runOpenRouterRequest(body);
  var attempt = 0;
  while (!result.ok && attempt < 2) {
    var transientError = (result.data.error && result.data.error.message) || ('OpenRouter HTTP ' + result.status);
    if (!shouldRetrySameModel(transientError, result.status)) break;
    attempt++;
    await wait(250 * attempt);
    result = await runOpenRouterRequest(body);
  }
  if (!result.ok) {
    var routeError = (result.data.error && result.data.error.message) || ('OpenRouter HTTP ' + result.status);
    if (shouldRetryWithDefaultProviderRouting(routeError, result.status)) {
      var unpinnedBody = Object.assign({}, body);
      result = await runOpenRouterRequest(unpinnedBody);
      var unpinnedAttempt = 0;
      while (!result.ok && unpinnedAttempt < 1) {
        var unpinnedError = (result.data.error && result.data.error.message) || ('OpenRouter HTTP ' + result.status);
        if (!shouldRetrySameModel(unpinnedError, result.status)) break;
        unpinnedAttempt++;
        await wait(300);
        result = await runOpenRouterRequest(unpinnedBody);
      }
    }
  }
  if (!result.ok) {
    var primaryError = normalizeOpenRouterError((result.data.error && result.data.error.message) || ('OpenRouter HTTP ' + result.status), result.status);
    if (allowRouterModelFallback && shouldRetryWithFreeRouter(body.model, primaryError, result.status)) {
      var fallbackBody = Object.assign({}, body, { model: DEFAULT_MODEL });
      var fallback = await runOpenRouterRequest(fallbackBody);
      var fallbackAttempt = 0;
      while (!fallback.ok && fallbackAttempt < 2) {
        var fallbackTransientError = (fallback.data.error && fallback.data.error.message) || ('OpenRouter HTTP ' + fallback.status);
        if (!shouldRetrySameModel(fallbackTransientError, fallback.status)) break;
        fallbackAttempt++;
        await wait(250 * fallbackAttempt);
        fallback = await runOpenRouterRequest(fallbackBody);
      }
      if (!fallback.ok) {
        var fallbackError = normalizeOpenRouterError((fallback.data.error && fallback.data.error.message) || primaryError, fallback.status);
        if (/privacy or guardrail settings/i.test(fallbackError)) {
          fallbackError = 'OpenRouter could not find any provider that matches your current privacy restrictions for this free request. Review https://openrouter.ai/settings/privacy or keep using Free Routing with less restrictive data-policy settings.';
        }
        throw new Error(fallbackError);
      }
      return {
        content: (fallback.data.choices && fallback.data.choices[0] && fallback.data.choices[0].message && fallback.data.choices[0].message.content) || '',
        model: fallback.data.model || fallbackBody.model
      };
    }
    throw new Error(primaryError);
  }

  return {
    content: (result.data.choices && result.data.choices[0] && result.data.choices[0].message && result.data.choices[0].message.content) || '',
    model: (useGroq ? 'groq/' : '') + (result.data.model || body.model)
  };
}

async function aiChat(systemPrompt, userPrompt, temperature, maxTokens, model) {
  return aiChatMessages([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ], {
    temperature: temperature,
    maxTokens: maxTokens,
    model: model
  });
}

async function extractJobDetails(rawText, hints, model) {
  var systemPrompt = [
    'You are a job posting parser. Return ONLY a single valid JSON object.',
    'Never include markdown or commentary.',
    'Extract only the clean role title and clean employer name.',
    'Do not include job boards, wrapper platforms, hiring boilerplate, or phrases like "we are hiring", "looking for", or "position open for" in jobTitle.',
    'Do not return LinkedIn, JobRight.ai, Indeed, Glassdoor, Greenhouse, Lever, Workday, Ashby, or similar platforms as companyName unless they are the actual employer.',
    'Return keys exactly as:',
    '{"jobTitle":"","companyName":"","location":"","jobId":"","seniorityLevel":"","keywords":[],"responsibilities":[],"requirements":[]}'
  ].join('\n');

  var userPrompt = [
    'Extract the job posting details from the text below.',
    'Use the provided manual hints when present.',
    '',
    'Hints:',
    JSON.stringify({ titleHint: hints.titleHint || '', companyHint: hints.companyHint || '', pageTitle: hints.pageTitle || '' }),
    '',
    'Job posting:',
    String(rawText || '').slice(0, 5000)
  ].join('\n');

  var response = null;
  var parsed = null;
  var usedAi = false;
  var usedHeuristic = false;
  try {
    response = await aiChat(systemPrompt, userPrompt, 0, 420, model);
    parsed = safeParseJson(response.content, 'CoverCraft could not parse the extracted job details. Please refresh and try again.');
    usedAi = true;
  } catch (_) {
    parsed = heuristicExtractJobDetails(rawText, hints);
    usedHeuristic = true;
    response = response || { content: '', model: model };
  }

  parsed = finalizeExtractedJobDetails(parsed || {}, rawText, hints);
  if ((!parsed.jobTitle || !parsed.companyName || !parsed.location) && !(usedHeuristic && !usedAi)) {
    usedHeuristic = true;
    parsed = finalizeExtractedJobDetails(parsed, rawText, hints);
  }

  if (!parsed.jobTitle && !parsed.companyName) {
    var lines = firstMeaningfulLines(rawText, 8);
    if (lines[0]) parsed.jobTitle = cleanEntityText(lines[0].split(/[|·•]/)[0]);
    if (lines[1]) parsed.companyName = cleanEntityText(lines[1].split(/[|·•]/)[0]);
  }

  if (!parsed.jobTitle && !parsed.companyName) {
    throw new Error('CoverCraft could not identify the job title or company from this page. Try refreshing the page text and then scrape again.');
  }

  return {
    parsed: parsed,
    systemPrompt: systemPrompt,
    userPrompt: userPrompt,
    rawResponse: response.content,
    model: response.model,
    method: usedAi && usedHeuristic ? 'ai_plus_heuristic' : (usedAi ? 'ai' : 'heuristic')
  };
}

async function runCompanyResearch(job, settings) {
  var companyName = job.companyName || '';
  var jobTitle = job.jobTitle || 'role';
  var result = {
    summary: '',
    sources: [],
    query1: '',
    query2: '',
    fetchedAt: Core.nowIso(),
    error: null
  };

  if (!companyName) return result;
  if (!settings.tavilyKey) throw new Error('Missing Tavily API key. Add it in CoverCraft settings.');

  result.query1 = companyName + ' mission values culture product technology recent company overview for ' + jobTitle;
  result.query2 = '';

  async function tavilySearch(query, depth, maxResults, tag) {
    var response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        api_key: settings.tavilyKey,
        query: query,
        search_depth: depth,
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false
      })
    });

    if (!response.ok) throw new Error('Tavily HTTP ' + response.status);
    var data = await response.json();
    return {
      answer: data.answer || '',
      sources: (data.results || []).map(function(item) {
        return {
          title: item.title || '',
          url: item.url || '',
          snippet: String(item.content || '').slice(0, 500),
          queryTag: tag
        };
      })
    };
  }

  try {
    var research = await tavilySearch(result.query1, 'advanced', 5, 'company');
    result.summary = research.answer || '';
    result.sources = research.sources;
  } catch (err) {
    result.error = err && err.message ? err.message : 'Research request failed.';
  }

  if (!result.summary && result.sources.length) {
    result.summary = result.sources.map(function(source) { return source.snippet; }).join('\n\n').slice(0, 1400);
  }

  return result;
}

function stripFormatting(text, portfolio) {
  var ownerName = portfolio && portfolio.name ? portfolio.name : 'Your Name';
  var clean = String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*•]\s+/gm, '')
    .replace(/\u2014/g, ',')
    .replace(/\u2013/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  var dearIdx = clean.search(/\bDear\b/i);
  if (dearIdx > 0) clean = clean.slice(dearIdx).trim();
  if (!/^Dear Hiring Manager/i.test(clean)) clean = 'Dear Hiring Manager,\n\n' + clean;
  clean = clean
    .replace(/\n+\s*(?:sincerely|best regards|kind regards|warm regards|regards|thank you|thanks|thank you for your consideration)[\s,!.]*[\s\S]*$/i, '')
    .trim();
  if (ownerName) {
    var escapedOwnerName = String(ownerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    clean = clean.replace(new RegExp('\\n+\\s*' + escapedOwnerName + '\\s*$', 'i'), '').trim();
  }
  clean += '\n\nSincerely,\n' + ownerName;
  return clean.trim();
}

function normalizePlainAnswer(text) {
  var clean = String(text || '')
    .replace(/```[\s\S]*?```/g, function(match) {
      return match.replace(/```/g, '');
    })
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\u2014/g, ', ')
    .replace(/\u2013/g, '-')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  var paragraphs = clean.split(/\n\s*\n+/).map(function(block) {
    return block
      .split('\n')
      .map(function(line) { return line.trim(); })
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }).filter(Boolean);

  return paragraphs.join('\n\n').trim();
}

function looksLikeCompleteCoverLetter(text, ownerName) {
  var clean = String(text || '').trim();
  var words = Core.wordCount(clean);
  if (words < 140) return false;
  var body = clean
    .replace(/^Dear Hiring Manager,\s*/i, '')
    .replace(/\n+\s*Sincerely,\s*\n+\s*/i, '\n')
    .trim();
  if (ownerName) {
    var escapedOwnerName = String(ownerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp('\\n+\\s*' + escapedOwnerName + '\\s*$', 'i'), '').trim();
  }
  return Core.wordCount(body) >= 120;
}

function buildCoverLetterSystemPrompt(portfolio, style) {
  return [
    'You are writing a professional cover letter for a job applicant.',
    'This is a constrained evidence-synthesis task, not a generic writing task.',
    'Output only the final letter text.',
    'Write in first person and plain prose only.',
    'Do not use markdown, bullets, headings, labels, or sign-off blocks.',
    'Avoid AI clichés, generic praise, resume-summary dumping, and em dashes.',
    'Begin exactly with "Dear Hiring Manager,".',
    'Use only the provided job context, ranked portfolio evidence, and company research.',
    'Never invent experience, metrics, technologies, domains, employers, titles, dates, or motivations.',
    'Silently rank the evidence first, then write from the strongest relevant evidence only.',
    'If one experience has clear industry or domain overlap with the role, prioritize it early even if it is not the newest experience.',
    'Do not mention experience just because it exists in the portfolio. Include only evidence that strengthens fit for this exact role.',
    'Preserve strong source language, quantified impact, and concrete technical details when they already exist in the source evidence.',
    'Do not paraphrase dense source bullets into thin generic summaries.',
    'Use exact job-description keywords only when they are genuinely supported by the source evidence.',
    'Make the applicant sound chosen-for-this-role, not broadly capable-in-general.',
    'Write exactly 5 paragraphs when possible, and use 6 only when the job context genuinely needs one extra body paragraph.',
    'Keep each paragraph purposeful and distinct, not repetitive.',
    'Paragraph plan:',
    '1. Short opening: exact role, company, strongest fit, and why this application is credible.',
    '2. Highest-relevance experience, using the strongest matching evidence and concrete outcomes.',
    '3. Second relevant experience or project that deepens the fit rather than repeating paragraph 2.',
    '4. Technical, analytical, operational, or cross-functional strengths mapped to the role requirements.',
    '5. Company-specific fit using the research, why this role makes sense, and a short natural closing sentence.',
    '6. Optional short extra paragraph only if it adds distinct, grounded value.',
    'Depth over breadth: it is better to develop 2 strong evidence clusters than mention 5 weak ones.',
    'Do not include a closing sign-off, typed name, phone number, email, website, or date.',
    'CoverCraft adds the final signature and header separately.',
    'Do not repeat the applicant name inside the closing.',
    'End with a natural final sentence, not a sign-off block.',
    'Preferred tone: ' + (style || 'formal')
  ].join('\n');
}

function buildCoverLetterUserPrompt(session, style, portfolio) {
  var promptContext = buildJobApplicationPromptContext(session, portfolio);
  return [
    'Write a tailored cover letter using the job context below.',
    'Before drafting, silently decide which 2 experiences and which optional project best prove fit.',
    'Use the ranked evidence as the default priority order unless another item is more clearly supported.',
    'If a ranked experience already contains gold-standard wording for this job, preserve that wording in narrative form instead of flattening it.',
    'Use the company research and job details directly.',
    'Keep it concrete, natural, and evidence-backed.',
    'Target 430 to 560 words.',
    'Write exactly 5 paragraphs unless a 6th short paragraph materially improves the letter.',
    'Use this paragraph structure:',
    '1. Opening fit for the exact title and company, with immediate credibility.',
    '2. Strongest directly relevant experience with measurable outcomes and domain fit.',
    '3. Another role or project that proves range, depth, or adjacent relevance.',
    '4. Technical, analytical, operational, or stakeholder strengths mapped to the role requirements.',
    '5. Company-specific motivation based on the research, plus a short closing sentence.',
    'Do not list experiences chronologically unless chronology also matches relevance.',
    'Do not spend space on experiences that are only loosely related to the role.',
    'Do not say the applicant is a fit without proving it from evidence.',
    'Keep the final paragraph concise and do not add "Sincerely", "Thank you", or the applicant name.',
    '',
    'Style:',
    style || 'formal',
    '',
    'Ranked prompt context:',
    JSON.stringify(promptContext),
    '',
    'Job context:',
    JSON.stringify({
      page: session.page,
      job: session.job,
      research: session.research,
      scrapePreview: session.scrape.preview
    })
  ].join('\n');
}

async function generateCoverLetter(session, style, model, portfolio) {
  var systemPrompt = buildCoverLetterSystemPrompt(portfolio, style);
  var userPrompt = buildCoverLetterUserPrompt(session, style, portfolio);
  var attempts = 0;
  var response = null;
  var output = '';
  while (attempts < 2) {
    attempts++;
    response = await aiChat(
      systemPrompt,
      userPrompt,
      attempts === 1 ? 0.72 : 0.55,
      2200,
      model
    );
    output = stripFormatting(response.content, portfolio);
    if (output && looksLikeCompleteCoverLetter(output, portfolio && portfolio.name)) break;
  }
  if (!output) throw new Error('AI returned an empty response.');
  if (!looksLikeCompleteCoverLetter(output, portfolio && portfolio.name)) {
    throw new Error('The model returned an incomplete cover letter. Please try again or switch models.');
  }
  return {
    text: output,
    model: response.model,
    prompt: {
      system: systemPrompt,
      user: userPrompt
    }
  };
}

function buildAskSystemPrompt(portfolio) {
  return [
    'You help a job applicant answer questions for an application or recruiter conversation.',
    'This is a grounded response task. Use only the provided portfolio evidence, job context, and company research.',
    'Do not invent experience, metrics, or credentials.',
    'Answer directly in plain text, ready to copy and paste.',
    'Do not use bullets, numbered lists, markdown, bold text, headings, or labels.',
    'Write in compact paragraph form only.',
    'Silently identify the question type before answering: motivation, experience, project, skills, logistics, or general application question.',
    'Then select the 1 to 2 strongest evidence items for that question and answer from those items.',
    'Do not dump the whole background when a single concrete example answers the question better.',
    'If the question asks for an example, lead with the strongest relevant example and include grounded detail.',
    'If the question asks why this role or company, use the company research and exact role context.',
    'If the available evidence is missing or weak, say so conservatively instead of filling the gap with generic claims.'
  ].join('\n');
}

function buildAskUserPrompt(session, question, portfolio) {
  var promptContext = buildJobApplicationPromptContext(session, portfolio);
  return [
    'Answer the question below using the cached job context and portfolio.',
    'If the answer should be in first person, write it that way.',
    'If there is missing information, be explicit and stay conservative.',
    'Prefer one or two short paragraphs.',
    'Use the ranked evidence first, not the full portfolio blindly.',
    'If one experience cleanly answers the question, use that experience deeply instead of mentioning many experiences shallowly.',
    'If the question is yes/no or direct, answer that in the first sentence and then support it.',
    '',
    'Question:',
    question,
    '',
    'Ranked prompt context:',
    JSON.stringify(promptContext),
    '',
    'Portfolio:',
    JSON.stringify(portfolio),
    '',
    'Job context:',
    JSON.stringify({
      page: session.page,
      job: session.job,
      research: session.research,
      scrapePreview: session.scrape.preview
    })
  ].join('\n');
}

async function answerQuestion(session, question, model, portfolio) {
  var response = await aiChat(
    buildAskSystemPrompt(portfolio),
    buildAskUserPrompt(session, question, portfolio),
    0.35,
    900,
    model
  );
  var answer = normalizePlainAnswer(response.content || '');
  if (!answer) throw new Error('AI returned an empty answer.');
  return {
    answer: answer,
    model: response.model
  };
}

function asCleanArray(value) {
  return Array.isArray(value) ? value.map(function(item) {
    return String(item || '').trim();
  }).filter(Boolean) : [];
}

function dedupeStrings(values) {
  var seen = {};
  return asCleanArray(values).filter(function(item) {
    var key = item.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function clipWords(text, maxWords) {
  var words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!maxWords || words.length <= maxWords) return String(text || '').trim();
  var clipped = words.slice(0, maxWords).join(' ').replace(/[,:;/-]+$/, '');
  return clipped + '.';
}

function firstVerb(text) {
  return String(text || '').trim().split(/\s+/)[0].replace(/[^a-z]/gi, '').toLowerCase();
}

function normalizeResumeEducationEntries(rawPortfolio) {
  return Array.isArray(rawPortfolio && rawPortfolio.education) ? rawPortfolio.education.map(function(entry) {
    entry = entry || {};
    return {
      institution: String(entry.institution || '').trim(),
      location: String(entry.location || '').trim(),
      degree: String(entry.degree || '').trim(),
      duration: String(entry.duration || '').trim(),
      gpa: String(entry.gpa || '').trim(),
      highlights: asCleanArray(entry.highlights)
    };
  }).filter(function(entry) {
    return entry.institution || entry.degree || entry.duration || entry.gpa;
  }) : [];
}

function normalizeResumeExperiences(rawPortfolio) {
  return Array.isArray(rawPortfolio && rawPortfolio.experiences) ? rawPortfolio.experiences.map(function(entry) {
    entry = entry || {};
    var bullets = asCleanArray(entry.highlights || entry.responsibilities || entry.achievements).slice(0, 3);
    return {
      company: String(entry.company || '').trim(),
      role: String(entry.role || entry.position || entry.title || '').trim(),
      duration: String(entry.duration || '').trim(),
      location: String(entry.location || '').trim(),
      bullets: bullets,
      bulletBudgets: bullets.map(function(bullet) {
        return Math.max(9, Core.wordCount(bullet));
      })
    };
  }).filter(function(entry) {
    return entry.company || entry.role || entry.duration || entry.bullets.length;
  }) : [];
}

function inferResumeProjectLinks(project) {
  project = project || {};
  var links = [];

  function pushLink(url, label) {
    var href = String(url || '').trim();
    if (!href) return;
    links.push({
      url: href,
      label: String(label || '').trim() || 'Link'
    });
  }

  if (Array.isArray(project.links)) {
    project.links.forEach(function(link) {
      if (!link || typeof link !== 'object') return;
      pushLink(link.url || link.href, link.label || link.title || '');
    });
  }
  pushLink(project.githubUrl || project.github, 'GitHub');
  pushLink(project.videoUrl || project.video, 'Video');
  pushLink(project.articleUrl || project.article, 'Article');
  pushLink(project.demoUrl || project.demo, 'Demo');
  pushLink(project.websiteUrl || project.website, 'Website');

  if (!links.length) {
    var rawUrl = String(project.url || '').trim();
    var lowered = rawUrl.toLowerCase();
    var label = 'Link';
    if (lowered.indexOf('github.com') !== -1) label = 'GitHub';
    else if (lowered.indexOf('youtube.com') !== -1 || lowered.indexOf('youtu.be') !== -1) label = 'Video';
    else if (lowered.indexOf('medium.com') !== -1) label = 'Article';
    pushLink(rawUrl, label);
  }

  var seen = {};
  return links.filter(function(link) {
    var key = (link.url + '|' + link.label).toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  }).slice(0, 3);
}

function normalizeResumeProjects(rawPortfolio) {
  return Array.isArray(rawPortfolio && rawPortfolio.projects) ? rawPortfolio.projects.map(function(project) {
    project = project || {};
    var description = String(project.description || '').trim();
    return {
      title: String(project.title || '').trim(),
      description: description,
      technologies: dedupeStrings(project.technologies || []),
      url: String(project.url || '').trim(),
      links: inferResumeProjectLinks(project),
      wordBudget: Math.max(18, Core.wordCount(description))
    };
  }).filter(function(project) {
    return project.title || project.description;
  }) : [];
}

function normalizeResumeLeadership(rawPortfolio) {
  return asCleanArray(rawPortfolio && (rawPortfolio.leadership || rawPortfolio.achievements || []));
}

function normalizeResumeCertifications(rawPortfolio) {
  return asCleanArray(rawPortfolio && rawPortfolio.certifications);
}

function splitSkillList(skillsText) {
  return dedupeStrings(String(skillsText || '').split(/[,\n]/));
}

function normalizeResumeSkillString(value, maxWords) {
  return clipWords(String(value || '').replace(/\s+/g, ' ').trim(), maxWords || 85);
}

function buildResumeKeywords(session) {
  var job = session && session.job || {};
  var text = [
    job.jobTitle || '',
    job.companyName || '',
    (job.keywords || []).join(' '),
    (job.requirements || []).join(' '),
    (job.responsibilities || []).join(' '),
    session && session.scrape ? session.scrape.preview || '' : '',
    session && session.research ? session.research.summary || '' : ''
  ].join(' ').toLowerCase();
  var words = text.match(/[a-z][a-z0-9.+#/-]{2,}/g) || [];
  var ignore = {
    the: 1, and: 1, with: 1, for: 1, from: 1, that: 1, this: 1, role: 1, team: 1, company: 1,
    work: 1, years: 1, year: 1, using: 1, build: 1, across: 1, about: 1, your: 1, will: 1,
    have: 1, our: 1, you: 1, job: 1, data: 0
  };
  var counts = {};
  words.forEach(function(word) {
    if (ignore[word]) return;
    counts[word] = (counts[word] || 0) + 1;
  });
  return Object.keys(counts).sort(function(a, b) {
    return counts[b] - counts[a];
  }).slice(0, 30);
}

function keywordMatchesForText(text, keywords, limit) {
  var haystack = ' ' + normalizeResumeComparisonText(text) + ' ';
  var seen = {};
  var matches = [];
  (keywords || []).forEach(function(keyword) {
    var original = String(keyword || '').trim();
    var key = normalizeResumeComparisonText(original);
    if (!key || seen[key]) return;
    if (haystack.indexOf(' ' + key + ' ') !== -1 || haystack.indexOf(key) !== -1) {
      seen[key] = true;
      matches.push(original);
    }
  });
  return matches.slice(0, limit || 8);
}

function scoreExperienceForPrompt(experience, keywords) {
  experience = experience || {};
  var roleMatches = keywordMatchesForText([
    experience.role || '',
    experience.company || ''
  ].join(' '), keywords, 30);
  var bulletText = Array.isArray(experience.bullets) ? experience.bullets.join(' ') : '';
  var bulletMatches = keywordMatchesForText(bulletText, keywords, 30);
  var score = roleMatches.length * 5 + bulletMatches.length * 2;
  if (hasResumeImpactSignal(bulletText)) score += 0.5;
  return score;
}

function choosePromptExperiences(experiences, keywords, limit) {
  return (experiences || []).map(function(experience, index) {
    return {
      experience: experience,
      score: scoreExperienceForPrompt(experience, keywords) + Math.max(0, 4 - index) * 0.15,
      matchedKeywords: keywordMatchesForText([
        experience.role || '',
        experience.company || '',
        Array.isArray(experience.bullets) ? experience.bullets.join(' ') : ''
      ].join(' '), keywords, 8)
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 4).map(function(entry) {
    return {
      company: entry.experience.company,
      role: entry.experience.role,
      duration: entry.experience.duration,
      location: entry.experience.location,
      matchedKeywords: entry.matchedKeywords,
      bullets: entry.experience.bullets
    };
  });
}

function choosePromptProjects(projects, keywords, limit) {
  return (projects || []).map(function(project, index) {
    return {
      project: project,
      score: scoreProjectForKeywords(project, keywords) + Math.max(0, 3 - index) * 0.1,
      matchedKeywords: keywordMatchesForText([
        project.title || '',
        project.description || '',
        (project.technologies || []).join(' ')
      ].join(' '), keywords, 8)
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 3).map(function(entry) {
    return {
      title: entry.project.title,
      description: entry.project.description,
      technologies: entry.project.technologies,
      links: entry.project.links,
      matchedKeywords: entry.matchedKeywords
    };
  });
}

function choosePromptAchievements(achievements, keywords, limit) {
  return dedupeStrings(achievements || []).map(function(item, index) {
    return {
      text: item,
      score: scoreResumeTextAgainstKeywords(item, keywords) + Math.max(0, 3 - index) * 0.1
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 4).map(function(entry) {
    return entry.text;
  });
}

function buildJobApplicationPromptContext(session, portfolio) {
  var keywords = buildResumeKeywords(session);
  var experiences = normalizeResumeExperiences(portfolio || {});
  var projects = normalizeResumeProjects(portfolio || {});
  var skillsList = splitSkillList(portfolio && portfolio.skills || '');
  return {
    target: {
      jobTitle: session && session.job ? session.job.jobTitle || '' : '',
      companyName: session && session.job ? session.job.companyName || '' : '',
      location: session && session.job ? session.job.location || '' : '',
      seniorityLevel: session && session.job ? session.job.seniorityLevel || '' : ''
    },
    jobSignals: {
      keywords: session && session.job ? (session.job.keywords || []).slice(0, 12) : [],
      requirements: session && session.job ? (session.job.requirements || []).slice(0, 8) : [],
      responsibilities: session && session.job ? (session.job.responsibilities || []).slice(0, 8) : []
    },
    rankedEvidence: {
      experiences: choosePromptExperiences(experiences, keywords, 4),
      projects: choosePromptProjects(projects, keywords, 3),
      achievements: choosePromptAchievements(portfolio && portfolio.achievements || [], keywords, 4),
      skills: chooseResumeSkills(skillsList, keywords, 18, 260),
      keywords: keywords.slice(0, 18)
    },
    companyResearch: {
      summary: session && session.research ? session.research.summary || '' : '',
      sources: session && session.research ? (session.research.sources || []).slice(0, 4) : []
    },
    scrapePreview: session && session.scrape ? session.scrape.preview || '' : ''
  };
}

function scoreProjectForKeywords(project, keywords) {
  var haystack = [
    project.title || '',
    project.description || '',
    (project.technologies || []).join(' ')
  ].join(' ').toLowerCase();
  var score = 0;
  keywords.forEach(function(keyword) {
    if (haystack.indexOf(keyword) !== -1) score += keyword.length > 5 ? 3 : 1;
  });
  return score;
}

function chooseResumeProjects(projects, keywords, limit) {
  return (projects || []).map(function(project, index) {
    return {
      project: project,
      score: scoreProjectForKeywords(project, keywords) + Math.max(0, 3 - index) * 0.1
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 3).map(function(entry) {
    return entry.project;
  });
}

function buildCanonicalResumeTemplate() {
  var experiences = [
    {
      company: 'HCLTech',
      location: 'College Station, TX',
      role: 'Global Engagement Management Intern',
      duration: 'Feb 2026 -- May 2026',
      bullets: [
        'Analyzed network capacity and churn forecasting model outputs (Python, SQL), translating telecom KPI trends into strategic insights and pre-sales frameworks across the TMT sector',
        'Engineered visualizations for churn risk, network utilization, and automation impact; partnered with cross-functional stakeholders to deliver leadership-ready business cases identifying 65% automation and 75% cost reduction opportunities for $35B+ market'
      ]
    },
    {
      company: 'Mays Business School, Texas A&M University',
      location: 'College Station, TX',
      role: 'Graduate Assistant -- Data Analyst',
      duration: 'Nov 2025 -- Feb 2026',
      bullets: [
        'Architected an analytics platform via Python ETL ingesting 2,400+ admissions records across 7 programs and 3 cohorts into SQLite, cutting 95% of manual reporting (80+ hrs./year saved)',
        'Deployed a marketing intelligence suite analyzing 585+ expenditure records across 10+ channels with 60-day attribution modeling and timing heatmaps, maximizing ROI on $500K+ annual budget',
        'Developed a forecasting engine (Prophet, ARIMA, scikit-learn) with calendar-aware seasonality, achieving <15% MAPE for 8-month enrollment predictions and reducing marketing spend inefficiency by 20%'
      ]
    },
    {
      company: 'Utilities and Energy Services, Texas A&M University',
      location: 'College Station, TX',
      role: 'Graduate Assistant -- Data & Automation Engineer',
      duration: 'May 2025 -- Nov 2025',
      bullets: [
        'Constructed Power BI monitoring views for energy, weather, and financial metrics via Python ETL processing 50,000+ daily sensor feeds from 15 sources into structured SQL, cutting 95% manual work (300+ hrs./year)',
        'Designed a week-ahead forecast workflow integrating ERCOT pricing, weather, and solar generation signals (Selenium, pandas, openpyxl), improving forecast precision 30% and enabling 20% operational cost savings',
        'Digitized billing via an OCR ingestion layer (pytesseract, pandas) with a YoY reporting view, achieving 97% fidelity, 95% faster processing, and auto-flagging 3% of outliers for review'
      ]
    },
    {
      company: 'Black Tie Concierge LLC',
      location: 'Austin, TX',
      role: 'AI & Data Intern -- Digital Product Strategy',
      duration: 'May 2025 -- Aug 2025',
      bullets: [
        'Translated operational records into actionable intelligence: architected a scalable database for users, rides & payments with real-time ingestion and archival, optimizing query performance ~80% for senior decision-making',
        'Automated post-booking workflow using AI-powered NLP and low-code (n8n) orchestration -- confirmations, receipts, calendar invites, driver assignment -- compressing cycle time to <1 min and removing ~90% of communication errors',
        'Launched a luxury travel system (Next.js, Supabase, Stripe) generating $10K+ revenue and 3x traffic growth in 3 months via demand-analytics-driven SEO/GEO strategies and instant-quote automation'
      ]
    },
    {
      company: 'Tata Consultancy Services (Equifax)',
      location: 'Ahmedabad, India',
      role: 'Data Engineer / Migration Analyst',
      duration: 'Aug 2021 -- Aug 2024',
      bullets: [
        'Delivered interactive reporting views replacing 15+ static Excel reports, reducing record errors 90%, accelerating stakeholder decisions 15%, and aligning analytical strategy with organizational goals across teams',
        'Modernized 60+ legacy SAS scripts to Python (pandas, NumPy), slashing runtime 80%, compute cost 50%, and tripling peak-hour throughput; QA validation workflow compressed test cycles from 3 days to 2 hours',
        'Migrated on-prem workflows to GCP fabric unifying 7 external aggregators with address standardization and deduplication, boosting hit ratio 45% and removing 93% of lookup latency at 10M+ records/day'
      ]
    }
  ].map(function(entry) {
    return Object.assign({}, entry, {
      bulletBudgets: entry.bullets.map(function(bullet) {
        return Math.max(9, Core.wordCount(bullet));
      })
    });
  });

  return {
    owner: {
      name: 'Tirth Shah',
      phone: '(979)~635-2045',
      email: 'tirth.shah@tamu.edu',
      linkedin: 'https://linkedin.com/in/tirth-chirayu-shah',
      website: 'https://tirthcshah.com',
      title: '',
      location: ''
    },
    education: [
      {
        institution: 'Texas A&M University',
        location: 'College Station, TX',
        degree: 'Master of Science in Management Information Systems',
        duration: 'Aug 2024 -- May 2026',
        gpa: '3.83/4.00'
      },
      {
        institution: 'Gujarat Technological University',
        location: 'Ahmedabad, India',
        degree: 'Bachelor of Engineering in Computer Engineering',
        duration: 'Jun 2017 -- May 2021',
        gpa: '3.95/4.00'
      }
    ],
    experiences: experiences,
    projects: [
      {
        title: 'Exploratory Data Analytics',
        description: 'Built Tableau and Excel visualizations translating complex sales and operations records into actionable findings, predicting revenue trends and targeting a 20% increase through storytelling for senior presentations',
        technologies: ['Tableau', 'Excel'],
        links: [
          { url: 'https://github.com/YOUR_LINK', label: 'GitHub' },
          { url: 'https://youtube.com/YOUR_LINK', label: 'Video' }
        ],
        wordBudget: 28
      },
      {
        title: 'Market Basket Analysis',
        description: 'Constructed an EC2 intelligence platform (MariaDB/MongoDB; SQL views/triggers/stored procedures) and applied ML modeling to expose customer spend patterns, improving efficiency 30% and lifting revenue 30% YoY',
        technologies: ['EC2', 'MariaDB', 'MongoDB', 'SQL', 'ML'],
        links: [
          { url: 'https://medium.com/YOUR_LINK', label: 'Article' }
        ],
        wordBudget: 28
      },
      {
        title: 'Document Classifier',
        description: 'Multi-modal AI classifier (Claude Haiku 3.5, Gemini Flash 2.0) categorizing 100+ regulatory documents at 98% precision across 4 sensitivity levels with PII detection, HITL review, and audit citations',
        technologies: ['Claude Haiku 3.5', 'Gemini Flash 2.0'],
        links: [
          { url: 'https://github.com/YOUR_LINK', label: 'GitHub' },
          { url: 'https://youtube.com/YOUR_LINK', label: 'Video' }
        ],
        wordBudget: 28
      }
    ],
    leadership: [
      'President, Buddy Connect: Led speaker panels & resume workshops, driving professional development & networking for 80 students',
      'IGSA: Coordinated 20+ cultural events reaching 10,000+ students, fostering cross-functional collaboration & community engagement'
    ],
    certifications: [
      'Microsoft Azure Associate [DP-203, AZ-104]',
      'Azure Fundamentals [DP-900, AI-900]',
      'Professional Scrum Master [PSM I]'
    ],
    skillsList: [
      'Python', 'SQL', 'TypeScript/JS', 'Java', 'Bash',
      'Tableau', 'Power BI', 'Excel', 'Databricks', 'Salesforce',
      'pandas', 'NumPy', 'scikit-learn', 'ETL/ELT pipelines', 'Snowflake',
      'GCP', 'AWS', 'Azure', 'Airflow', 'dbt', 'Docker', 'Postgres/MySQL/SQL Server'
    ]
  };
}

function buildResumeSource(portfolioBundle, session) {
  var base = buildCanonicalResumeTemplate();
  var keywords = buildResumeKeywords(session);
  return {
    owner: base.owner,
    education: base.education,
    experiences: base.experiences,
    projects: chooseResumeProjects(base.projects, keywords, 3),
    leadership: base.leadership,
    certifications: base.certifications,
    skillsList: base.skillsList,
    skills: normalizeResumeSkillString(chooseResumeSkills(base.skillsList, keywords, 20, 260).join(', '), 50),
    keywords: keywords
  };
}

function buildResumeSystemPrompt() {
  return [
    'You tailor ATS-safe resume bullet points for a specific job posting.',
    'Return ONLY valid JSON.',
    'Do not include markdown or commentary.',
    'Preserve the exact experience ordering, company names, role titles, duration labels, location labels, and bullet counts.',
    'Some experiences have exactly 2 bullets and some have exactly 3 bullets. Never add or remove bullets.',
    'Do not change the header, education, certifications, leadership, company names, role titles, dates, or locations.',
    'Only tailor the experience bullet text, the project descriptions, and the skills selection/order.',
    'Do not change project titles or project links.',
    'Every bullet must follow strong resume style: leading action verb, technical method or domain context, and business or quantifiable impact when the source supports it.',
    'Use the provided source bullets as the style anchor. Learn from their tone, density, and structure before changing anything.',
    'Be conservative. If a source bullet is already relevant or somewhat relevant, keep it unchanged.',
    'Silently decide KEEP or REWRITE for each source bullet before drafting.',
    'If a bullet already carries the right domain, business context, or keyword overlap, KEEP it.',
    'Only rewrite a bullet when the job context clearly justifies a stronger emphasis or keyword alignment.',
    'Each source bullet is provided with its original text, source word count, target word count, minimum acceptable word count, and hard max word count. Respect those limits literally.',
    'Treat sourceWordCount and targetWordCount as the intended length pattern. Keep every tailored bullet close to that length, never above maxWordCount, and almost never below minWordCount.',
    'Do not compress strong bullets into short generic one-liners. Preserve the original density, specificity, quantified impact, and pacing unless the source bullet is genuinely weak.',
    'Imitate the source bullet anatomy: action verb, technical/business context, then measurable impact or outcome. Do not collapse multi-part source bullets into thin summaries.',
    'Projects must remain one sentence, concise, and within the provided word budgets. Project references stay fixed.',
    'Skills must be chosen only from the provided skill inventory.',
    'Do not repeat the same opening action verb more than twice across all returned bullets.',
    'Never invent metrics, technologies, employers, titles, dates, or projects.',
    'Return exactly this shape:',
    '{"experiences":[{"company":"","bullets":[""]}],"projects":[{"title":"","description":""}],"skills":[""]}'
  ].join('\n');
}

function buildResumeUserPrompt(session, resumeSource) {
  return [
    'Tailor this resume for the job below.',
    'Header, education, certifications, leadership, dates, locations, company names, and role titles stay fixed outside this output.',
    'The output must preserve the exact number of bullets for every experience. If the source has 2 bullets, return 2. If the source has 3 bullets, return 3.',
    'If a source bullet is already ideal, relevant, or even somewhat relevant, keep it unchanged.',
    'Only use a rewrite when it creates a clearly better match to the target role without weakening the bullet.',
    'Rewrite only the bullets that truly need better alignment for this specific job.',
    'Use FAANG-style bullet quality: action verb first, then what was built or improved, then impact and quantification when grounded in the source.',
    'Do not let any bullet exceed its hard max word count.',
    'Treat targetWordCount as the intended length and minWordCount as the minimum acceptable density for a rewrite.',
    'Use the source bullet text itself as the pattern to imitate. Match its specificity, pacing, density, and sentence rhythm.',
    'If you rewrite a bullet, preserve the source bullet architecture: action verb -> scope/method -> outcome/impact.',
    'If a rewrite would become shorter but weaker, keep the original bullet unchanged.',
    'Do not add new metrics, dates, tools, project names, or company details.',
    'Project titles and references stay fixed; you may only rewrite project descriptions.',
    'Skills must be a subset of the provided inventory, reordered or trimmed to fit tightly, and should usually keep 15 to 20 skills when possible.',
    '',
    'Job context:',
    JSON.stringify({
      job: session.job || {},
      research: session.research || {},
      scrapePreview: session.scrape && session.scrape.preview || ''
    }),
    '',
    'Resume source:',
    JSON.stringify({
      experiences: resumeSource.experiences.map(function(entry) {
        return {
          company: entry.company,
          role: entry.role,
          duration: entry.duration,
          location: entry.location,
          bullets: entry.bullets.map(function(bullet, index) {
            var sourceWordCount = Core.wordCount(bullet);
            var maxWordCount = entry.bulletBudgets[index];
            return {
              sourceText: bullet,
              sourceWordCount: sourceWordCount,
              targetWordCount: sourceWordCount,
              minWordCount: Math.min(maxWordCount, Math.max(9, sourceWordCount - 4)),
              maxWordCount: maxWordCount,
              matchedKeywords: keywordMatchesForText(bullet, resumeSource.keywords, 6)
            };
          })
        };
      }),
      projects: resumeSource.projects.map(function(project) {
        var sourceWordCount = Core.wordCount(project.description);
        return {
          title: project.title,
          sourceDescription: project.description,
          sourceWordCount: sourceWordCount,
          targetWordCount: sourceWordCount,
          minWordCount: Math.min(project.wordBudget, Math.max(8, sourceWordCount - 3)),
          description: project.description,
          technologies: project.technologies,
          links: project.links,
          wordBudget: project.wordBudget,
          matchedKeywords: keywordMatchesForText([
            project.title,
            project.description,
            (project.technologies || []).join(' ')
          ].join(' '), resumeSource.keywords, 6)
        };
      }),
      skillsInventory: resumeSource.skillsList,
      targetKeywords: resumeSource.keywords
    })
  ].join('\n');
}

function scoreResumeSkill(skill, keywords) {
  var text = String(skill || '').trim().toLowerCase();
  if (!text) return 0;
  var score = 0;
  (keywords || []).forEach(function(keyword) {
    var key = String(keyword || '').trim().toLowerCase();
    if (!key) return;
    if (text === key) score += 8;
    else if (text.indexOf(key) !== -1 || key.indexOf(text) !== -1) score += 4;
  });
  return score;
}

function chooseResumeSkills(skillsList, keywords, maxCount, maxChars) {
  var list = dedupeStrings(skillsList || []);
  if (!list.length) return [];
  var ranked = list.map(function(skill, index) {
    return {
      skill: skill,
      index: index,
      score: scoreResumeSkill(skill, keywords)
    };
  }).sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  var selected = [];
  var used = {};
  var countLimit = Math.max(1, Math.min(Number(maxCount) || 18, list.length));
  var charLimit = Math.max(100, Number(maxChars) || 260);

  ranked.forEach(function(entry) {
    if (selected.length >= countLimit) return;
    var key = entry.skill.toLowerCase();
    if (used[key]) return;
    var next = selected.concat(entry.skill).join(', ');
    if (selected.length && next.length > charLimit) return;
    used[key] = true;
    selected.push(entry.skill);
  });

  if (!selected.length) {
    list.some(function(skill) {
      var next = selected.concat(skill).join(', ');
      if (selected.length && next.length > charLimit) return true;
      selected.push(skill);
      return selected.length >= countLimit;
    });
  }

  return selected;
}

function enforceResumeVerbDiversity(items, originals) {
  var counts = {};
  return items.map(function(text, index) {
    var current = String(text || '').trim();
    var verb = firstVerb(current);
    counts[verb] = (counts[verb] || 0) + 1;
    if (!verb || counts[verb] <= 2) return current;
    var fallback = String(originals[index] || '').trim();
    var fallbackVerb = firstVerb(fallback);
    if (fallback && fallbackVerb && (!counts[fallbackVerb] || counts[fallbackVerb] < 2)) {
      counts[verb]--;
      counts[fallbackVerb] = (counts[fallbackVerb] || 0) + 1;
      return fallback;
    }
    return current;
  });
}

function normalizeResumeComparisonText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\\[a-z]+/g, ' ')
    .replace(/[^a-z0-9+/%$.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resumeTextTokens(text) {
  return dedupeStrings(normalizeResumeComparisonText(text).split(' ')).filter(function(token) {
    return token && token.length > 2;
  });
}

function scoreResumeTextAgainstKeywords(text, keywords) {
  var haystack = ' ' + normalizeResumeComparisonText(text) + ' ';
  var seen = {};
  var score = 0;
  (keywords || []).forEach(function(keyword) {
    var key = normalizeResumeComparisonText(keyword);
    if (!key || seen[key]) return;
    seen[key] = true;
    if (haystack.indexOf(' ' + key + ' ') !== -1 || haystack.indexOf(key) !== -1) {
      score += key.length > 5 ? 3 : 1;
    }
  });
  return score;
}

function hasResumeImpactSignal(text) {
  return /(\d|%|\$|hrs?\.?|hours?|days?|months?|years?|x\b|mape|roi|latency|revenue|precision|accuracy)/i.test(String(text || ''));
}

function resumeTokenOverlapRatio(source, candidate) {
  var sourceTokens = resumeTextTokens(source);
  var candidateTokens = resumeTextTokens(candidate);
  if (!sourceTokens.length || !candidateTokens.length) return 0;
  var sourceSet = {};
  sourceTokens.forEach(function(token) {
    sourceSet[token] = true;
  });
  var shared = 0;
  candidateTokens.forEach(function(token) {
    if (sourceSet[token]) shared += 1;
  });
  return shared / Math.max(sourceTokens.length, candidateTokens.length);
}

function shouldPreserveResumeSourceText(sourceText, candidateText, keywords) {
  var source = String(sourceText || '').trim();
  var candidate = String(candidateText || '').trim();
  if (!source) return false;
  if (!candidate) return true;
  if (normalizeResumeComparisonText(source) === normalizeResumeComparisonText(candidate)) return true;

  var sourceScore = scoreResumeTextAgainstKeywords(source, keywords);
  var candidateScore = scoreResumeTextAgainstKeywords(candidate, keywords);
  var overlap = resumeTokenOverlapRatio(source, candidate);
  var sourceImpact = hasResumeImpactSignal(source);
  var candidateImpact = hasResumeImpactSignal(candidate);
  var candidateVerb = firstVerb(candidate);
  var sourceWords = Core.wordCount(source);
  var candidateWords = Core.wordCount(candidate);

  if (!candidateVerb) return true;
  if (candidateWords < Math.max(12, Math.floor(sourceWords * 0.72))) return true;
  if (overlap < 0.38) return true;
  if (sourceImpact && !candidateImpact && candidateScore <= sourceScore + 1) return true;
  if (sourceScore >= 2 && candidateScore <= sourceScore + 1) return true;
  if (sourceScore >= 1 && overlap >= 0.5 && candidateScore <= sourceScore + 1) return true;
  if (!sourceScore && candidateScore <= 1 && overlap >= 0.58) return true;
  return false;
}

function buildResumeModificationSummary(resumeSource, resumeData) {
  var baseSkills = splitSkillList(resumeSource && resumeSource.skills || '');
  var finalSkills = splitSkillList(resumeData && resumeData.skills || '');
  var baseSkillMap = {};
  var finalSkillMap = {};
  baseSkills.forEach(function(skill) {
    baseSkillMap[String(skill || '').trim().toLowerCase()] = String(skill || '').trim();
  });
  finalSkills.forEach(function(skill) {
    finalSkillMap[String(skill || '').trim().toLowerCase()] = String(skill || '').trim();
  });

  var summary = {
    modifiedExperienceTitles: [],
    modifiedExperienceCompanies: [],
    modifiedBulletCount: 0,
    experienceChanges: [],
    baseSkillsCount: baseSkills.length,
    finalSkillsCount: finalSkills.length,
    skillsCount: finalSkills.length,
    addedSkills: finalSkills.filter(function(skill) {
      return !baseSkillMap[String(skill || '').trim().toLowerCase()];
    }),
    removedSkills: baseSkills.filter(function(skill) {
      return !finalSkillMap[String(skill || '').trim().toLowerCase()];
    })
  };

  (resumeData && resumeData.experiences || []).forEach(function(entry, index) {
    var source = resumeSource.experiences[index] || {};
    var changed = 0;
    (entry.bullets || []).forEach(function(bullet, bulletIndex) {
      var sourceBullet = String(source.bullets && source.bullets[bulletIndex] || '').trim();
      if (normalizeResumeComparisonText(sourceBullet) !== normalizeResumeComparisonText(bullet)) changed += 1;
    });
    if (!changed) return;
    summary.modifiedBulletCount += changed;
    summary.modifiedExperienceTitles.push(entry.role || source.role || ('Experience ' + (index + 1)));
    summary.modifiedExperienceCompanies.push(entry.company || source.company || '');
    summary.experienceChanges.push({
      role: entry.role || source.role || '',
      company: entry.company || source.company || '',
      changedBulletCount: changed
    });
  });

  return summary;
}

function coerceResumeDraft(aiDraft, resumeSource) {
  var draft = aiDraft && typeof aiDraft === 'object' ? aiDraft : {};
  var normalizedExperiences = resumeSource.experiences.map(function(sourceExperience) {
    var matched = Array.isArray(draft.experiences) ? draft.experiences.find(function(entry) {
      return entry && String(entry.company || '').trim().toLowerCase() === sourceExperience.company.toLowerCase();
    }) : null;
    var bullets = Array.isArray(matched && matched.bullets) ? matched.bullets.map(function(item) {
      return String(item || '').trim();
    }).filter(Boolean) : [];
    while (bullets.length < sourceExperience.bullets.length) bullets.push(sourceExperience.bullets[bullets.length]);
    bullets = bullets.slice(0, sourceExperience.bullets.length).map(function(bullet, index) {
      var clipped = clipWords(bullet, sourceExperience.bulletBudgets[index]);
      if (shouldPreserveResumeSourceText(sourceExperience.bullets[index], clipped, resumeSource.keywords)) {
        return sourceExperience.bullets[index];
      }
      return clipped;
    });
    bullets = enforceResumeVerbDiversity(bullets, sourceExperience.bullets);
    return {
      company: sourceExperience.company,
      role: sourceExperience.role,
      duration: sourceExperience.duration,
      location: sourceExperience.location,
      bullets: bullets
    };
  });

  var normalizedProjects = resumeSource.projects.map(function(project) {
    var matched = Array.isArray(draft.projects) ? draft.projects.find(function(entry) {
      return entry && String(entry.title || '').trim().toLowerCase() === project.title.toLowerCase();
    }) : null;
    var description = String(matched && matched.description || project.description || '').trim() || project.description;
    if (shouldPreserveResumeSourceText(project.description, description, resumeSource.keywords)) {
      description = project.description;
    }
    return {
      title: project.title,
      description: clipWords(description, project.wordBudget),
      technologies: project.technologies,
      url: project.url,
      links: project.links
    };
  });

  var requestedSkills = Array.isArray(draft.skills) ? draft.skills : String(draft.skills || '').split(/[,\n]/);
  var allowedSkills = {};
  (resumeSource.skillsList || []).forEach(function(skill) {
    allowedSkills[String(skill || '').trim().toLowerCase()] = String(skill || '').trim();
  });
  var selectedSkills = [];
  requestedSkills.forEach(function(skill) {
    var key = String(skill || '').trim().toLowerCase();
    if (!key || !allowedSkills[key]) return;
    if (selectedSkills.indexOf(allowedSkills[key]) !== -1) return;
    selectedSkills.push(allowedSkills[key]);
  });
  if (!selectedSkills.length) {
    selectedSkills = chooseResumeSkills(resumeSource.skillsList, resumeSource.keywords, 20, 260);
  }

  return {
    owner: resumeSource.owner,
    education: resumeSource.education,
    experiences: normalizedExperiences,
    projects: normalizedProjects,
    leadership: resumeSource.leadership,
    certifications: resumeSource.certifications,
    skills: normalizeResumeSkillString(selectedSkills.slice(0, 20).join(', '), 50)
  };
}

function escapeLatexText(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u2248/g, 'approx. ')
    .replace(/\u200B/g, '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([{}%$#&_])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function resumeWebsiteHref(website) {
  var value = String(website || '').trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) return 'https://' + value;
  return value;
}

function escapeLatexHrefTarget(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u200B/g, '')
    .replace(/\\/g, '/')
    .replace(/([{}%#&_])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}');
}

function latexProjectTitle(project) {
  var base = escapeLatexText(project.title || '');
  var links = Array.isArray(project.links) ? project.links : [];
  if (!links.length) return base;
  var suffix = links.map(function(link) {
    var href = resumeWebsiteHref(link.url || '');
    if (!href) return '';
    return '\\href{' + escapeLatexHrefTarget(href) + '}{\\underline{' + escapeLatexText(link.label || 'Link') + '}}';
  }).filter(Boolean).join(' $|$ ');
  return suffix ? base + ' $|$ ' + suffix : base;
}

function formatResumeLeadershipLine(item) {
  var text = String(item || '').trim();
  if (!text) return '';
  var separator = text.indexOf(':') !== -1 ? ':' : (text.indexOf(' -- ') !== -1 ? ' -- ' : '');
  if (!separator) return escapeLatexText(text);
  var parts = text.split(separator);
  var label = parts.shift().trim();
  var detail = parts.join(separator).trim();
  if (!label || !detail) return escapeLatexText(text);
  return '\\textbf{' + escapeLatexText(label + ':') + '} ' + escapeLatexText(detail);
}

function buildResumePreviewText(resumeData) {
  var lines = [];
  var owner = resumeData.owner || {};
  lines.push(owner.name || 'Candidate');
  lines.push([owner.phone, owner.email, owner.website].filter(Boolean).join(' | '));
  lines.push('');
  lines.push('EDUCATION');
  (resumeData.education || []).forEach(function(entry) {
    var line = [entry.institution, entry.degree, entry.duration].filter(Boolean).join(' | ');
    lines.push(line);
  });
  lines.push('');
  lines.push('WORK EXPERIENCE');
  (resumeData.experiences || []).forEach(function(entry) {
    lines.push([entry.company, entry.role, entry.duration].filter(Boolean).join(' | '));
    (entry.bullets || []).forEach(function(bullet) {
      lines.push('- ' + bullet);
    });
    lines.push('');
  });
  lines.push('PROJECTS');
  (resumeData.projects || []).forEach(function(project) {
    lines.push(project.title + ': ' + project.description);
  });
  lines.push('');
  lines.push('TECHNICAL SKILLS');
  lines.push(resumeData.skills || '');
  if ((resumeData.certifications || []).length) {
    lines.push('');
    lines.push('CERTIFICATIONS');
    (resumeData.certifications || []).forEach(function(item) {
      lines.push('- ' + item);
    });
  }
  lines.push('');
  lines.push('LEADERSHIP & ACHIEVEMENTS');
  (resumeData.leadership || []).forEach(function(item) {
    lines.push('- ' + item);
  });
  return lines.join('\n').trim();
}

function buildResumeLatexSource(resumeData) {
  var experienceBlock = (resumeData.experiences || []).slice(0, 5).map(function(entry, entryIndex) {
    var bullets = (entry.bullets || []).map(function(bullet) {
      return '        \\resumeItem{' + escapeLatexText(bullet) + '}';
    }).join('\n');
    return [
      entryIndex ? '    \\entrygap' : '',
      '    \\resumeSubheading',
      '      {' + escapeLatexText(entry.company || '') + '}{' + escapeLatexText(entry.location || '') + '}',
      '      {' + escapeLatexText(entry.role || '') + '}{' + escapeLatexText(entry.duration || '') + '}',
      '      \\resumeItemListStart',
      bullets,
      '      \\resumeItemListEnd'
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  var projectBlock = (resumeData.projects || []).slice(0, 3).map(function(project) {
    return '    \\resumeProjectInline{' + latexProjectTitle(project) + '}{' + escapeLatexText(project.description || '') + '}';
  }).join('\n');

  return [
    '%-------------------------',
    '% Resume in LaTeX — Tirth Shah',
    '% One-page | 5 experiences | Times New Roman | flush left',
    '% Compatible with Overleaf (pdflatex)',
    '%-------------------------',
    '',
    '\\documentclass[letterpaper,10pt]{article}',
    '',
    '\\usepackage{latexsym}',
    '\\usepackage[empty]{fullpage}',
    '\\usepackage{titlesec}',
    '\\usepackage{marvosym}',
    '\\usepackage[usenames,dvipsnames]{color}',
    '\\usepackage{verbatim}',
    '\\usepackage{enumitem}',
    '\\usepackage[colorlinks=true, urlcolor=blue, linkcolor=black]{hyperref}',
    '\\usepackage{fancyhdr}',
    '\\usepackage[english]{babel}',
    '\\usepackage{tabularx}',
    '\\usepackage{mathptmx}',
    '\\IfFileExists{glyphtounicode.tex}{\\input{glyphtounicode}}{}',
    '',
    '%----------PAGE SETUP----------',
    '\\pagestyle{fancy}',
    '\\fancyhf{}',
    '\\fancyfoot{}',
    '\\renewcommand{\\headrulewidth}{0pt}',
    '\\renewcommand{\\footrulewidth}{0pt}',
    '\\setlength{\\footskip}{15pt}',
    '',
    '\\addtolength{\\oddsidemargin}{-0.65in}',
    '\\addtolength{\\evensidemargin}{-0.65in}',
    '\\addtolength{\\textwidth}{1.3in}',
    '\\addtolength{\\topmargin}{-0.65in}',
    '\\addtolength{\\textheight}{1.8in}',
    '',
    '\\urlstyle{same}',
    '\\raggedbottom',
    '\\raggedright',
    '\\setlength{\\tabcolsep}{0in}',
    '\\setlength{\\parskip}{0pt}',
    '\\setlength{\\parindent}{0pt}',
    '\\pdfgentounicode=1',
    '\\linespread{0.92}',
    '',
    '%----------SECTION FORMATTING----------',
    '\\titleformat{\\section}{',
    '  \\scshape\\raggedright\\large',
    '}{}{0em}{}[\\color{black}\\titlerule]',
    '\\titlespacing*{\\section}{0pt}{0pt}{3pt}',
    '',
    '%----------CUSTOM COMMANDS----------',
    '\\newcommand{\\resumeItem}[1]{%',
    '  \\item\\normalsize{#1}%',
    '}',
    '',
    '\\newcommand{\\entrygap}{\\vspace{1.5pt}}',
    '\\newcommand{\\eduentrygap}{\\vspace{0.5pt}}',
    '',
    '\\newcommand{\\resumeSubheading}[4]{%',
    '  \\item[]%',
    '    \\begin{tabular*}{\\linewidth}{@{}l@{\\extracolsep{\\fill}}r@{}}%',
    '      \\textbf{#1} & \\normalsize #2 \\\\[0pt]%',
    '      \\normalsize\\textit{#3} & \\normalsize\\textit{#4} \\\\[0pt]%',
    '    \\end{tabular*}%',
    '}',
    '',
    '\\newcommand{\\resumeProjectInline}[2]{%',
    '  \\item[]\\normalsize{\\textbf{#1}: #2}%',
    '}',
    '',
    '\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}',
    '',
    '\\newcommand{\\resumeSubHeadingListStart}{%',
    '  \\begin{itemize}[leftmargin=0pt, label={}, itemsep=0pt, parsep=0pt, topsep=0pt]%',
    '}',
    '\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}}',
    '',
    '\\newcommand{\\resumeItemListStart}{%',
    '  \\begin{itemize}[',
    '    leftmargin=14pt,',
    '    labelwidth=8pt,',
    '    labelsep=4pt,',
    '    itemindent=0pt,',
    '    listparindent=0pt,',
    '    label=\\textbullet,',
    '    topsep=1.5pt,',
    '    itemsep=0pt,',
    '    parsep=0pt',
    '  ]%',
    '}',
    '\\newcommand{\\resumeItemListEnd}{\\end{itemize}}',
    '',
    '\\newcommand{\\resumeProjectListStart}{%',
    '  \\begin{itemize}[leftmargin=0pt, label={}, topsep=0pt, itemsep=1.5pt, parsep=0pt]%',
    '}',
    '\\newcommand{\\resumeProjectListEnd}{\\end{itemize}}',
    '',
    '\\newcommand{\\sectiongap}{\\vspace{1.5pt}}',
    '',
    '%==========BEGIN DOCUMENT==========',
    '\\begin{document}',
    '',
    '%----------HEADER----------',
    '\\begin{center}',
    '    {\\Huge\\scshape Tirth Shah}\\\\[0pt]',
    '    \\mbox{\\fontsize{10}{12}\\selectfont (979)~635-2045}',
    '    ~$\\vert$~',
    '    \\mbox{\\fontsize{10}{12}\\selectfont \\href{mailto:tirth.shah@tamu.edu}{tirth.shah@tamu.edu}}',
    '    ~$\\vert$~',
    '    \\mbox{\\fontsize{10}{12}\\selectfont \\href{https://linkedin.com/in/tirth-chirayu-shah}{linkedin.com/in/tirth-chirayu-shah}}',
    '    ~$\\vert$~',
    '    \\mbox{\\fontsize{10}{12}\\selectfont \\href{https://tirthcshah.com}{tirthcshah.com}}',
    '\\end{center}',
    '\\vspace{-6pt}',
    '',
    '%-----------EDUCATION-----------',
    '\\section{Education}',
    '  \\resumeSubHeadingListStart',
    '    \\resumeSubheading',
    '      {Texas A\\&M University}{College Station, TX}',
    '      {Master of Science in Management Information Systems\\enspace--\\enspace\\textbf{GPA: 3.83/4.00}}{Aug 2024 -- May 2026}',
    '    \\eduentrygap',
    '    \\resumeSubheading',
    '      {Gujarat Technological University}{Ahmedabad, India}',
    '      {Bachelor of Engineering in Computer Engineering\\enspace--\\enspace\\textbf{GPA: 3.95/4.00}}{Jun 2017 -- May 2021}',
    '  \\resumeSubHeadingListEnd',
    '',
    '%-----------WORK EXPERIENCE-----------',
    '\\sectiongap',
    '\\section{Work Experience}',
    '  \\resumeSubHeadingListStart',
    experienceBlock || '    % No experience entries available',
    '  \\resumeSubHeadingListEnd',
    '',
    '%-----------PROJECTS-----------',
    '\\sectiongap',
    '\\section{Projects}',
    '  \\resumeProjectListStart',
    projectBlock || '    % No projects available',
    '  \\resumeProjectListEnd',
    '',
    '%-----------TECHNICAL SKILLS & CERTIFICATIONS-----------',
    '\\sectiongap',
    '\\section{Technical Skills \\& Certifications}',
    '\\vspace{2pt}',
    '\\noindent\\normalsize{%',
    '  \\textbf{Skills}: ' + escapeLatexText(resumeData.skills || '') + '\\\\[2pt]%',
    '  \\textbf{Certifications}: Microsoft Azure Associate [DP-203, AZ-104] $|$ Azure Fundamentals [DP-900, AI-900] $|$ Professional Scrum Master [PSM I]%',
    '}',
    '',
    '%-----------LEADERSHIP & ACHIEVEMENTS-----------',
    '\\sectiongap',
    '\\section{Leadership \\& Achievements}',
    '\\vspace{2pt}',
    '\\noindent\\normalsize{%',
    '  \\textbf{President, Buddy Connect:} Led speaker panels \\& resume workshops, driving professional development \\& networking for 80 students\\\\[2pt]',
    '  \\textbf{IGSA:} Coordinated 20+ cultural events reaching 10,000+ students, fostering cross-functional collaboration \\& community engagement%',
    '}',
    '\\end{document}'
  ].join('\n');
}

async function generateResumeArtifact(session, model, portfolioBundle) {
  var resumeSource = buildResumeSource(portfolioBundle, session);
  if (!resumeSource.owner.name || !resumeSource.experiences.length) {
    throw new Error('Your active portfolio does not have enough resume data yet. Import a fuller profile before generating a resume.');
  }

  var response = null;
  var resumeData = null;
  try {
    response = await aiChat(
      buildResumeSystemPrompt(),
      buildResumeUserPrompt(session, resumeSource),
      0.12,
      2200,
      model
    );
    resumeData = coerceResumeDraft(
      safeParseJson(response.content, 'CoverCraft could not parse the tailored resume output.'),
      resumeSource
    );
  } catch (_) {
    response = response || { model: model };
    resumeData = coerceResumeDraft({}, resumeSource);
  }

  var previewText = buildResumePreviewText(resumeData);
  var latexSource = buildResumeLatexSource(resumeData);
  var modifications = buildResumeModificationSummary(resumeSource, resumeData);
  return {
    data: resumeData,
    previewText: previewText,
    latexSource: latexSource,
    modifications: modifications,
    model: response.model || model,
    prompt: {
      system: buildResumeSystemPrompt(),
      user: buildResumeUserPrompt(session, resumeSource)
    }
  };
}

async function ensureSessionContext(state, session, payload, settings, persistState) {
  var persist = typeof persistState === 'function' ? persistState : null;
  var flow = payload && payload.flow || 'context';
  var needsExtract = !session.job || !session.job.jobTitle || !session.job.companyName || !!payload.forceRefresh;
  if (needsExtract) {
    setSessionPipeline(session, flow, 'extract', 'Step 2 · Extracting job details', '', 30, 'running');
    if (persist) await persist();
    var extract = await extractJobDetails(session.scrape.rawText, {
      titleHint: payload.titleHint || '',
      companyHint: payload.companyHint || '',
      pageTitle: payload.pageTitle || ''
    }, chooseExtractionModel(settings));
    session.job = extract.parsed;
    pushSessionActivity(session, {
      type: 'extract',
      createdAt: Core.nowIso(),
      model: extract.model,
      payload: extract
    });
    setSessionPipeline(session, flow, 'extract_done', 'Step 2 · Job details ready', '', payload.skipResearch ? 74 : 46, 'running');
    if (persist) await persist();
  } else {
    if (payload.titleHint) session.job.jobTitle = payload.titleHint;
    if (payload.companyHint) session.job.companyName = payload.companyHint;
  }

  var companyChanged = !session.research || !session.research.summary || !!payload.forceRefresh;
  if (payload.skipResearch) {
    session.updatedAt = Core.nowIso();
    return;
  }
  if (companyChanged && session.job.companyName) {
    setSessionPipeline(session, flow, 'research', 'Step 3 · Researching company', '', 64, 'running');
    if (persist) await persist();
    var cachedResearch = getCachedResearchForCompany(state, session.job.companyName, session.id);
    session.research = cachedResearch || await runCompanyResearch(session.job, settings);
    pushSessionActivity(session, {
      type: 'research',
      createdAt: Core.nowIso(),
      payload: session.research
    });
    setSessionPipeline(session, flow, 'research_done', 'Step 3 · Company research ready', '', 78, 'running');
    if (persist) await persist();
  }
  session.updatedAt = Core.nowIso();
}

function serializeSession(session) {
  var latestArtifact = (session.artifacts || [])[0] || null;
  var latestResume = (session.resumes || [])[0] || null;
  return Core.clone({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    title: Core.sessionTitle(session),
    page: session.page,
    scrape: {
      preview: session.scrape.preview,
      wordCount: session.scrape.wordCount,
      charCount: session.scrape.charCount
    },
    job: session.job,
    research: session.research,
    pipeline: session.pipeline || {},
    artifacts: session.artifacts || [],
    resumes: session.resumes || [],
    chat: session.chat || [],
    activities: session.activities || [],
    panel: session.panel || {},
    latestStyle: session.latestStyle || 'formal',
    latestModel: session.latestModel || '',
    latestArtifact: latestArtifact,
    latestResume: latestResume
  });
}

async function migrateLegacyLogsIfNeeded() {
  var data = await localGet([STORAGE_KEYS.migration, STORAGE_KEYS.legacyLogs, STORAGE_KEYS.sessions, STORAGE_KEYS.sessionOrder]);
  var migration = data[STORAGE_KEYS.migration] || {};
  if (migration.legacyMigrated) return;

  var legacyLogs = Array.isArray(data[STORAGE_KEYS.legacyLogs]) ? data[STORAGE_KEYS.legacyLogs] : [];
  var sessions = data[STORAGE_KEYS.sessions] || {};
  var order = data[STORAGE_KEYS.sessionOrder] || [];

  legacyLogs.slice().reverse().forEach(function(log) {
    if (log.kind !== 'pipeline' && log.kind !== 'extract') return;
    var rawText = (log.step1 && log.step1.fullText) || log.scrapePreview || '';
    var normalizedUrl = Core.normalizeUrl(log.url || '');
    var sessionId = 'legacy_' + (log.id || Core.shortHash((log.url || '') + '|' + (log.timestamp || '')));
    if (!sessions[sessionId]) {
      var session = Core.createEmptySession();
      session.id = sessionId;
      session.createdAt = log.timestamp || Core.nowIso();
      session.updatedAt = log.timestamp || Core.nowIso();
      session.page.url = log.url || '';
      session.page.normalizedUrl = normalizedUrl;
      session.page.lastSeenAt = log.timestamp || Core.nowIso();
      session.scrape.rawText = rawText;
      session.scrape.preview = rawText.slice(0, 500);
      session.scrape.hash = Core.shortHash(rawText);
      session.scrape.wordCount = Core.wordCount(rawText);
      session.scrape.charCount = rawText.length;
      session.job = log.step2 && log.step2.parsed ? log.step2.parsed : (log.result || session.job);
      session.research = log.step3 || session.research;
      session.latestStyle = log.style || 'formal';
      session.latestModel = log.model || DEFAULT_MODEL;
      if (log.output || (log.step4 && log.step4.rawResponse)) {
        session.artifacts.unshift({
          id: 'legacy_artifact_' + sessionId,
          createdAt: log.timestamp || Core.nowIso(),
          text: (log.step4 && log.step4.rawResponse) || log.output || '',
          style: log.style || 'formal',
          model: (log.step4 && log.step4.model) || log.model || DEFAULT_MODEL,
          owner: Core.ownerSnapshot(PORTFOLIO || {}),
          sessionId: sessionId,
          outputWords: log.step4 && log.step4.outputWords || Core.wordCount((log.step4 && log.step4.rawResponse) || log.output || ''),
          outputChars: log.step4 && log.step4.outputChars || String((log.step4 && log.step4.rawResponse) || log.output || '').length
        });
      }
      session.activities.unshift({
        type: log.kind,
        createdAt: log.timestamp || Core.nowIso(),
        payload: log
      });
      sessions[sessionId] = session;
      order.unshift(sessionId);
    }
  });

  var payload = {};
  payload[STORAGE_KEYS.sessions] = sessions;
  payload[STORAGE_KEYS.sessionOrder] = order;
  payload[STORAGE_KEYS.migration] = {
    legacyMigrated: true,
    migratedAt: Core.nowIso()
  };
  await localSet(payload);
}

async function importPortfolioFromResumeText(resumeText, sourceLabel) {
  if (!String(resumeText || '').trim()) {
    throw new Error('Could not read usable text from that file.');
  }

  var systemPrompt = [
    'Convert the provided resume text into a portfolio JSON object.',
    'Return ONLY valid JSON with these keys:',
    '{"name":"","phone":"","email":"","website":"","education":"","achievements":[],"experiences":[{"company":"","role":"","duration":"","highlights":[]}],"skills":"","certifications":[],"awards":[]}',
    'Do not invent facts. Use empty strings or empty arrays when data is missing.'
  ].join('\n');

  var userPrompt = [
    'Resume text:',
    String(resumeText).slice(0, 18000)
  ].join('\n');

  var response = await aiChat(systemPrompt, userPrompt, 0.15, 1800, DEFAULT_MODEL);
  var parsed = safeParseJson(response.content, 'CoverCraft could not build a valid portfolio JSON from the extracted resume text. Try extracting again or upload the JSON manually.');

  var validation = Core.normalizePortfolio(parsed);
  var payload = {};
  payload[STORAGE_KEYS.portfolioDraft] = {
    source: sourceLabel,
    createdAt: Core.nowIso(),
    portfolio: validation.normalized,
    errors: validation.errors,
    warnings: validation.warnings
  };
  await localSet(payload);
  return payload[STORAGE_KEYS.portfolioDraft];
}

async function importPortfolioFromImage(dataUrl) {
  if (!String(dataUrl || '').trim()) throw new Error('Image data missing.');

  var response = await aiChatMessages([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            'Read this resume image and convert it into a portfolio JSON object.',
            'Return ONLY valid JSON with keys:',
            '{"name":"","phone":"","email":"","website":"","education":"","achievements":[],"experiences":[{"company":"","role":"","duration":"","highlights":[]}],"skills":"","certifications":[],"awards":[]}',
            'Do not invent facts. Use empty strings or empty arrays when data is missing.'
          ].join('\n')
        },
        {
          type: 'image_url',
          image_url: { url: dataUrl }
        }
      ]
    }
  ], {
    temperature: 0.1,
    maxTokens: 1800,
    model: VISION_MODEL
  });

  var parsed = safeParseJson(response.content, 'CoverCraft could not build a valid portfolio JSON from the resume image. Try a cleaner image or upload a JSON file.');

  var validation = Core.normalizePortfolio(parsed);
  var payload = {};
  payload[STORAGE_KEYS.portfolioDraft] = {
    source: 'resume_image',
    createdAt: Core.nowIso(),
    portfolio: validation.normalized,
    errors: validation.errors,
    warnings: validation.warnings
  };
  await localSet(payload);
  return payload[STORAGE_KEYS.portfolioDraft];
}

chrome.runtime.onInstalled.addListener(function() {
  migrateLegacyLogsIfNeeded().catch(function(err) {
    console.error('[CoverCraft] migration failed', err);
  });
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
    return false;
  }

  if (message.type === 'OPEN_PROFILE') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#profile') });
    return false;
  }

  if (message.type === 'OPEN_SETTINGS') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#settings') });
    return false;
  }

  if (message.type === 'DOWNLOAD_PDF_DATA_URL') {
    chrome.downloads.download({
      url: message.payload && message.payload.dataUrl || '',
      filename: message.payload && message.payload.fileName || 'CoverCraft_Cover_Letter.pdf',
      saveAs: false
    }, function(downloadId) {
      if (chrome.runtime.lastError || !downloadId) {
        sendResponse({ error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Could not start the PDF download.' });
        return;
      }
      sendResponse({ ok: true, downloadId: downloadId });
    });
    return true;
  }

  if (message.type === 'DOWNLOAD_TEXT_FILE') {
    chrome.downloads.download({
      url: buildTextFileDataUrl(message.payload && message.payload.text || '', message.payload && message.payload.mimeType || 'text/plain'),
      filename: message.payload && message.payload.fileName || 'CoverCraft.txt',
      saveAs: false
    }, function(downloadId) {
      if (chrome.runtime.lastError || !downloadId) {
        sendResponse({ error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'Could not start the file download.' });
        return;
      }
      sendResponse({ ok: true, downloadId: downloadId });
    });
    return true;
  }

  if (message.type === 'GET_SETTINGS' || message.type === 'RELOAD_CONFIG') {
    Promise.all([loadSettings(), getPortfolioBundle(), getCloudStatus()]).then(function(results) {
      sendResponse({
        settings: results[0],
        portfolio: {
          source: results[1].source,
          owner: results[1].owner,
          warnings: results[1].validation.warnings,
          errors: results[1].validation.errors
        },
        cloud: results[2]
      });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_CLOUD_STATUS') {
    getCloudStatus().then(function(status) {
      sendResponse({ cloud: status });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'CLOUD_SIGN_IN') {
    queueMutation(async function() {
      if (await getPendingCloudAuthFlow()) throw new Error('Google sign-in is already in progress.');
      var flow = { startedAt: Core.nowIso(), method: 'chrome_identity' };
      await savePendingCloudAuthFlow(flow);
      await saveCloudMeta({ lastError: '', authStartedAt: flow.startedAt });
      try {
        var auth = await signInToCloudWithGoogle();
        await finalizeFirebaseAuth({ ok: true, auth: auth });
        await backupGuestLocalState();
        await syncSet({ cloudSyncEnabled: true });
        var remote = await getRemoteCloudState().catch(function() { return { app: null, sessions: [] }; });
        await mergeRemoteAppStateIntoLocal(remote.app || {}, { forcePortfolioReplace: true });
        await mergeRemoteSessionsIntoLocal(remote.sessions || []);
        var syncResult = await maybeSyncCloud('sign_in');
        if (!syncResult || syncResult.ok === false) throw new Error(syncResult && syncResult.error || 'Cloud sync failed after sign-in.');
        await clearPendingCloudAuthFlow();
        sendResponse({ ok: true, cloud: await getCloudStatus() });
      } catch (err) {
        await clearPendingCloudAuthFlow();
        await saveCloudMeta({ lastError: err.message || 'Google sign-in failed.' });
        sendResponse({ error: err.message, cloud: await getCloudStatus() });
      }
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'CLOUD_SIGN_OUT') {
    queueMutation(async function() {
      await restoreGuestLocalState();
      await clearCloudAuthSession();
      sendResponse({ ok: true, cloud: await getCloudStatus() });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'SYNC_CLOUD_NOW') {
    queueMutation(async function() {
      var remote = await getRemoteCloudState().catch(function() { return { app: null, sessions: [] }; });
      await mergeRemoteAppStateIntoLocal(remote.app || {});
      await mergeRemoteSessionsIntoLocal(remote.sessions || []);
      var result = await syncCloudState('manual_sync');
      sendResponse({ ok: true, result: result, cloud: await getCloudStatus() });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_PAGE_SESSION') {
    getSessionState().then(function(state) {
      var session = getLatestSessionForUrl(state, message.payload && message.payload.pageUrl);
      sendResponse({ session: session ? serializeSession(session) : null });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'UPSERT_PANEL_STATE') {
    queueMutation(async function() {
      var state = await getSessionState();
      var session = null;
      if (message.payload && message.payload.sessionId && state.sessions[message.payload.sessionId]) {
        session = state.sessions[message.payload.sessionId];
      } else if (message.payload && message.payload.pageUrl) {
        session = getLatestSessionForUrl(state, message.payload.pageUrl);
      }

      if (session) {
        session.panel = session.panel || {};
        Object.keys(message.payload.panel || {}).forEach(function(key) {
          session.panel[key] = message.payload.panel[key];
        });
        session.updatedAt = Core.nowIso();
        state.order = moveIdToFront(state.order, session.id);
        await saveSessionState(state);
        await maybeSyncCloud('panel_state');
        sendResponse({ ok: true, session: serializeSession(session) });
      } else {
        sendResponse({ ok: false });
      }
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'REFRESH_SESSION_CONTEXT') {
    var refreshState = null;
    var refreshSession = null;
    queueMutation(async function() {
      var settings = await loadSettings();
      var portfolioBundle = await getPortfolioBundle();
      var state = await getSessionState();
      refreshState = state;
      var session = ensureSessionBase(state, {
        pageUrl: message.payload.pageUrl,
        rawPageText: message.payload.rawPageText,
        pageTitle: message.payload.pageTitle,
        titleHint: message.payload.titleHint,
        companyHint: message.payload.companyHint,
        coverLetterType: message.payload.coverLetterType,
        model: sanitizeModelFromSettings(settings, message.payload.model)
      }, portfolioBundle.version);
      refreshSession = session;

      session.panel.open = true;
      session.panel.activeView = 'generate';
      await savePipelineState(state, session, 'refresh', 'extract', 'Step 2 · Extracting job details', '', 30, 'running');
      await ensureSessionContext(state, session, {
        pageTitle: message.payload.pageTitle,
        titleHint: message.payload.titleHint,
        companyHint: message.payload.companyHint,
        model: sanitizeModelFromSettings(settings, message.payload.model),
        forceRefresh: true,
        skipResearch: !message.payload.includeResearch,
        flow: 'refresh'
      }, settings, async function() {
        session.updatedAt = Core.nowIso();
        await saveSessionState(state);
        broadcastSessionUpdate(session);
      });
      clearSessionPipeline(session, 'refresh', message.payload.includeResearch ? 'Step 4 · Context ready' : 'Step 3 · Job details ready');
      await saveSessionState(state);
      broadcastSessionUpdate(session);
      await maybeSyncCloud('refresh_context');
      sendResponse({ session: serializeSession(session) });
    }).catch(function(err) {
      if (refreshSession && refreshState) {
        setSessionPipeline(refreshSession, 'refresh', 'error', 'Context refresh failed', err.message || '', 100, 'error');
        refreshSession.updatedAt = Core.nowIso();
        saveSessionState(refreshState).then(function() {
          broadcastSessionUpdate(refreshSession);
        }).catch(function() {});
      }
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'RUN_PIPELINE') {
    var pipelineState = null;
    var pipelineSession = null;
    queueMutation(async function() {
      var settings = await loadSettings();
      var portfolioBundle = await getPortfolioBundle();
      var model = sanitizeModelFromSettings(settings, message.payload.model);
      var style = message.payload.coverLetterType || settings.coverLetterType || 'formal';
      var state = await getSessionState();
      pipelineState = state;
      var session = ensureSessionBase(state, {
        pageUrl: message.payload.pageUrl,
        rawPageText: message.payload.rawPageText,
        pageTitle: message.payload.pageTitle,
        titleHint: message.payload.titleHint,
        companyHint: message.payload.companyHint,
        coverLetterType: style,
        model: model
      }, portfolioBundle.version);
      pipelineSession = session;

      session.panel.open = true;
      session.panel.activeView = 'generate';
      await savePipelineState(state, session, 'generate', 'extract', 'Step 2 · Extracting job details', '', 30, 'running');
      await ensureSessionContext(state, session, {
        pageTitle: message.payload.pageTitle,
        titleHint: message.payload.titleHint,
        companyHint: message.payload.companyHint,
        model: model,
        forceRefresh: false,
        flow: 'generate'
      }, settings, async function() {
        session.updatedAt = Core.nowIso();
        await saveSessionState(state);
        broadcastSessionUpdate(session);
      });

      await savePipelineState(state, session, 'generate', 'waiting_ai', 'Step 4 · Waiting for AI response', '', 88, 'running');
      var generated = await generateCoverLetter(session, style, model, portfolioBundle.portfolio);
      var artifact = {
        id: 'artifact_' + Core.shortHash(session.id + '|' + Core.nowIso() + '|' + generated.text),
        createdAt: Core.nowIso(),
        text: generated.text,
        style: style,
        model: generated.model,
        owner: portfolioBundle.owner,
        prompt: generated.prompt,
        sessionId: session.id,
        outputWords: Core.wordCount(generated.text),
        outputChars: generated.text.length
      };

      session.artifacts = Array.isArray(session.artifacts) ? session.artifacts : [];
      session.artifacts.unshift(artifact);
      session.artifacts = session.artifacts.slice(0, 20);
      session.latestStyle = style;
      session.latestModel = generated.model;
      clearSessionPipeline(session, 'generate', 'Step 5 · Cover letter ready');
      session.updatedAt = Core.nowIso();

      pushSessionActivity(session, {
        type: 'generate',
        createdAt: Core.nowIso(),
        payload: {
          artifactId: artifact.id,
          style: style,
          model: generated.model
        }
      });

      await saveSessionState(state);
      broadcastSessionUpdate(session);
      await maybeSyncCloud('generate');
      await appendLegacyLog({
        kind: 'pipeline',
        id: Date.now(),
        timestamp: Core.nowIso(),
        url: session.page.url,
        style: style,
        model: generated.model,
        step1: {
          fullText: session.scrape.rawText,
          preview: session.scrape.preview,
          wordCount: session.scrape.wordCount,
          charCount: session.scrape.charCount,
          titleHint: message.payload.titleHint || '',
          companyHint: message.payload.companyHint || ''
        },
        step2: {
          parsed: session.job
        },
        step3: session.research,
        step4: {
          rawResponse: artifact.text,
          outputWords: artifact.outputWords,
          outputChars: artifact.outputChars,
          model: artifact.model
        },
        output: artifact.text
      });

      sendResponse({
        session: serializeSession(session),
        coverLetter: artifact.text,
        artifact: artifact,
        owner: portfolioBundle.owner,
        extracted: session.job
      });
    }).catch(function(err) {
      if (pipelineSession && pipelineState) {
        setSessionPipeline(pipelineSession, 'generate', 'error', 'Cover letter generation failed', err.message || '', 100, 'error');
        pipelineSession.updatedAt = Core.nowIso();
        saveSessionState(pipelineState).then(function() {
          broadcastSessionUpdate(pipelineSession);
        }).catch(function() {});
      }
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'RUN_RESUME_PIPELINE') {
    var resumeState = null;
    var resumeSession = null;
    queueMutation(async function() {
      var settings = await loadSettings();
      var portfolioBundle = await getPortfolioBundle();
      var model = sanitizeModelFromSettings(settings, message.payload.model);
      var state = await getSessionState();
      resumeState = state;
      var session = ensureSessionBase(state, {
        pageUrl: message.payload.pageUrl,
        rawPageText: message.payload.rawPageText,
        pageTitle: message.payload.pageTitle,
        titleHint: message.payload.titleHint,
        companyHint: message.payload.companyHint,
        model: model
      }, portfolioBundle.version);
      resumeSession = session;

      session.panel.open = true;
      session.panel.activeView = 'resume';
      await savePipelineState(state, session, 'resume', 'extract', 'Step 2 · Extracting job details', '', 22, 'running');
      await ensureSessionContext(state, session, {
        pageTitle: message.payload.pageTitle,
        titleHint: message.payload.titleHint,
        companyHint: message.payload.companyHint,
        model: model,
        forceRefresh: false,
        flow: 'resume'
      }, settings, async function() {
        session.updatedAt = Core.nowIso();
        await saveSessionState(state);
        broadcastSessionUpdate(session);
      });

      await savePipelineState(state, session, 'resume', 'tailor_resume', 'Step 4 · Tailoring resume bullets', '', 78, 'running');
      var generatedResume = await generateResumeArtifact(session, model, portfolioBundle);
      await savePipelineState(state, session, 'resume', 'render_resume', 'Step 5 · Building resume output', '', 92, 'running');

      var resumeArtifact = {
        id: 'resume_' + Core.shortHash(session.id + '|' + Core.nowIso() + '|' + generatedResume.previewText),
        createdAt: Core.nowIso(),
        model: generatedResume.model,
        owner: portfolioBundle.owner,
        sessionId: session.id,
        jobTitle: session.job && session.job.jobTitle || '',
        company: session.job && session.job.companyName || '',
        previewText: generatedResume.previewText,
        latexSource: generatedResume.latexSource,
        data: generatedResume.data,
        modifications: generatedResume.modifications,
        prompt: generatedResume.prompt,
        outputWords: Core.wordCount(generatedResume.previewText),
        outputChars: generatedResume.previewText.length
      };

      session.resumes = Array.isArray(session.resumes) ? session.resumes : [];
      session.resumes.unshift(resumeArtifact);
      session.resumes = session.resumes.slice(0, 12);
      session.latestModel = generatedResume.model;
      clearSessionPipeline(session, 'resume', 'Step 6 · Resume ready');
      session.updatedAt = Core.nowIso();

      pushSessionActivity(session, {
        type: 'resume',
        createdAt: Core.nowIso(),
        payload: {
          resumeId: resumeArtifact.id,
          model: resumeArtifact.model,
          modifiedBulletCount: resumeArtifact.modifications && resumeArtifact.modifications.modifiedBulletCount || 0,
          modifiedExperienceTitles: resumeArtifact.modifications && resumeArtifact.modifications.modifiedExperienceTitles || []
        }
      });

      await saveSessionState(state);
      broadcastSessionUpdate(session);
      await maybeSyncCloud('resume');
      sendResponse({
        session: serializeSession(session),
        resume: resumeArtifact
      });
    }).catch(function(err) {
      if (resumeSession && resumeState) {
        setSessionPipeline(resumeSession, 'resume', 'error', 'Resume generation failed', err.message || '', 100, 'error');
        resumeSession.updatedAt = Core.nowIso();
        saveSessionState(resumeState).then(function() {
          broadcastSessionUpdate(resumeSession);
        }).catch(function() {});
      }
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'ASK_SESSION_QUESTION') {
    var askState = null;
    var askSession = null;
    queueMutation(async function() {
      var settings = await loadSettings();
      var portfolioBundle = await getPortfolioBundle();
      var state = await getSessionState();
      askState = state;
      var session = state.sessions[message.payload.sessionId];
      if (!session) throw new Error('Could not find the current session.');
      askSession = session;

      await savePipelineState(state, session, 'ask', 'prepare', 'Step 2 · Preparing session context', '', 30, 'running');
      await ensureSessionContext(state, session, {
        titleHint: session.job.jobTitle,
        companyHint: session.job.companyName,
        model: sanitizeModelFromSettings(settings, message.payload.model),
        forceRefresh: false,
        flow: 'ask'
      }, settings, async function() {
        session.updatedAt = Core.nowIso();
        await saveSessionState(state);
        broadcastSessionUpdate(session);
      });

      session.panel = session.panel || {};
      session.panel.activeView = 'ask';
      await savePipelineState(state, session, 'ask', 'waiting_ai', 'Step 4 · Waiting for AI response', '', 88, 'running');
      var answered = await answerQuestion(
        session,
        message.payload.question,
        sanitizeModelFromSettings(settings, message.payload.model),
        portfolioBundle.portfolio
      );

      session.chat = Array.isArray(session.chat) ? session.chat : [];
      session.chat.unshift({
        id: 'chat_' + Core.shortHash(session.id + '|' + Core.nowIso() + '|' + message.payload.question),
        createdAt: Core.nowIso(),
        question: message.payload.question,
        answer: answered.answer,
        model: answered.model
      });
      session.chat = session.chat.slice(0, 20);
      clearSessionPipeline(session, 'ask', 'Step 5 · Answer ready');
      session.updatedAt = Core.nowIso();

      pushSessionActivity(session, {
        type: 'chat',
        createdAt: Core.nowIso(),
        payload: {
          question: message.payload.question,
          answer: answered.answer,
          model: answered.model
        }
      });

      await saveSessionState(state);
      broadcastSessionUpdate(session);
      await maybeSyncCloud('chat');
      sendResponse({
        answer: answered.answer,
        session: serializeSession(session)
      });
    }).catch(function(err) {
      if (askSession && askState) {
        setSessionPipeline(askSession, 'ask', 'error', 'Answer generation failed', err.message || '', 100, 'error');
        askSession.updatedAt = Core.nowIso();
        saveSessionState(askState).then(function() {
          broadcastSessionUpdate(askSession);
        }).catch(function() {});
      }
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_DASHBOARD_DATA') {
    Promise.all([getSessionState(), getPortfolioBundle()]).then(function(results) {
      var state = results[0];
      var sessions = state.order.map(function(id) {
        return state.sessions[id];
      }).filter(Boolean).map(serializeSession);
      sendResponse({
        sessions: sessions,
        portfolio: {
          source: results[1].source,
          owner: results[1].owner
        }
      });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'CLEAR_ALL_DATA') {
    localSet((function() {
      var payload = {};
      payload[STORAGE_KEYS.sessions] = {};
      payload[STORAGE_KEYS.sessionOrder] = [];
      payload[STORAGE_KEYS.legacyLogs] = [];
      return payload;
    })()).then(async function() {
      try { await clearCloudSessions(); } catch (_) {}
      sendResponse({ ok: true });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

if (message.type === 'GET_ACTIVE_PORTFOLIO') {
    Promise.all([getPortfolioBundle(), localGet([STORAGE_KEYS.portfolioDraft])]).then(function(results) {
      sendResponse({
        portfolio: results[0].rawPortfolio,
        source: results[0].source,
        validation: results[0].validation,
        draft: results[1][STORAGE_KEYS.portfolioDraft] || null
      });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'SAVE_ACTIVE_PORTFOLIO') {
    var validation = Core.normalizePortfolio(message.payload.portfolio || {});
    var payload = {};
    payload[STORAGE_KEYS.activePortfolio] = message.payload.portfolio || {};
    payload[STORAGE_KEYS.activePortfolioSource] = message.payload.source || 'imported';
    payload[STORAGE_KEYS.portfolioDraft] = null;
    localSet(payload).then(async function() {
      await maybeSyncCloud('portfolio_save');
      sendResponse({
        ok: validation.ok,
        validation: validation
      });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'IMPORT_PORTFOLIO_JSON') {
    try {
      var parsed = safeParseJson(message.payload && message.payload.text, 'Invalid JSON file.');
      var jsonValidation = Core.normalizePortfolio(parsed);
      var draftPayload = {};
      draftPayload[STORAGE_KEYS.portfolioDraft] = {
        source: 'portfolio_json',
        createdAt: Core.nowIso(),
        portfolio: parsed,
        errors: jsonValidation.errors,
        warnings: jsonValidation.warnings
      };
      localSet(draftPayload).then(function() {
        sendResponse({ draft: draftPayload[STORAGE_KEYS.portfolioDraft] });
      });
    } catch (err) {
      sendResponse({ error: 'Invalid JSON file.' });
    }
    return true;
  }

  if (message.type === 'CLEAR_PORTFOLIO_DRAFT') {
    var clearPayload = {};
    clearPayload[STORAGE_KEYS.portfolioDraft] = null;
    localSet(clearPayload).then(function() {
      sendResponse({ ok: true });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'IMPORT_PORTFOLIO_TEXT') {
    importPortfolioFromResumeText(message.payload.text, message.payload.source || 'resume_text').then(function(draft) {
      sendResponse({ draft: draft });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'IMPORT_PORTFOLIO_IMAGE') {
    importPortfolioFromImage(message.payload.dataUrl).then(function(draft) {
      sendResponse({ draft: draft });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  return false;
});
