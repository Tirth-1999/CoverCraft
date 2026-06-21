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
var FAST_OPENAI_EXTRACT_MODEL = 'openai/gpt-5-nano';
var ALLOWED_FREE_MODELS = Core.KNOWN_MODELS.filter(function(model) { return model.indexOf('groq/') !== 0; });
var GROQ_MODELS = Core.KNOWN_MODELS.filter(function(model) { return model.indexOf('groq/') === 0; });
var DISABLED_MODELS = [];
var GROQ_TPM_LIMITS = {
  'llama-3.1-8b-instant': 6000,
  'qwen/qwen3-32b': 6000,
  'openai/gpt-oss-120b': 8000,
  'openai/gpt-oss-20b': 8000,
  'llama-3.3-70b-versatile': 12000,
  'meta-llama/llama-4-scout-17b-16e-instruct': 30000,
  'groq/compound': 70000,
  'groq/compound-mini': 70000
};
var MAX_LEGACY_LOGS = 200;
var mutationQueue = Promise.resolve();
var CLOUD_AUTH_STORAGE_KEY = 'covercraft_cloud_auth_v1';
var CLOUD_META_STORAGE_KEY = 'covercraft_cloud_meta_v1';
var CLOUD_AUTH_FLOW_STORAGE_KEY = 'covercraft_cloud_auth_flow_v1';
var GUEST_SESSIONS_BACKUP_KEY = 'covercraft_guest_sessions_backup_v1';
var GUEST_PORTFOLIO_BACKUP_KEY = 'covercraft_guest_portfolio_backup_v1';
var MODEL_HEALTH_STORAGE_KEY = 'covercraft_model_health_v1';
var MODEL_USAGE_LOG_STORAGE_KEY = 'covercraft_model_usage_log_v1';
var MAX_MODEL_USAGE_LOGS = 500;
var MAX_SESSION_SYNC_WRITES = 25;
var MAX_MODEL_USAGE_SYNC_WRITES = 50;
var FIREBASE_CONFIG = typeof COVERCRAFT_FIREBASE === 'object' && COVERCRAFT_FIREBASE ? COVERCRAFT_FIREBASE : {};
var PROVIDER_KEY_NAMES = ['openrouterKey', 'openaiKey', 'groqKey', 'tavilyKey'];
var PRODUCTION_EXTENSION_ID = 'apnbkjkgobikeejmfjgnmbflonmbgffg';
var CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/detail/' + PRODUCTION_EXTENSION_ID;

var DEFAULT_SETTINGS = {
  openrouterKey: COVERCRAFT_CONFIG && COVERCRAFT_CONFIG.openrouterKey || '',
  openaiKey: COVERCRAFT_CONFIG && COVERCRAFT_CONFIG.openaiKey || '',
  groqKey: COVERCRAFT_CONFIG && COVERCRAFT_CONFIG.groqKey || '',
  tavilyKey: COVERCRAFT_CONFIG && COVERCRAFT_CONFIG.tavilyKey || '',
  model: DEFAULT_MODEL,
  customModel: '',
  coverLetterType: 'formal',
  resumeFormat: 'auto',
  triggerMode: 'manual',
  cloudSyncEnabled: true
};
var MODEL_HEALTH_CACHE = {};
var MODEL_USAGE_LOG_CACHE = [];
var STORAGE_STATUS_PROBE_KEY = 'covercraft_storage_probe_v1';

if (chrome.storage.local && typeof chrome.storage.local.setAccessLevel === 'function') {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }, function() {
    void chrome.runtime.lastError;
  });
}

function modelHealthKey(model) {
  return String(model || '').trim() || DEFAULT_MODEL;
}

function modelHealthAliases(model, apiModel) {
  var raw = String(model || '').trim();
  var api = String(apiModel || '').trim();
  var values = [raw, api];
  if (raw && raw.indexOf('groq/') !== 0 && GROQ_MODELS.indexOf('groq/' + raw) !== -1) values.push('groq/' + raw);
  if (api && api.indexOf('groq/') !== 0 && GROQ_MODELS.indexOf('groq/' + api) !== -1) values.push('groq/' + api);
  if (raw.indexOf('groq/') === 0) values.push(raw.replace(/^groq\//, ''));
  if (api.indexOf('groq/') === 0) values.push(api.replace(/^groq\//, ''));
  var seen = {};
  return values.map(modelHealthKey).filter(function(value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function parseProviderSeconds(value) {
  var text = String(value || '').trim();
  if (!text) return 0;
  var total = 0;
  var match;
  var re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)?/gi;
  while ((match = re.exec(text))) {
    var amount = Number(match[1]) || 0;
    var unit = String(match[2] || 's').toLowerCase();
    if (unit === 'ms') total += amount / 1000;
    else if (unit === 'm') total += amount * 60;
    else if (unit === 'h') total += amount * 3600;
    else total += amount;
  }
  return total;
}

function providerLimitKind(message, rate) {
  var text = String(message || '').toLowerCase();
  rate = rate || {};
  if (/tokens per day|daily token|daily.*token|token.*daily|tpd/.test(text)) return 'daily_tokens';
  if (/requests per day|daily request|daily.*request|request.*daily|rpd/.test(text)) return 'daily_requests';
  if (/tokens per minute|tpm/.test(text)) return 'minute_tokens';
  if (/requests per minute|rpm/.test(text)) return 'minute_requests';
  if (Core.numericHeaderValue(rate.remainingTokens) === 0 && Core.numericHeaderValue(rate.limitTokens) > 0) return 'minute_tokens';
  if (Core.numericHeaderValue(rate.remainingRequests) === 0 && Core.numericHeaderValue(rate.limitRequests) > 0) return 'minute_requests';
  return '';
}

async function rememberModelHealth(model, info) {
  var key = modelHealthKey(model);
  var rate = info && info.rateLimit || {};
  var limitKind = info && info.limitKind || providerLimitKind(info && info.error, rate);
  var resetSeconds = Math.max(parseProviderSeconds(rate.retryAfter), parseProviderSeconds(rate.resetTokens));
  if ((limitKind === 'daily_tokens' || limitKind === 'daily_requests') && !resetSeconds) resetSeconds = parseProviderSeconds(rate.resetRequests);
  if (limitKind === 'daily_tokens' || limitKind === 'daily_requests') resetSeconds = Math.max(resetSeconds, 24 * 60 * 60);
  var checkedAt = Date.now();
  var entry = {
    model: key,
    apiModel: info && info.apiModel || key,
    provider: info && info.provider || Core.providerForModel(key),
    ok: !!(info && info.ok),
    status: info && info.status || 0,
    error: info && info.error || '',
    rateLimit: rate,
    limitKind: limitKind,
    estimatedTokens: info && info.estimatedTokens || 0,
    inputTokens: info && info.inputTokens || 0,
    outputTokens: info && info.outputTokens || 0,
    totalTokens: info && info.totalTokens || 0,
    estimatedInputTokens: info && info.estimatedInputTokens || 0,
    estimatedOutputTokens: info && info.estimatedOutputTokens || 0,
    requestedOutputTokens: info && info.requestedOutputTokens || 0,
    modelUsageTokens: info && info.modelUsageTokens || 0,
    modelTokenLimit: info && info.modelTokenLimit || null,
    modelUsagePercent: info && info.modelUsagePercent != null ? info.modelUsagePercent : null,
    usageSource: info && info.usageSource || 'estimate',
    checkedAt: checkedAt,
    blockedUntil: resetSeconds ? checkedAt + Math.ceil(resetSeconds * 1000) : 0
  };
  modelHealthAliases(key, entry.apiModel).forEach(function(alias) {
    MODEL_HEALTH_CACHE[alias] = Object.assign({}, entry, { model: alias });
  });
  await appendModelUsageLog(key, info, checkedAt, entry.blockedUntil);
  await localSet((function() {
    var update = {};
    update[MODEL_HEALTH_STORAGE_KEY] = MODEL_HEALTH_CACHE;
    return update;
  })());
  broadcastModelHealthUpdate();
}

async function appendModelUsageLog(model, info, checkedAt, blockedUntil) {
  var entry = {
    id: String(checkedAt) + '-' + Math.random().toString(36).slice(2, 8),
    model: model,
    apiModel: info && info.apiModel || model,
    provider: info && info.provider || Core.providerForModel(model),
    ok: !!(info && info.ok),
    status: info && info.status || 0,
    error: info && info.error || '',
    rateLimit: info && info.rateLimit || {},
    estimatedTokens: info && info.estimatedTokens || 0,
    estimatedInputTokens: info && info.estimatedInputTokens || 0,
    estimatedOutputTokens: info && info.estimatedOutputTokens || 0,
    requestedOutputTokens: info && info.requestedOutputTokens || 0,
    modelUsageTokens: info && info.modelUsageTokens || 0,
    modelTokenLimit: info && info.modelTokenLimit || null,
    modelUsagePercent: info && info.modelUsagePercent != null ? info.modelUsagePercent : null,
    usageSource: info && info.usageSource || 'estimate',
    inputTokens: info && info.inputTokens || 0,
    outputTokens: info && info.outputTokens || 0,
    totalTokens: info && info.totalTokens || 0,
    checkedAt: checkedAt,
    timestamp: new Date(checkedAt).toISOString(),
    blockedUntil: blockedUntil || 0
  };
  var data = await localGet(MODEL_USAGE_LOG_STORAGE_KEY);
  var stored = data && data[MODEL_USAGE_LOG_STORAGE_KEY];
  var logs = Array.isArray(stored) ? stored : MODEL_USAGE_LOG_CACHE;
  logs = logs.concat(entry).slice(-MAX_MODEL_USAGE_LOGS);
  MODEL_USAGE_LOG_CACHE = logs;
  var update = {};
  update[MODEL_USAGE_LOG_STORAGE_KEY] = logs;
  await localSet(update);
  return entry;
}

function getModelHealthSummary() {
  var out = {};
  Object.keys(MODEL_HEALTH_CACHE).forEach(function(key) {
    var item = MODEL_HEALTH_CACHE[key];
    if (!item) return;
    out[key] = {
      model: item.model,
      apiModel: item.apiModel,
      provider: item.provider,
      ok: item.ok,
      status: item.status,
      error: item.error,
      rateLimit: item.rateLimit || {},
      limitKind: item.limitKind || '',
      estimatedTokens: item.estimatedTokens || 0,
      estimatedInputTokens: item.estimatedInputTokens || 0,
      estimatedOutputTokens: item.estimatedOutputTokens || 0,
      requestedOutputTokens: item.requestedOutputTokens || 0,
      modelUsageTokens: item.modelUsageTokens || 0,
      modelTokenLimit: item.modelTokenLimit || null,
      modelUsagePercent: item.modelUsagePercent != null ? item.modelUsagePercent : null,
      usageSource: item.usageSource || 'estimate',
      inputTokens: item.inputTokens || 0,
      outputTokens: item.outputTokens || 0,
      totalTokens: item.totalTokens || 0,
      checkedAt: item.checkedAt || 0,
      blockedUntil: item.blockedUntil || 0
    };
  });
  return out;
}

function rebuildModelHealthFromUsageLogs(logs) {
  (logs || []).forEach(function(entry) {
    if (!entry || !entry.model) return;
    var health = {
      model: entry.model,
      apiModel: entry.apiModel || entry.model,
      provider: entry.provider || Core.providerForModel(entry.model),
      ok: !!entry.ok,
      status: entry.status || 0,
      error: entry.error || '',
      rateLimit: entry.rateLimit || {},
      limitKind: entry.limitKind || '',
      estimatedTokens: entry.estimatedTokens || 0,
      estimatedInputTokens: entry.estimatedInputTokens || 0,
      estimatedOutputTokens: entry.estimatedOutputTokens || 0,
      requestedOutputTokens: entry.requestedOutputTokens || 0,
      modelUsageTokens: entry.modelUsageTokens || 0,
      modelTokenLimit: entry.modelTokenLimit || null,
      modelUsagePercent: entry.modelUsagePercent != null ? entry.modelUsagePercent : null,
      usageSource: entry.usageSource || 'estimate',
      inputTokens: entry.inputTokens || 0,
      outputTokens: entry.outputTokens || 0,
      totalTokens: entry.totalTokens || 0,
      checkedAt: entry.checkedAt || 0,
      blockedUntil: entry.blockedUntil || 0
    };
    modelHealthAliases(entry.model, entry.apiModel).forEach(function(alias) {
      var existing = MODEL_HEALTH_CACHE[alias];
      if (!existing || Number(health.checkedAt || 0) >= Number(existing.checkedAt || 0)) {
        MODEL_HEALTH_CACHE[alias] = Object.assign({}, health, { model: alias });
      }
    });
  });
}

function broadcastModelHealthUpdate() {
  var message = {
    type: 'MODEL_HEALTH_UPDATE',
    modelHealth: getModelHealthSummary(),
    modelUsageLog: MODEL_USAGE_LOG_CACHE.slice(-MAX_MODEL_USAGE_LOGS)
  };
  try {
    chrome.runtime.sendMessage(message, function() {
      void chrome.runtime.lastError;
    });
  } catch (_) {}
  try {
    chrome.tabs.query({}, function(tabs) {
      (tabs || []).forEach(function(tab) {
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, message, function() {
          void chrome.runtime.lastError;
        });
      });
    });
  } catch (_) {}
}

function localGet(keys) {
  return new Promise(function(resolve, reject) {
    chrome.storage.local.get(keys, function(data) {
      if (chrome.runtime.lastError) {
        var error = new Error(chrome.runtime.lastError.message || 'Could not read local storage.');
        error.provider = 'chrome_storage';
        reject(error);
        return;
      }
      resolve(data || {});
    });
  });
}

function storageByteLength(value) {
  try {
    return new Blob([JSON.stringify(value || {})]).size;
  } catch (_) {
    return JSON.stringify(value || {}).length;
  }
}

function rawLocalSet(obj) {
  return new Promise(function(resolve, reject) {
    chrome.storage.local.set(obj, function() {
      if (chrome.runtime.lastError) {
        var error = new Error(chrome.runtime.lastError.message || 'Could not write local storage.');
        error.provider = 'chrome_storage';
        error.attemptedBytes = storageByteLength(obj);
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function isChromeStorageQuotaError(err) {
  return !!(err && err.provider === 'chrome_storage' && /quota|exceeded|max.*bytes|storage/i.test(String(err.message || '')));
}

async function compactLocalStorageForQuota() {
  await localRemove([STORAGE_KEYS.legacyLogs, GUEST_SESSIONS_BACKUP_KEY, GUEST_PORTFOLIO_BACKUP_KEY]).catch(function() {});
  var data = await localGet([MODEL_USAGE_LOG_STORAGE_KEY]);
  var logs = Array.isArray(data[MODEL_USAGE_LOG_STORAGE_KEY]) ? data[MODEL_USAGE_LOG_STORAGE_KEY] : MODEL_USAGE_LOG_CACHE;
  if (logs.length > 120) {
    MODEL_USAGE_LOG_CACHE = logs.slice(-120);
    var update = {};
    update[MODEL_USAGE_LOG_STORAGE_KEY] = MODEL_USAGE_LOG_CACHE;
    await rawLocalSet(update).catch(function() {});
  }
}

async function localSet(obj) {
  try {
    await rawLocalSet(obj);
  } catch (err) {
    if (!isChromeStorageQuotaError(err)) throw err;
    await compactLocalStorageForQuota();
    try {
      await rawLocalSet(obj);
    } catch (retryErr) {
      if (!retryErr.provider) retryErr.provider = 'chrome_storage';
      retryErr.storageStatus = await getExtensionStorageStatus().catch(function() { return null; });
      throw retryErr;
    }
  }
}

function localRemove(keys) {
  return new Promise(function(resolve, reject) {
    chrome.storage.local.remove(keys, function() {
      if (chrome.runtime.lastError) {
        var error = new Error(chrome.runtime.lastError.message || 'Could not remove local storage.');
        error.provider = 'chrome_storage';
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function getExtensionStorageStatus() {
  var data = await localGet(null);
  var usedBytes = storageByteLength(data);
  var permissions = chrome.runtime.getManifest && chrome.runtime.getManifest().permissions || [];
  var hasUnlimitedStorage = permissions.indexOf('unlimitedStorage') !== -1;
  var quotaBytes = Number(chrome.storage.local && chrome.storage.local.QUOTA_BYTES || 0) || 0;
  var writable = false;
  var writeError = '';
  try {
    var probe = {};
    probe[STORAGE_STATUS_PROBE_KEY] = { checkedAt: Core.nowIso(), value: Math.random().toString(36).slice(2) };
    await rawLocalSet(probe);
    await localRemove(STORAGE_STATUS_PROBE_KEY);
    writable = true;
  } catch (err) {
    writeError = err && err.message || 'Storage write probe failed.';
  }
  var percentUsed = quotaBytes ? Math.round((usedBytes / quotaBytes) * 1000) / 10 : null;
  var state = !writable ? 'blocked' : (percentUsed != null && percentUsed >= 95 ? 'full' : (percentUsed != null && percentUsed >= 80 ? 'warning' : 'ok'));
  return {
    state: state,
    writable: writable,
    writeError: writeError,
    usedBytes: usedBytes,
    quotaBytes: quotaBytes,
    percentUsed: percentUsed,
    hasUnlimitedStorage: hasUnlimitedStorage
  };
}

function formatBytes(bytes) {
  var value = Number(bytes || 0);
  if (value >= 1024 * 1024) return (Math.round((value / 1024 / 1024) * 10) / 10) + ' MB';
  if (value >= 1024) return (Math.round((value / 1024) * 10) / 10) + ' KB';
  return value + ' B';
}

function describeStorageStatus(status) {
  if (!status) return 'Storage status could not be checked.';
  var parts = ['Extension local storage: ' + formatBytes(status.usedBytes) + (status.quotaBytes ? ' of ' + formatBytes(status.quotaBytes) : '')];
  if (status.percentUsed != null) parts.push(status.percentUsed + '% used');
  parts.push(status.hasUnlimitedStorage ? 'unlimitedStorage permission is enabled' : 'unlimitedStorage permission is not enabled');
  parts.push(status.writable ? 'write probe passed' : 'write probe failed' + (status.writeError ? ': ' + status.writeError : ''));
  return parts.join(', ') + '.';
}

function syncGet(keys) {
  return new Promise(function(resolve) {
    chrome.storage.sync.get(keys, function(data) {
      resolve(data || {});
    });
  });
}

function syncSet(obj) {
  return new Promise(function(resolve, reject) {
    chrome.storage.sync.set(obj, function() {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Could not write sync storage.'));
        return;
      }
      resolve();
    });
  });
}

function syncRemove(keys) {
  return new Promise(function(resolve, reject) {
    chrome.storage.sync.remove(keys, function() {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Could not remove sync storage values.'));
        return;
      }
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

function getInstallationInfo() {
  var extensionId = String(chrome.runtime.id || '');
  var official = extensionId === PRODUCTION_EXTENSION_ID;
  return {
    mode: official ? 'official' : 'local',
    official: official,
    extensionId: extensionId,
    productionExtensionId: PRODUCTION_EXTENSION_ID,
    storeUrl: CHROME_WEB_STORE_URL,
    cloudAvailable: official
  };
}

function localInstallCloudError() {
  return 'Google sign-in and Firebase sync are available only in the official Chrome Web Store installation. This local ZIP installation still supports BYOK generation, local sessions, profile import, and exports.';
}

function requireOfficialInstallation() {
  if (getInstallationInfo().official) return;
  var error = new Error(localInstallCloudError());
  error.code = 'LOCAL_INSTALL';
  throw error;
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
  if (!auth) {
    await localRemove(CLOUD_AUTH_STORAGE_KEY);
    return;
  }
  var payload = {};
  payload[CLOUD_AUTH_STORAGE_KEY] = auth;
  await localSet(payload);
}

async function saveCloudMeta(meta) {
  var current = await getCloudAuthSession();
  var payload = {};
  payload[CLOUD_META_STORAGE_KEY] = Object.assign({}, current.meta || {}, meta || {});
  await localSet(payload);
}

async function clearCloudAuthSession() {
  await localRemove(CLOUD_AUTH_STORAGE_KEY);
  var payload = {};
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
  if (!flow) {
    await localRemove(CLOUD_AUTH_FLOW_STORAGE_KEY);
    return;
  }
  var payload = {};
  payload[CLOUD_AUTH_FLOW_STORAGE_KEY] = flow;
  await localSet(payload);
}

async function clearPendingCloudAuthFlow() {
  await localRemove(CLOUD_AUTH_FLOW_STORAGE_KEY);
}

function syncableSettings(settings) {
	  return {
	    model: settings.model || DEFAULT_MODEL,
	    coverLetterType: settings.coverLetterType || 'formal',
	    resumeFormat: settings.resumeFormat || 'auto',
	    triggerMode: settings.triggerMode || 'manual',
    cloudSyncEnabled: resolveCloudSyncEnabled(settings && settings.cloudSyncEnabled)
  };
}

function settingsWithoutProviderSecrets(settings) {
	  return Object.assign({}, settings, {
	    openrouterKey: settings.openrouterKey ? 'configured' : '',
	    openaiKey: settings.openaiKey ? 'configured' : '',
	    groqKey: settings.groqKey ? 'configured' : '',
    tavilyKey: settings.tavilyKey ? 'configured' : ''
  });
}

function senderCanReadProviderSecrets(sender) {
  var senderUrl = String(sender && sender.url || '');
  return senderUrl.indexOf(chrome.runtime.getURL('src/options/')) === 0 ||
    senderUrl.indexOf(chrome.runtime.getURL('src/dashboard/')) === 0;
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
  requireOfficialInstallation();
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
    var error = new Error(data.error && data.error.message || ('Firestore HTTP ' + response.status));
    error.status = response.status;
    error.code = data.error && (data.error.status || data.error.code) || '';
    error.details = data.error && data.error.details || [];
    error.method = method;
    error.path = path;
    error.provider = 'firestore';
    error.retryAfter = response.headers.get('retry-after') || '';
    throw error;
  }
  return data;
}

function firestoreErrorSummary(err) {
  if (!err || err.provider !== 'firestore') return '';
  var detailReasons = Array.isArray(err.details) ? err.details.map(function(detail) {
    return detail && (detail.reason || detail['@type'] || detail.message) || '';
  }).filter(Boolean) : [];
  return [
    'Firestore ' + (err.method || 'request') + ' ' + (err.path || 'unknown path'),
    err.status ? 'HTTP ' + err.status : '',
    err.code ? 'code ' + err.code : '',
    detailReasons.length ? 'details ' + detailReasons.join(', ') : '',
    err.retryAfter ? 'retry after ' + err.retryAfter + 's' : ''
  ].filter(Boolean).join(' · ');
}

function normalizeCloudErrorMessage(err, phase, storageStatus) {
  var message = String(err && err.message || err || '').trim();
  var code = String(err && (err.code || err.status) || '').trim();
  var provider = String(err && err.provider || '').trim();
  var haystack = (message + ' ' + code).toLowerCase();
  if (provider === 'chrome_storage' || /quota_bytes|chrome storage|local storage/.test(haystack)) {
    return 'CoverCraft extension local storage quota was exceeded. This is local Chrome extension storage, not Firestore, so deleting Firestore documents will not clear it. CoverCraft already tried trimming nonessential local logs. ' + describeStorageStatus(storageStatus || err && err.storageStatus);
  }
  if (provider === 'firestore' && /quota|resource[_\s-]*exhausted|rate.?limit|too many requests|429/.test(haystack)) {
    return 'Firestore rejected the cloud sync because its quota/rate window is exhausted. Deleting Firestore documents reduces stored data, but it does not reset Google read/write quota counters that have already been spent. ' + firestoreErrorSummary(err) + '. Your local CoverCraft data is still available; wait for the Firebase/Firestore quota window to reset, then run Sync Now again.';
  }
  if (/quota|resource[_\s-]*exhausted|rate.?limit|too many requests/.test(haystack)) {
    if (phase === 'auth') {
      return 'Google/Firebase sign-in quota was exceeded. Wait a bit, then try again, or check the Firebase Authentication and Identity Toolkit quotas for this Google Cloud project.';
    }
    return 'Cloud sign-in worked, but Firebase/Firestore sync hit a quota limit. Your local data is still available; cloud backup will retry after the quota window resets.';
  }
  return message || (phase === 'auth' ? 'Google sign-in failed.' : 'Cloud sync failed after sign-in.');
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
    var rawSettings = await syncGet(['model', 'customModel', 'coverLetterType', 'resumeFormat', 'triggerMode', 'cloudSyncEnabled']);
    var nextSettings = {
      model: rawSettings.model || remoteState.settings.model || DEFAULT_MODEL,
      customModel: rawSettings.customModel || '',
      coverLetterType: rawSettings.coverLetterType || remoteState.settings.coverLetterType || 'formal',
      resumeFormat: rawSettings.resumeFormat || remoteState.settings.resumeFormat || 'auto',
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

  if (remoteState.modelHealth && typeof remoteState.modelHealth === 'object') {
    MODEL_HEALTH_CACHE = Object.assign({}, remoteState.modelHealth, MODEL_HEALTH_CACHE);
    var healthPayload = {};
    healthPayload[MODEL_HEALTH_STORAGE_KEY] = MODEL_HEALTH_CACHE;
    await localSet(healthPayload);
  }
}

async function mergeRemoteModelUsageIntoLocal(remoteUsageLogs) {
  if (!Array.isArray(remoteUsageLogs) || !remoteUsageLogs.length) return;
  var data = await localGet(MODEL_USAGE_LOG_STORAGE_KEY);
  var localLogs = Array.isArray(data[MODEL_USAGE_LOG_STORAGE_KEY]) ? data[MODEL_USAGE_LOG_STORAGE_KEY] : MODEL_USAGE_LOG_CACHE;
  var byId = {};
  localLogs.concat(remoteUsageLogs).forEach(function(entry) {
    if (!entry) return;
    var id = entry.id || (String(entry.checkedAt || Date.now()) + '-' + String(entry.model || entry.apiModel || 'model'));
    byId[id] = Object.assign({}, entry, { id: id });
  });
  var merged = Object.keys(byId).map(function(id) {
    return byId[id];
  }).sort(function(a, b) {
    return Number(a.checkedAt || 0) - Number(b.checkedAt || 0);
  }).slice(-MAX_MODEL_USAGE_LOGS);
  MODEL_USAGE_LOG_CACHE = merged;
  rebuildModelHealthFromUsageLogs(merged);
  var payload = {};
  payload[MODEL_USAGE_LOG_STORAGE_KEY] = merged;
  payload[MODEL_HEALTH_STORAGE_KEY] = MODEL_HEALTH_CACHE;
  await localSet(payload);
}

async function getRemoteCloudState() {
  requireOfficialInstallation();
  var auth = await ensureCloudAuthReady();
  if (!auth || !auth.uid) throw new Error('Sign in with Google to enable CoverCraft cloud sync.');
  var appDoc = await firestoreRequest('GET', 'users/' + auth.uid + '/state/main', null, auth);
  var sessions = await listFirestoreDocuments('users/' + auth.uid + '/sessions');
  var modelUsageLogs = await listFirestoreDocuments('users/' + auth.uid + '/modelUsage');
  return {
    app: decodeFirestoreDocument(appDoc),
    sessions: sessions,
    modelUsageLogs: modelUsageLogs
  };
}

async function syncCloudState(reason) {
  requireOfficialInstallation();
  var settings = await loadSettings();
  if (!settings.cloudSyncEnabled) return { ok: true, skipped: 'disabled' };
  var auth = await ensureCloudAuthReady();
  if (!auth || !auth.uid) throw new Error('Sign in with Google to enable cloud sync.');

  var state = await getSessionState();
  var portfolioBundle = await getPortfolioBundle();
  var modelData = await localGet([MODEL_HEALTH_STORAGE_KEY, MODEL_USAGE_LOG_STORAGE_KEY]);
  MODEL_HEALTH_CACHE = Object.assign({}, modelData[MODEL_HEALTH_STORAGE_KEY] || {}, MODEL_HEALTH_CACHE);
  MODEL_USAGE_LOG_CACHE = Array.isArray(modelData[MODEL_USAGE_LOG_STORAGE_KEY]) ? modelData[MODEL_USAGE_LOG_STORAGE_KEY] : MODEL_USAGE_LOG_CACHE;
  rebuildModelHealthFromUsageLogs(MODEL_USAGE_LOG_CACHE);
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
    modelHealth: getModelHealthSummary(),
    updatedAt: now,
    syncReason: reason || 'manual'
  });

  var ids = state.order.slice();
  var pendingSessionIds = ids.filter(function(id) {
    var session = state.sessions[id];
    if (!session) return false;
    if (!session.syncedAt) return true;
    return localTimeMs(session.updatedAt) > localTimeMs(session.syncedAt);
  }).slice(0, MAX_SESSION_SYNC_WRITES);
  var syncedSessionIds = {};
  for (var i = 0; i < pendingSessionIds.length; i++) {
    var session = state.sessions[pendingSessionIds[i]];
    if (!session) continue;
    await patchFirestoreDocument('users/' + auth.uid + '/sessions/' + session.id, Object.assign({}, session, {
      title: Core.sessionTitle(session),
      syncedAt: now
    }));
    syncedSessionIds[session.id] = true;
  }

  var usageLogs = MODEL_USAGE_LOG_CACHE.slice(-MAX_MODEL_USAGE_LOGS);
  var pendingUsageLogs = usageLogs.filter(function(usage) {
    return usage && usage.id && !usage.syncedAt;
  }).slice(-MAX_MODEL_USAGE_SYNC_WRITES);
  var syncedUsageIds = {};
  for (var j = 0; j < pendingUsageLogs.length; j++) {
    var usage = pendingUsageLogs[j];
    if (!usage || !usage.id) continue;
    await patchFirestoreDocument('users/' + auth.uid + '/modelUsage/' + usage.id, Object.assign({}, usage, {
      syncedAt: now
    }));
    syncedUsageIds[usage.id] = true;
  }

  if (Object.keys(syncedUsageIds).length) {
    MODEL_USAGE_LOG_CACHE = MODEL_USAGE_LOG_CACHE.map(function(usage) {
      if (!usage || !usage.id || !syncedUsageIds[usage.id]) return usage;
      return Object.assign({}, usage, { syncedAt: now });
    }).slice(-MAX_MODEL_USAGE_LOGS);
    var usagePayload = {};
    usagePayload[MODEL_USAGE_LOG_STORAGE_KEY] = MODEL_USAGE_LOG_CACHE;
    await localSet(usagePayload);
  }

  if (Object.keys(syncedSessionIds).length) {
    Object.keys(syncedSessionIds).forEach(function(id) {
      if (state.sessions[id]) state.sessions[id] = Object.assign({}, state.sessions[id], { syncedAt: now });
    });
    await saveSessionState(state);
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
    lastSyncedCount: Object.keys(syncedSessionIds).length,
    lastVerifiedAt: Core.nowIso()
  });
  return { ok: true, syncedAt: now, count: Object.keys(syncedSessionIds).length, usageCount: Object.keys(syncedUsageIds).length };
}

async function clearCloudSessions() {
  requireOfficialInstallation();
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
  if (!getInstallationInfo().official) return { ok: true, skipped: 'local_install' };
  try {
    return await syncCloudState(reason);
  } catch (err) {
    var message = normalizeCloudErrorMessage(err, 'sync');
    await saveCloudMeta({ lastError: message });
    return { ok: false, error: message };
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

function decodeBase64UrlJson(value) {
  var normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  try {
    return JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(normalized), function(char) {
      return '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2);
    }).join('')));
  } catch (_) {
    throw new Error('Google sign-in returned an invalid ID token.');
  }
}

function validateGoogleIdToken(idToken, config, expectedNonce) {
  var parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Google sign-in returned an invalid ID token.');
  var claims = decodeBase64UrlJson(parts[1]);
  var issuer = String(claims.iss || '');
  var audience = claims.aud;
  var audienceMatches = Array.isArray(audience)
    ? audience.indexOf(config.googleClientId) !== -1
    : audience === config.googleClientId;
  if (claims.nonce !== expectedNonce) throw new Error('Google sign-in nonce verification failed.');
  if (!audienceMatches) throw new Error('Google sign-in audience verification failed.');
  if (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') {
    throw new Error('Google sign-in issuer verification failed.');
  }
  if (!Number(claims.exp) || Number(claims.exp) * 1000 <= Date.now()) {
    throw new Error('Google sign-in token has expired.');
  }
  return claims;
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
    throw new Error('The production Google OAuth client configuration is incomplete.');
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
  validateGoogleIdToken(result.id_token, config, nonce);
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
    var error = new Error(data.error && data.error.message || 'Firebase sign-in failed.');
    error.status = response.status;
    error.code = data.error && (data.error.status || data.error.code) || '';
    error.provider = 'identitytoolkit';
    throw error;
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
  requireOfficialInstallation();
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
  var installation = getInstallationInfo();
  var settings = await loadSettings();
  var bundle = await getCloudAuthSession();
  var flow = await getPendingCloudAuthFlow();
  var auth = bundle.auth;
  var meta = bundle.meta || {};
  return {
    installation: installation,
    available: installation.official && isFirebaseConfigured(),
    configured: installation.official && isFirebaseConfigured(),
    signedIn: installation.official && !!(auth && auth.uid),
    user: installation.official && auth ? {
      uid: auth.uid || '',
      email: auth.email || '',
      displayName: auth.displayName || '',
      photoURL: auth.photoURL || '',
      expiresAt: auth.expiresAt || ''
    } : null,
    enabled: installation.official && !!settings.cloudSyncEnabled,
    lastSyncedAt: meta.lastSyncedAt || '',
    lastError: installation.official ? (meta.lastError || '') : '',
    unavailableReason: installation.official ? '' : localInstallCloudError(),
    authInProgress: installation.official && !!flow
  };
}

async function loadSettings() {
  var results = await Promise.all([
	    syncGet(['model', 'customModel', 'coverLetterType', 'resumeFormat', 'triggerMode', 'cloudSyncEnabled']),
    loadProviderKeys()
  ]);
  var data = results[0];
  var providerKeys = results[1];
  var model = data.model === 'custom' && data.customModel ? data.customModel : (data.model || DEFAULT_SETTINGS.model);
  if (DISABLED_MODELS.indexOf(model) !== -1) model = DEFAULT_SETTINGS.model;
	  if (data.model !== 'custom' && Core.KNOWN_MODELS.indexOf(model) === -1) model = DEFAULT_SETTINGS.model;
	  return {
	    openrouterKey: providerKeys.openrouterKey,
	    openaiKey: providerKeys.openaiKey,
	    groqKey: providerKeys.groqKey,
	    tavilyKey: providerKeys.tavilyKey,
    model: model,
    customModel: data.customModel || '',
	    coverLetterType: data.coverLetterType || DEFAULT_SETTINGS.coverLetterType,
	    resumeFormat: data.resumeFormat || DEFAULT_SETTINGS.resumeFormat,
    triggerMode: data.triggerMode || DEFAULT_SETTINGS.triggerMode,
    cloudSyncEnabled: resolveCloudSyncEnabled(data.cloudSyncEnabled)
  };
}

async function loadProviderKeys() {
  var results = await Promise.all([
    localGet(PROVIDER_KEY_NAMES),
    syncGet(PROVIDER_KEY_NAMES)
  ]);
  var localValues = results[0];
  var legacySyncValues = results[1];
  var resolved = {};
  var migration = {};
  var migratedNames = [];

  PROVIDER_KEY_NAMES.forEach(function(name) {
    if (Object.prototype.hasOwnProperty.call(localValues, name)) {
      resolved[name] = String(localValues[name] || '');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(legacySyncValues, name)) {
      resolved[name] = String(legacySyncValues[name] || '');
      migration[name] = resolved[name];
      migratedNames.push(name);
      return;
    }
    resolved[name] = String(DEFAULT_SETTINGS[name] || '');
  });

  if (migratedNames.length) {
    await localSet(migration);
    await syncRemove(migratedNames);
  }
  return resolved;
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
  try {
    await localSet(payload);
  } catch (err) {
    if (err && err.provider === 'chrome_storage' && /quota/i.test(String(err.message || ''))) {
      await localRemove([GUEST_SESSIONS_BACKUP_KEY, GUEST_PORTFOLIO_BACKUP_KEY]).catch(function() {});
      var fallback = {};
      fallback[GUEST_SESSIONS_BACKUP_KEY] = {
        skipped: true,
        reason: 'quota_exceeded',
        sessionCount: state.order && state.order.length || Object.keys(state.sessions || {}).length,
        createdAt: Core.nowIso()
      };
      fallback[GUEST_PORTFOLIO_BACKUP_KEY] = {
        skipped: true,
        reason: 'quota_exceeded',
        source: portfolioBundle.source || 'local_file',
        createdAt: Core.nowIso()
      };
      await localSet(fallback);
      return;
    }
    throw err;
  }
}

async function restoreGuestLocalState() {
  var data = await localGet([GUEST_SESSIONS_BACKUP_KEY, GUEST_PORTFOLIO_BACKUP_KEY]);
  var sessionBackup = data[GUEST_SESSIONS_BACKUP_KEY] || null;
  var portfolioBackup = data[GUEST_PORTFOLIO_BACKUP_KEY] || null;
  var payload = {};
  if (sessionBackup && !sessionBackup.skipped && sessionBackup.sessions) {
    payload[STORAGE_KEYS.sessions] = sessionBackup.sessions;
    payload[STORAGE_KEYS.sessionOrder] = sessionBackup.order || [];
  }
  if (portfolioBackup && !portfolioBackup.skipped) {
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
    if (isKnownProviderWarning(err)) {
      console.warn('[CoverCraft]', err && err.message || err);
      return;
    }
    console.error('[CoverCraft]', err);
  });
  return next;
}

function isKnownProviderWarning(err) {
  var message = String(err && err.message || err || '').toLowerCase();
  if (!message) return false;
  return /groq rate limit|openrouter.*rate limit|rate limit reached|too many requests|daily token|daily request|tokens per minute|requests per minute|tokens-per-minute|requests-per-minute|model.*unavailable|not available to this api key|does not exist or you do not have access|provider returned error|temporarily unavailable|overloaded/.test(message);
}

function warningPipelineLabel(err, fallback) {
  var message = String(err && err.message || err || '').toLowerCase();
  if (/rate limit|too many requests|daily token|daily request|tokens per minute|requests per minute|tokens-per-minute|requests-per-minute/.test(message)) return 'Provider limit reached';
  if (/model.*unavailable|not available to this api key|does not exist or you do not have access/.test(message)) return 'Model unavailable';
  if (/provider returned error|temporarily unavailable|overloaded/.test(message)) return 'Provider unavailable';
  return fallback || 'Provider warning';
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
  var requestedSessionId = String(payload.sessionId || '').trim();
  var sessionId = requestedSessionId && state.sessions[requestedSessionId]
    ? requestedSessionId
    : (payload.forceNewSession
      ? 'sess_' + Core.shortHash([normalizedUrl, scrapeHash, portfolioVersion, payload.refreshNonce || Core.nowIso()].join('|'))
      : Core.buildSessionId(normalizedUrl, scrapeHash, portfolioVersion));
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
  if (settings && settings.openaiKey) return FAST_OPENAI_EXTRACT_MODEL;
  if (settings && settings.openrouterKey) return FAST_EXTRACT_MODEL;
  return FAST_OPENAI_EXTRACT_MODEL;
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
  var provider = Core.providerForModel(requestedModel);
  var useGroq = provider === 'groq';
  var useOpenAI = provider === 'openai';
  var apiKey = useGroq ? settings.groqKey : (useOpenAI ? settings.openaiKey : settings.openrouterKey);
  if (!apiKey) {
    throw new Error(useGroq
      ? 'Missing Groq API key. Add it in CoverCraft settings.'
      : (useOpenAI ? 'Missing OpenAI API key. Add it in CoverCraft settings.' : 'Missing OpenRouter API key. Add it in CoverCraft settings.'));
  }
  var apiModelId = Core.apiModelForProvider(requestedModel);
  var requestedMaxTokens = options && options.maxTokens || 1200;
  var maxTokens = useGroq ? clampGroqMaxTokens(apiModelId, requestedMaxTokens) : (useOpenAI ? clampOpenAIMaxTokens(apiModelId, requestedMaxTokens) : requestedMaxTokens);

  var body = useOpenAI ? buildOpenAIResponsesBody() : {
    model: apiModelId,
    messages: messages,
    temperature: options && options.temperature != null ? options.temperature : 0.2
  };
  if (useGroq) {
    body.max_completion_tokens = maxTokens;
    body.top_p = 1;
    body.stream = false;
    body.stop = null;
    if (isGroqCompoundModel(apiModelId)) {
      body.compound_custom = {
        tools: {
          enabled_tools: ['web_search', 'code_interpreter', 'visit_website']
        }
      };
    }
  } else if (!useOpenAI) {
    body.max_tokens = maxTokens;
  }

  function buildOpenAIResponsesBody() {
    var input = (messages || []).map(function(message) {
      return {
        role: message.role === 'system' ? 'developer' : (message.role || 'user'),
        content: String(message.content || '')
      };
    });
    var request = {
      model: apiModelId,
      input: input,
      max_output_tokens: maxTokens
    };
    if (/^gpt-5/i.test(apiModelId)) request.reasoning = { effort: options && options.reasoningEffort || 'low' };
    if (options && options.responseSchema) {
      request.text = {
        format: {
          type: 'json_schema',
          name: options.responseSchemaName || 'covercraft_output',
          schema: options.responseSchema,
          strict: true
        }
      };
    }
    return request;
  }

  function isGroqCompoundModel(modelId) {
    return modelId === 'groq/compound' || modelId === 'groq/compound-mini';
  }

  function estimateTokensFromMessages(items) {
    var chars = JSON.stringify(items || []).length;
    return Math.ceil(chars / 4);
  }

  function clampGroqMaxTokens(modelId, requested) {
    var limit = GROQ_TPM_LIMITS[modelId] || 6000;
    if (limit <= 6000) return Math.min(requested, 1050);
    if (limit <= 8000) return Math.min(requested, 1250);
    if (limit <= 12000) return Math.min(requested, 1500);
    return Math.min(requested, 1800);
  }

  function clampOpenAIMaxTokens(modelId, requested) {
    if (/nano/i.test(modelId)) return Math.min(requested, 900);
    if (/mini|4o-mini/i.test(modelId)) return Math.min(requested, 1800);
    return Math.min(requested, 2600);
  }

  var estimatedInputTokens = estimateTokensFromMessages(messages);
  var estimatedRequestTokens = estimatedInputTokens + maxTokens;

  function numberFromHeader(value) {
    var parsed = Number(String(value || '').replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function collectRateLimitHeaders(response) {
    return {
      retryAfter: response.headers.get('retry-after') || '',
      limitRequests: response.headers.get('x-ratelimit-limit-requests') || '',
      limitTokens: response.headers.get('x-ratelimit-limit-tokens') || '',
      remainingRequests: response.headers.get('x-ratelimit-remaining-requests') || '',
      remainingTokens: response.headers.get('x-ratelimit-remaining-tokens') || '',
      resetRequests: response.headers.get('x-ratelimit-reset-requests') || '',
      resetTokens: response.headers.get('x-ratelimit-reset-tokens') || ''
    };
  }

  function estimateTokensFromText(text) {
    return Math.ceil(String(text || '').length / 4);
  }

  function normalizeTokenUsage(data, responseText, rateLimit) {
    var usage = data && data.usage || {};
    var actualInputTokens = Number(usage.prompt_tokens || usage.input_tokens || usage.inputTokens || 0) || 0;
    var actualOutputTokens = Number(usage.completion_tokens || usage.output_tokens || usage.outputTokens || 0) || 0;
    var actualTotalTokens = Number(usage.total_tokens || usage.totalTokens || 0) || 0;
    if (!actualTotalTokens && (actualInputTokens || actualOutputTokens)) actualTotalTokens = actualInputTokens + actualOutputTokens;
    var estimatedOutputTokens = actualOutputTokens ? 0 : estimateTokensFromText(responseText);
    var estimatedTotal = actualTotalTokens || (estimatedInputTokens + (actualOutputTokens || estimatedOutputTokens || maxTokens));
    var modelTokenLimit = numberFromHeader(rateLimit && rateLimit.limitTokens);
    var usageTokenCount = actualTotalTokens || estimatedTotal;
    return {
      inputTokens: actualInputTokens,
      outputTokens: actualOutputTokens,
      totalTokens: actualTotalTokens,
      estimatedInputTokens: estimatedInputTokens,
      estimatedOutputTokens: estimatedOutputTokens,
      requestedOutputTokens: maxTokens,
      estimatedTokens: estimatedTotal,
      modelUsageTokens: usageTokenCount,
      modelTokenLimit: modelTokenLimit || null,
      modelUsagePercent: modelTokenLimit ? Math.round((usageTokenCount / modelTokenLimit) * 1000) / 10 : null,
      usageSource: actualTotalTokens ? 'provider' : 'estimate'
    };
  }

  function rateLimitDetails(resultInfo) {
    var rate = resultInfo && resultInfo.rateLimit || {};
    var parts = [];
    if (rate.limitTokens) parts.push('TPM limit: ' + rate.limitTokens);
    if (rate.remainingTokens) parts.push('tokens remaining: ' + rate.remainingTokens);
    if (rate.resetTokens) parts.push('token reset: ' + rate.resetTokens);
    if (rate.retryAfter) parts.push('retry after: ' + rate.retryAfter + 's');
    if (estimatedRequestTokens) parts.push('estimated request: ~' + estimatedRequestTokens + ' tokens');
    return parts.length ? ' (' + parts.join(', ') + ')' : '';
  }

  function displayModelFromResponse(resultInfo, fallbackModel) {
    var returned = String(resultInfo && resultInfo.data && resultInfo.data.model || fallbackModel || '').trim();
    if (useGroq && returned && returned.indexOf('groq/') !== 0) return 'groq/' + returned;
    if (useOpenAI && returned && returned.indexOf('openai/') !== 0) return 'openai/' + returned;
    return returned || fallbackModel || requestedModel;
  }

  function openAIResponseText(data) {
    if (data && typeof data.output_text === 'string') return data.output_text;
    var chunks = [];
    (data && data.output || []).forEach(function(item) {
      (item && item.content || []).forEach(function(part) {
        if (typeof part.text === 'string') chunks.push(part.text);
      });
    });
    return chunks.join('');
  }

  async function runProviderRequest(requestBody) {
    var headers = {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    };
    if (!useGroq && !useOpenAI) {
      headers['HTTP-Referer'] = 'https://covercraft.extension';
      headers['X-Title'] = 'CoverCraft';
    }
    var endpoint = useGroq
      ? 'https://api.groq.com/openai/v1/chat/completions'
      : (useOpenAI ? 'https://api.openai.com/v1/responses' : 'https://openrouter.ai/api/v1/chat/completions');
    var response = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });
    var data = await response.json().catch(function() { return {}; });
    var rateLimit = collectRateLimitHeaders(response);
    var responseText = useOpenAI
      ? openAIResponseText(data)
      : ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '');
    var normalizedUsage = normalizeTokenUsage(data, responseText, rateLimit);
    var resultObject = {
      ok: response.ok,
      status: response.status,
      data: data,
      rateLimit: rateLimit,
      usage: normalizedUsage
    };
    await rememberModelHealth(requestedModel, {
      provider: provider,
      apiModel: requestBody.model,
      ok: response.ok,
      status: response.status,
      error: data && data.error && data.error.message || '',
      rateLimit: resultObject.rateLimit,
      limitKind: providerLimitKind(data && data.error && data.error.message || '', resultObject.rateLimit),
      estimatedTokens: resultObject.usage.estimatedTokens,
      estimatedInputTokens: resultObject.usage.estimatedInputTokens,
      estimatedOutputTokens: resultObject.usage.estimatedOutputTokens,
      requestedOutputTokens: resultObject.usage.requestedOutputTokens,
      modelUsageTokens: resultObject.usage.modelUsageTokens,
      modelTokenLimit: resultObject.usage.modelTokenLimit,
      modelUsagePercent: resultObject.usage.modelUsagePercent,
      usageSource: resultObject.usage.usageSource,
      inputTokens: resultObject.usage.inputTokens,
      outputTokens: resultObject.usage.outputTokens,
      totalTokens: resultObject.usage.totalTokens
    });
    return resultObject;
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

  function normalizeOpenRouterError(errorMessage, status, resultInfo) {
    var providerLabel = useGroq ? 'Groq' : (useOpenAI ? 'OpenAI' : 'OpenRouter');
    var message = String(errorMessage || '').trim() || (providerLabel + ' HTTP ' + status);
    var requestedModelLabel = requestedModel.replace(/^groq\//, '');
    if (useOpenAI) requestedModelLabel = requestedModelLabel.replace(/^openai\//, '');
    var loweredMessage = message.toLowerCase();
    if (useGroq && (status === 413 || /request entity too large|payload too large|context length|maximum context|too large/.test(loweredMessage))) {
      return 'Groq request too large for ' + requestedModelLabel + '. This is a payload/context-size problem, not a normal rate-limit reset. Reduce scraped page text, profile context, or research context, then try a larger-context Groq model such as Llama 4 Scout or Compound.' +
        rateLimitDetails(resultInfo);
    }
    if (useGroq && (status === 429 || /rate limit|too many requests/i.test(message))) {
      var detail = summarizeGroqRateLimit(message);
      var rate = resultInfo && resultInfo.rateLimit || {};
      var remainingTokens = numberFromHeader(rate.remainingTokens);
      var hasEnoughVisibleTpm = remainingTokens && estimatedRequestTokens && remainingTokens >= estimatedRequestTokens;
      var advice = hasEnoughVisibleTpm
        ? 'Groq headers still show enough visible TPM, so this is likely an underlying Compound/component limit, request expansion, or a moving window mismatch. Wait for the reset, reduce context, or switch to another available Groq model.'
        : (requestedModel === 'groq/compound' || requestedModel === 'groq/compound-mini'
          ? 'Wait for the reset, reduce page/profile context, or switch to Llama 4 Scout for a non-Compound route.'
          : 'Switch to Llama 4 Scout or Compound for larger prompts, reduce page/profile context, or wait for the limit window to reset.');
      return 'Groq rate limit reached for ' + requestedModelLabel + '. ' +
        (detail ? detail + ' ' : '') +
        advice +
        rateLimitDetails(resultInfo);
    }
    if (useGroq && /authentication|invalid api key|unauthorized/i.test(message)) return 'Groq rejected the API key. Check the Groq key in CoverCraft settings.';
    if (useOpenAI && /authentication|invalid api key|unauthorized/i.test(message)) return 'OpenAI rejected the API key. Check the OpenAI key in CoverCraft settings.';
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

  var cachedHealth = MODEL_HEALTH_CACHE[modelHealthKey(requestedModel)];
  if (useGroq && cachedHealth && cachedHealth.blockedUntil && Date.now() < cachedHealth.blockedUntil) {
    var cachedRate = cachedHealth.rateLimit || {};
    var cachedRemaining = numberFromHeader(cachedRate.remainingTokens);
    var cachedLimitKind = String(cachedHealth.limitKind || '').toLowerCase();
    if (cachedLimitKind === 'daily_tokens' || cachedLimitKind === 'daily_requests' || !cachedHealth.ok) {
      throw new Error('Groq rate limit reached for ' + requestedModel.replace(/^groq\//, '') + '. This model is marked unavailable from the last provider response. Wait ' + Math.ceil((cachedHealth.blockedUntil - Date.now()) / 1000) + 's or choose another model.' + rateLimitDetails({ rateLimit: cachedRate }));
    }
    if (cachedRemaining && cachedRemaining < estimatedRequestTokens) {
      throw new Error('Groq rate limit reached for ' + requestedModel.replace(/^groq\//, '') + '. Last response shows only ' + cachedRemaining + ' TPM remaining, but this request is estimated at ~' + estimatedRequestTokens + ' tokens. Wait ' + Math.ceil((cachedHealth.blockedUntil - Date.now()) / 1000) + 's or choose a model with enough remaining capacity.');
    }
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

  function shouldRetryWithFreeRouter(model, errorMessage, status) {
    if (useGroq || useOpenAI) return false;
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

  var result = await runProviderRequest(body);
  var attempt = 0;
  while (!result.ok && attempt < 2) {
    var transientError = (result.data.error && result.data.error.message) || ('OpenRouter HTTP ' + result.status);
    if (!shouldRetrySameModel(transientError, result.status)) break;
    attempt++;
    await wait(250 * attempt);
    result = await runProviderRequest(body);
  }
  if (!result.ok) {
    var primaryError = normalizeOpenRouterError((result.data.error && result.data.error.message) || ('OpenRouter HTTP ' + result.status), result.status, result);
    if (allowRouterModelFallback && shouldRetryWithFreeRouter(body.model, primaryError, result.status)) {
      var fallbackBody = Object.assign({}, body, { model: DEFAULT_MODEL });
      var fallback = await runProviderRequest(fallbackBody);
      var fallbackAttempt = 0;
      while (!fallback.ok && fallbackAttempt < 2) {
        var fallbackTransientError = (fallback.data.error && fallback.data.error.message) || ('OpenRouter HTTP ' + fallback.status);
        if (!shouldRetrySameModel(fallbackTransientError, fallback.status)) break;
        fallbackAttempt++;
        await wait(250 * fallbackAttempt);
        fallback = await runProviderRequest(fallbackBody);
      }
      if (!fallback.ok) {
        var fallbackError = normalizeOpenRouterError((fallback.data.error && fallback.data.error.message) || primaryError, fallback.status, fallback);
        if (/privacy or guardrail settings/i.test(fallbackError)) {
          fallbackError = 'OpenRouter could not find any provider that matches your current privacy restrictions for this free request. Review https://openrouter.ai/settings/privacy or keep using Free Routing with less restrictive data-policy settings.';
        }
        throw new Error(fallbackError);
      }
      return {
        content: (fallback.data.choices && fallback.data.choices[0] && fallback.data.choices[0].message && fallback.data.choices[0].message.content) || '',
        model: displayModelFromResponse(fallback, fallbackBody.model),
        usage: fallback.usage || {}
      };
    }
    throw new Error(primaryError);
  }

  return {
    content: (result.data.choices && result.data.choices[0] && result.data.choices[0].message && result.data.choices[0].message.content) || '',
    model: displayModelFromResponse(result, body.model),
    usage: result.usage || {}
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
    .replace(/\s*--+\s*/g, ', ')
    .replace(/\u2014/g, ',')
    .replace(/\u2013/g, '-')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/,\s*\./g, '.')
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

function coverLetterQualityIssues(text) {
  var clean = String(text || '');
  var lower = clean.toLowerCase();
  var issues = [];
  if (/\s--+\s/.test(clean)) issues.push('double hyphen separators');
  if (/[\u2013\u2014]/.test(clean)) issues.push('dash punctuation');
  [
    'seasoned ',
    'i am excited',
    'i am confident',
    'significant impact',
    'strong fit',
    'my passion',
    'poised for continued success',
    'look forward to contributing'
  ].forEach(function(phrase) {
    if (lower.indexOf(phrase) !== -1) issues.push('generic phrase: ' + phrase.trim());
  });
  if (/\bover\s+\d+\s+years?\b/i.test(clean) || /\b\d+\+?\s+years?\s+of experience\b/i.test(clean)) {
    issues.push('unsupported years-of-experience claim');
  }
  return issues;
}

async function repairCoverLetterQuality(text, issues, portfolio, model) {
  var systemPrompt = [
    'You are a strict cover-letter editor.',
    'Rewrite the draft into polished professional prose.',
    'Preserve every grounded fact, role, employer, metric, tool, and job/company name.',
    'Do not add new facts, seniority claims, years of experience, credentials, or motivations.',
    'Remove generic enthusiasm, self-rating, unsupported claims, double hyphens, em dashes, and en dashes.',
    'Output only the final letter text.'
  ].join('\n');
  var userPrompt = [
    'Fix these quality issues:',
    JSON.stringify(issues || []),
    '',
    'Draft:',
    String(text || '')
  ].join('\n');
  var response = await aiChat(systemPrompt, userPrompt, 0.18, 1800, model);
  return {
    text: stripFormatting(response.content, portfolio),
    model: response.model,
    usage: response.usage || {}
  };
}

function mergeTokenUsage(base, next) {
  var out = Object.assign({}, base || {});
  next = next || {};
  [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'estimatedInputTokens',
    'estimatedOutputTokens',
    'requestedOutputTokens',
    'estimatedTokens',
    'modelUsageTokens'
  ].forEach(function(key) {
    out[key] = (Number(out[key]) || 0) + (Number(next[key]) || 0);
  });
  out.modelTokenLimit = Math.max(Number(out.modelTokenLimit) || 0, Number(next.modelTokenLimit) || 0) || null;
  out.modelUsagePercent = out.modelTokenLimit ? Math.round(((Number(out.modelUsageTokens) || 0) / out.modelTokenLimit) * 1000) / 10 : null;
  out.usageSource = out.usageSource === 'provider' || next.usageSource === 'provider' ? 'provider' : 'estimate';
  return out;
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
    'Avoid AI clichés, generic praise, resume-summary dumping, em dashes, en dashes, and double hyphens.',
    'Do not use phrases like "seasoned", "I am excited", "I am confident", "significant impact", "strong fit", "my passion", or "poised for continued success".',
    'Begin exactly with "Dear Hiring Manager,".',
    'Use only the provided job context, ranked portfolio evidence, and company research.',
    'Never invent experience, metrics, technologies, domains, employers, titles, dates, or motivations.',
    'Never infer total years of experience unless the portfolio explicitly states a total.',
    'Never upgrade titles. Preserve student, assistant, intern, graduate assistant, and other level markers when naming roles.',
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

function buildCoverLetterUserPrompt(session, style, portfolio, promptContext) {
  promptContext = promptContext || buildJobApplicationPromptContext(session, portfolio);
  return [
    'Write a tailored cover letter using the job context below.',
    'Before drafting, silently decide which 2 experiences and which optional project best prove fit.',
    'Use the ranked evidence scores, matched keywords, matched requirements, and whySelected notes as the default priority order unless another item is more clearly supported.',
    'If a ranked experience already contains gold-standard wording for this job, preserve that wording in narrative form instead of flattening it.',
    'Use the highest-scoring bullets inside each ranked experience, not the experience chronologically.',
    'Make the role-specific keywords visible through grounded evidence, but never stuff keywords or copy requirement language mechanically.',
    'Use the company research and job details directly.',
    'Keep it concrete, natural, and evidence-backed.',
    'Target 360 to 500 words.',
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
    'Do not claim seniority, total years of experience, or broad architecture ownership unless the source evidence states it.',
    'Use restrained professional language. Prefer concrete evidence over enthusiasm and self-rating.',
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
      page: {
        hostname: session.page && session.page.hostname || '',
        normalizedUrl: session.page && session.page.normalizedUrl || ''
      },
      job: {
        jobTitle: session.job && session.job.jobTitle || '',
        companyName: session.job && session.job.companyName || '',
        location: session.job && session.job.location || '',
        seniorityLevel: session.job && session.job.seniorityLevel || '',
        keywords: session.job && session.job.keywords ? session.job.keywords.slice(0, 10) : [],
        responsibilities: session.job && session.job.responsibilities ? session.job.responsibilities.slice(0, 5).map(function(item) { return clipWords(item, 22); }) : [],
        requirements: session.job && session.job.requirements ? session.job.requirements.slice(0, 5).map(function(item) { return clipWords(item, 22); }) : []
      },
      research: {
        summary: clipWords(session.research && session.research.summary || '', 90)
      },
      scrapePreview: clipWords(session.scrape && session.scrape.preview || '', 70)
    })
  ].join('\n');
}

async function generateCoverLetter(session, style, model, portfolio) {
  var systemPrompt = buildCoverLetterSystemPrompt(portfolio, style);
  var promptContext = buildJobApplicationPromptContext(session, portfolio);
  var userPrompt = buildCoverLetterUserPrompt(session, style, portfolio, promptContext);
  var attempts = 0;
  var response = null;
  var output = '';
  var tokenUsage = {};
  while (attempts < 2) {
    attempts++;
    response = await aiChat(
      systemPrompt,
      userPrompt,
      attempts === 1 ? 0.48 : 0.32,
      2200,
      model
    );
    tokenUsage = mergeTokenUsage(tokenUsage, response.usage);
    output = stripFormatting(response.content, portfolio);
    if (output && looksLikeCompleteCoverLetter(output, portfolio && portfolio.name) && !coverLetterQualityIssues(output).length) break;
  }
  if (!output) throw new Error('AI returned an empty response.');
  if (!looksLikeCompleteCoverLetter(output, portfolio && portfolio.name)) {
    throw new Error('The model returned an incomplete cover letter. Please try again or switch models.');
  }
  var qualityIssues = coverLetterQualityIssues(output);
  if (qualityIssues.length) {
    var repaired = await repairCoverLetterQuality(output, qualityIssues, portfolio, model);
    output = repaired.text || output;
    if (repaired.model) response.model = repaired.model;
    tokenUsage = mergeTokenUsage(tokenUsage, repaired.usage);
    qualityIssues = coverLetterQualityIssues(output);
  }
  if (qualityIssues.length) {
    throw new Error('The model returned a draft with professional-quality issues: ' + qualityIssues.slice(0, 3).join(', ') + '. Please try again or switch models.');
  }
  return {
    text: output,
    model: response.model,
    prompt: {
      system: systemPrompt,
      user: userPrompt
    },
    rankingContext: promptContext.rankedEvidence,
    tokenUsage: tokenUsage
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

function normalizeRankTerm(value) {
  return normalizeResumeComparisonText(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function rankKindPriority(kind) {
  var priority = {
    requirement: 5,
    responsibility: 4,
    title: 3,
    keyword: 2,
    phrase: 1,
    company: 0
  };
  return priority[kind] || 0;
}

function rankTermWords(value) {
  return normalizeRankTerm(value).split(' ').filter(Boolean);
}

function technicalRankTermMap() {
  var terms = [
    'ab testing', 'airflow', 'analytics', 'analytics engineering', 'analytics platform', 'api',
    'arima', 'artificial intelligence', 'automation', 'aws', 'azure', 'bigquery', 'business intelligence',
    'classification', 'cloud', 'computer vision', 'cross functional', 'dashboard', 'data analyst',
    'data architecture', 'data contracts', 'data engineering', 'data governance', 'data lake',
    'data lakehouse', 'data pipeline', 'data pipelines', 'data quality', 'data science',
    'data scientist', 'data visualization', 'database', 'databricks', 'dbt', 'deep learning',
    'docker', 'etl', 'elt', 'excel', 'experiment', 'experimentation', 'forecasting', 'gcp',
    'github', 'java', 'javascript', 'kafka', 'kubernetes', 'lakehouse', 'lakehouse architecture',
    'llm', 'machine learning', 'mariadb', 'metrics', 'ml', 'model', 'modeling', 'mongodb',
    'mysql', 'natural language processing', 'nlp', 'numpy', 'orchestration', 'pandas',
    'postgres', 'postgresql', 'power bi', 'prophet', 'python', 'pyspark', 'r', 'regression',
    'reporting', 'research', 'scikit-learn', 'schema validation', 'snowflake', 'spark',
    'sql', 'sql server', 'sqlite', 'stakeholder', 'statistical', 'statistics', 'supabase',
    'tableau', 'typescript', 'visualization'
  ];
  var map = {};
  terms.forEach(function(term) { map[term] = true; });
  return map;
}

function isAllowedRoleSignal(term) {
  return /\b(data scientist|data engineer|analytics engineer|machine learning engineer|ml engineer|data analyst|business intelligence analyst|software engineer|ai engineer|research scientist|database engineer)\b/.test(term);
}

function isLikelyTechnicalRankTerm(term, source, kind) {
  var clean = normalizeRankTerm(term);
  if (!clean) return false;
  var words = rankTermWords(clean);
  var blocked = {
    application: 1, applications: 1, apply: 1, applicant: 1, assist: 1, careers: 1,
    changes: 1, chirayu: 1, content: 1, discard: 1, generated: 1, inside: 1,
    levels: 1, necessary: 1, required: 1, summary: 1, southern: 1, tirth: 1,
    shah: 1, cover: 1, letter: 1, manager: 1, hiring: 1
  };
  if (blocked[clean]) return false;
  if (words.some(function(word) { return blocked[word]; })) return false;
  if (kind === 'title' && isAllowedRoleSignal(clean)) return true;

  var allow = technicalRankTermMap();
  if (allow[clean]) return true;
  if (words.length === 1) return !!allow[clean];

  return words.some(function(word) { return !!allow[word]; }) && !/^(about|apply|assist|content|generated|required|summary)\b/.test(clean);
}

function addRankTerm(map, term, weight, source, kind) {
  var clean = normalizeRankTerm(term);
  if (!clean) return;
  var words = rankTermWords(clean);
  var genericSingleTerms = {
    data: 1, role: 1, team: 1, company: 1, business: 1, work: 1, systems: 1, platform: 1,
    experience: 1, ability: 1, skills: 1, strong: 1, senior: 1, manager: 1, build: 1,
    using: 1, support: 1, solutions: 1, requirements: 1, responsibilities: 1, engineer: 1
  };
  if (words.length === 1 && genericSingleTerms[clean]) return;
  if (clean.length < 3) return;
  if (!isLikelyTechnicalRankTerm(clean, source, kind)) return;
  var current = map[clean] || { term: clean, weight: 0, sources: {}, kind: kind || 'keyword' };
  current.weight += weight;
  current.sources[source || 'job'] = true;
  if (rankKindPriority(kind) > rankKindPriority(current.kind)) current.kind = kind || current.kind;
  map[clean] = current;
}

function extractRankTermsFromText(text, map, source, baseWeight, kind) {
  var clean = normalizeRankTerm(text);
  if (!clean) return;
  var knownPhrases = [
    'data lakehouse', 'lakehouse architecture', 'analytics engineering', 'data engineering',
    'data pipeline', 'data pipelines', 'etl', 'elt', 'sql', 'python', 'dbt', 'airflow',
    'databricks', 'snowflake', 'bigquery', 'redshift', 'spark', 'pyspark', 'power bi',
    'tableau', 'schema validation', 'data contracts', 'data quality', 'data governance',
    'orchestration', 'stakeholder', 'cross functional', 'machine learning', 'forecasting',
    'cloud', 'gcp', 'aws', 'azure', 'firebase', 'postgres', 'mysql', 'sql server',
    'dashboard', 'reporting', 'automation', 'migration', 'analytics platform'
  ];
  knownPhrases.forEach(function(phrase) {
    if (clean.indexOf(phrase) !== -1) addRankTerm(map, phrase, baseWeight + 2, source, kind || 'keyword');
  });

  var chunks = clean.split(/[.;:|()[\]\n]+/).map(function(part) { return part.trim(); }).filter(Boolean);
  chunks.forEach(function(chunk) {
    var words = rankTermWords(chunk);
    if (words.length >= 2 && words.length <= 5 && isLikelyTechnicalRankTerm(chunk, source, kind)) {
      addRankTerm(map, chunk, baseWeight + 1, source, kind || 'phrase');
    }
  });

  var tokens = clean.match(/[a-z][a-z0-9.+#/-]{2,}/g) || [];
  var ignore = {
    the: 1, and: 1, with: 1, for: 1, from: 1, that: 1, this: 1, role: 1, team: 1,
    company: 1, work: 1, years: 1, year: 1, using: 1, build: 1, across: 1, about: 1,
    your: 1, will: 1, have: 1, our: 1, you: 1, job: 1, are: 1, can: 1, all: 1,
    their: 1, them: 1, into: 1, more: 1, than: 1, such: 1, other: 1, including: 1
  };
  tokens.forEach(function(token) {
    if (ignore[token]) return;
    if (isLikelyTechnicalRankTerm(token, source, kind)) addRankTerm(map, token, baseWeight, source, kind || 'keyword');
  });
}

function buildJobRankProfile(session) {
  var job = session && session.job || {};
  var map = {};
  addRankTerm(map, job.jobTitle || '', 7, 'title', 'title');
  (job.keywords || []).forEach(function(keyword) {
    addRankTerm(map, keyword, 7, 'extracted_keyword', 'keyword');
    extractRankTermsFromText(keyword, map, 'extracted_keyword', 3, 'keyword');
  });
  (job.requirements || []).slice(0, 8).forEach(function(item) {
    extractRankTermsFromText(item, map, 'requirement', 5, 'requirement');
  });
  (job.responsibilities || []).slice(0, 8).forEach(function(item) {
    extractRankTermsFromText(item, map, 'responsibility', 4, 'responsibility');
  });
  extractRankTermsFromText(session && session.scrape ? clipWords(session.scrape.preview || '', 120) : '', map, 'page_preview', 1, 'keyword');

  var terms = Object.keys(map).map(function(key) {
    var entry = map[key];
    return {
      term: entry.term,
      weight: Math.round(entry.weight * 10) / 10,
      kind: entry.kind,
      sources: Object.keys(entry.sources)
    };
  }).sort(function(a, b) {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return b.term.length - a.term.length;
  }).slice(0, 34);

  return {
    terms: terms,
    keywords: terms.map(function(entry) { return entry.term; }).slice(0, 30),
    requirements: terms.filter(function(entry) { return entry.sources.indexOf('requirement') !== -1; }).slice(0, 12).map(function(entry) { return entry.term; }),
    responsibilities: terms.filter(function(entry) { return entry.sources.indexOf('responsibility') !== -1; }).slice(0, 12).map(function(entry) { return entry.term; })
  };
}

function rankTextAgainstProfile(text, profile, multiplier) {
  var haystack = ' ' + normalizeResumeComparisonText(text) + ' ';
  var score = 0;
  var matched = [];
  (profile && profile.terms || []).forEach(function(entry) {
    var key = normalizeRankTerm(entry.term);
    if (!key) return;
    var isMatch = haystack.indexOf(' ' + key + ' ') !== -1 || haystack.indexOf(key) !== -1;
    if (!isMatch) return;
    var phraseBoost = key.indexOf(' ') !== -1 ? 1.35 : 1;
    var sourceBoost = entry.sources && entry.sources.indexOf('requirement') !== -1 ? 1.2 : 1;
    var points = entry.weight * phraseBoost * sourceBoost * (multiplier || 1);
    score += points;
    matched.push({
      term: entry.term,
      points: Math.round(points * 10) / 10,
      sources: entry.sources || [],
      kind: entry.kind || 'keyword'
    });
  });
  matched.sort(function(a, b) { return b.points - a.points; });
  return {
    score: Math.round(score * 10) / 10,
    matchedTerms: matched.slice(0, 8)
  };
}

function rankWhy(parts) {
  return parts.filter(Boolean).slice(0, 3).join(' ');
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

function choosePromptExperiences(experiences, rankProfile, limit) {
  return (experiences || []).map(function(experience, index) {
    var roleRank = rankTextAgainstProfile([
      experience.role || '',
      experience.company || ''
    ].join(' '), rankProfile, 1.6);
    var bulletRanks = (experience.bullets || []).map(function(bullet, bulletIndex) {
      var rank = rankTextAgainstProfile(bullet, rankProfile, 1);
      var impactBonus = hasResumeImpactSignal(bullet) ? 2.5 : 0;
      return {
        text: bullet,
        index: bulletIndex,
        score: Math.round((rank.score + impactBonus) * 10) / 10,
        matchedTerms: rank.matchedTerms.slice(0, 6),
        hasImpact: impactBonus > 0
      };
    }).sort(function(a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    });
    var topBullets = bulletRanks.slice(0, 3);
    var requirementHits = [].concat(roleRank.matchedTerms, topBullets.reduce(function(all, bullet) {
      return all.concat(bullet.matchedTerms || []);
    }, [])).filter(function(match) {
      return match.sources && match.sources.indexOf('requirement') !== -1;
    });
    var score = roleRank.score + topBullets.reduce(function(total, bullet) {
      return total + bullet.score;
    }, 0) + Math.max(0, 4 - index) * 0.2;
    if (topBullets.some(function(bullet) { return bullet.hasImpact; })) score += 1;
    return {
      experience: experience,
      score: Math.round(score * 10) / 10,
      roleMatches: roleRank.matchedTerms.slice(0, 5),
      bulletRanks: topBullets,
      requirementHits: requirementHits.slice(0, 5)
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 4).map(function(entry) {
    var matchedTerms = [].concat(entry.roleMatches, entry.bulletRanks.reduce(function(all, bullet) {
      return all.concat(bullet.matchedTerms || []);
    }, []));
    var seenTerms = {};
    matchedTerms = matchedTerms.filter(function(match) {
      var key = normalizeRankTerm(match.term);
      if (!key || seenTerms[key]) return false;
      seenTerms[key] = true;
      return true;
    }).slice(0, 8);
    return {
      company: entry.experience.company,
      role: entry.experience.role,
      duration: entry.experience.duration,
      location: entry.experience.location,
      score: entry.score,
      matchedKeywords: matchedTerms.map(function(match) { return match.term; }).slice(0, 6),
      matchedRequirements: entry.requirementHits.map(function(match) { return match.term; }).slice(0, 4),
      whySelected: rankWhy([
        matchedTerms.length ? 'Matches ' + matchedTerms.slice(0, 3).map(function(match) { return match.term; }).join(', ') + '.' : '',
        entry.requirementHits.length ? 'Covers requirement signals: ' + entry.requirementHits.slice(0, 2).map(function(match) { return match.term; }).join(', ') + '.' : '',
        entry.bulletRanks.some(function(bullet) { return bullet.hasImpact; }) ? 'Contains quantified impact evidence.' : ''
      ]),
      bullets: entry.bulletRanks.map(function(bullet) {
        return {
          text: clipWords(bullet.text, 34),
          score: bullet.score,
          matchedKeywords: (bullet.matchedTerms || []).map(function(match) { return match.term; }).slice(0, 5),
          hasImpact: bullet.hasImpact
        };
      })
    };
  });
}

function choosePromptProjects(projects, rankProfile, limit) {
  return (projects || []).map(function(project, index) {
    var rank = rankTextAgainstProfile([
      project.title || '',
      project.description || '',
      (project.technologies || []).join(' ')
    ].join(' '), rankProfile, 1);
    var score = rank.score + (hasResumeImpactSignal(project.description) ? 1.5 : 0) + Math.max(0, 3 - index) * 0.1;
    return {
      project: project,
      score: Math.round(score * 10) / 10,
      matchedTerms: rank.matchedTerms
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 3).map(function(entry) {
    return {
      title: entry.project.title,
      description: entry.project.description,
      technologies: entry.project.technologies,
      links: entry.project.links,
      score: entry.score,
      matchedKeywords: entry.matchedTerms.map(function(match) { return match.term; }).slice(0, 6),
      whySelected: rankWhy([
        entry.matchedTerms.length ? 'Matches ' + entry.matchedTerms.slice(0, 3).map(function(match) { return match.term; }).join(', ') + '.' : '',
        hasResumeImpactSignal(entry.project.description) ? 'Contains measurable project impact.' : ''
      ])
    };
  });
}

function choosePromptAchievements(achievements, rankProfile, limit) {
  return dedupeStrings(achievements || []).map(function(item, index) {
    var rank = rankTextAgainstProfile(item, rankProfile, 1);
    return {
      text: item,
      score: Math.round((rank.score + Math.max(0, 3 - index) * 0.1) * 10) / 10,
      matchedTerms: rank.matchedTerms
    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 4).map(function(entry) {
    return {
      text: entry.text,
      score: entry.score,
      matchedKeywords: entry.matchedTerms.map(function(match) { return match.term; }).slice(0, 5)
    };
  });
}

function buildJobApplicationPromptContext(session, portfolio) {
  var rankProfile = buildJobRankProfile(session);
  var keywords = rankProfile.keywords;
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
      keywords: session && session.job ? (session.job.keywords || []).slice(0, 10) : [],
      requirements: session && session.job ? (session.job.requirements || []).slice(0, 5).map(function(item) { return clipWords(item, 22); }) : [],
      responsibilities: session && session.job ? (session.job.responsibilities || []).slice(0, 5).map(function(item) { return clipWords(item, 22); }) : []
    },
    rankedEvidence: {
      rankProfile: {
        topTerms: rankProfile.terms.slice(0, 16),
        requirementTerms: rankProfile.requirements.slice(0, 8),
        responsibilityTerms: rankProfile.responsibilities.slice(0, 8)
      },
      experiences: choosePromptExperiences(experiences, rankProfile, 3),
      projects: choosePromptProjects(projects, rankProfile, 2).map(function(project) {
        return Object.assign({}, project, {
          description: clipWords(project.description || '', 28),
          technologies: (project.technologies || []).slice(0, 8),
          links: []
        });
      }),
      achievements: choosePromptAchievements(portfolio && portfolio.achievements || [], rankProfile, 3).map(function(item) {
        return {
          text: clipWords(item.text || '', 24),
          score: item.score,
          matchedKeywords: item.matchedKeywords || []
        };
      }),
      skills: chooseResumeSkills(skillsList, keywords, 14, 210),
      keywords: keywords.slice(0, 12)
    },
    companyResearch: {
      summary: clipWords(session && session.research ? session.research.summary || '' : '', 90),
      sources: session && session.research ? (session.research.sources || []).slice(0, 2).map(function(source) {
        return {
          title: source.title || '',
          snippet: clipWords(source.snippet || '', 28)
        };
      }) : []
    },
    scrapePreview: clipWords(session && session.scrape ? session.scrape.preview || '' : '', 70)
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

function chooseResumeProjects(projects, keywords, limit, formatProfile) {
  var hints = formatProfile && Array.isArray(formatProfile.projectHints) ? formatProfile.projectHints : [];
	  return (projects || []).map(function(project, index) {
    var projectText = [project.title || '', project.description || '', (project.technologies || []).join(' ')].join(' ').toLowerCase();
    var hintBoost = hints.reduce(function(total, hint, hintIndex) {
      var key = String(hint || '').toLowerCase();
      if (!key) return total;
      return projectText.indexOf(key) !== -1 || key.indexOf(String(project.title || '').toLowerCase()) !== -1
        ? total + Math.max(1, 8 - hintIndex)
        : total;
    }, 0);
	    return {
	      project: project,
	      score: scoreProjectForKeywords(project, keywords) + hintBoost + Math.max(0, 3 - index) * 0.1
	    };
  }).sort(function(a, b) {
    return b.score - a.score;
  }).slice(0, limit || 3).map(function(entry) {
    return entry.project;
  });
}

function normalizeResumeEducation(rawPortfolio, normalizedPortfolio) {
  if (Array.isArray(rawPortfolio && rawPortfolio.education)) {
    return rawPortfolio.education.map(function(entry) {
      entry = entry || {};
      var degree = [entry.degree, entry.field].filter(Boolean).join(' - ');
      return {
        institution: String(entry.institution || '').trim(),
        location: String(entry.location || '').trim(),
        degree: degree.trim(),
        duration: String(entry.duration || '').trim(),
        gpa: String(entry.gpa || '').trim()
      };
    }).filter(function(entry) {
      return entry.institution || entry.degree || entry.duration;
    });
  }
  var educationText = String(normalizedPortfolio && normalizedPortfolio.education || '').trim();
  return educationText ? [{
    institution: educationText,
    location: '',
    degree: '',
    duration: '',
    gpa: ''
  }] : [];
}

function buildResumeOwner(rawPortfolio, normalizedPortfolio) {
  var personal = rawPortfolio && rawPortfolio.personalInfo || {};
  var social = personal.social || normalizedPortfolio.links || {};
  return {
    name: String(normalizedPortfolio.name || '').trim(),
    phone: String(normalizedPortfolio.phone || '').trim(),
    email: String(normalizedPortfolio.email || '').trim(),
    linkedin: String(social.linkedin || '').trim(),
    website: String(normalizedPortfolio.website || social.portfolio || social.github || '').trim(),
    title: String(normalizedPortfolio.title || '').trim(),
    location: String(normalizedPortfolio.location || '').trim()
  };
}

function buildResumeSource(portfolioBundle, session, formatProfile) {
  var rawPortfolio = portfolioBundle && portfolioBundle.rawPortfolio || {};
  var normalizedPortfolio = portfolioBundle && portfolioBundle.portfolio || Core.normalizePortfolio(rawPortfolio).normalized;
  var keywords = buildResumeKeywords(session);
  var skillsList = splitSkillList(normalizedPortfolio.skills || '');
  var leadership = dedupeStrings([].concat(
    Array.isArray(rawPortfolio.leadership) ? rawPortfolio.leadership : [],
    Array.isArray(normalizedPortfolio.awards) ? normalizedPortfolio.awards : []
  ));
  return {
	    owner: buildResumeOwner(rawPortfolio, normalizedPortfolio),
	    summary: normalizeResumeOutputText((rawPortfolio.about && rawPortfolio.about.bio && rawPortfolio.about.bio[0]) || normalizedPortfolio.summary || ''),
	    education: normalizeResumeEducation(rawPortfolio, normalizedPortfolio),
    experiences: normalizeResumeExperiences(rawPortfolio),
	    projects: chooseResumeProjects(normalizeResumeProjects(rawPortfolio), keywords, 3, formatProfile),
    leadership: leadership,
    certifications: dedupeStrings(normalizedPortfolio.certifications || rawPortfolio.certifications || []),
    skillsList: skillsList,
    skills: normalizeResumeSkillString(chooseResumeSkills(skillsList, keywords, 20, 260).join(', '), 50),
    keywords: keywords
	  };
	}

function inferResumeFormat(session, requestedFormat) {
  var requested = String(requestedFormat || '').trim();
  if (requested && requested !== 'auto') return requested;
  var job = session && session.job || {};
  var text = [
    job.jobTitle || '',
    (job.keywords || []).join(' '),
    (job.requirements || []).join(' '),
    (job.responsibilities || []).join(' '),
    session && session.scrape ? session.scrape.preview || '' : ''
  ].join(' ').toLowerCase();
  if (/\b(product manager|product owner|roadmap|mvp|go-to-market|0-to-1|user stories|backlog)\b/.test(text)) return 'ai_pm';
  if (/\b(business analyst|requirements|uat|stakeholder|process improvement|kpi|business intelligence)\b/.test(text)) return 'ba_pm';
  if (/\b(full.stack|frontend|backend|next\.js|react|typescript|fastapi|api|chrome extension)\b/.test(text)) return 'full_stack_ai';
  if (/\b(data scientist|machine learning|ml engineer|data engineer|etl|pipeline|forecasting|model|python|sql|spark)\b/.test(text)) return 'data_ai';
  return 'balanced';
}

function resumeFormatProfile(format) {
  var profiles = {
    data_ai: {
      label: 'Data AI/ML Engineer',
      summaryIdentity: 'AI/Data Engineer',
      projectHints: ['Trade Surveillance Platform', 'AI Regulatory Document Classifier', 'Inventory Management', 'Market Basket', 'Forecasting Dashboards'],
      summaryFocus: ['Python', 'SQL', 'data pipelines', 'forecasting', 'LLM applications', 'production analytics']
    },
    ai_pm: {
      label: 'AI Product Manager',
      summaryIdentity: 'AI Product Manager',
      projectHints: ['Black Tie', '5G Network Intelligence', 'CoverCraft', 'Mays AI Analytics Assistant'],
      summaryFocus: ['roadmaps', 'requirements', 'AI workflows', 'stakeholder alignment', '0-to-1 launches']
    },
    ba_pm: {
      label: 'Technical Business Analyst',
      summaryIdentity: 'Technical Business Analyst',
      projectHints: ['Mays Admissions', 'Black Tie', 'CoverCraft', 'BI Dashboards'],
      summaryFocus: ['requirements', 'KPI analysis', 'SQL', 'process automation', 'stakeholder reporting']
    },
    full_stack_ai: {
      label: 'AI Full-Stack Engineer',
      summaryIdentity: 'AI Full-Stack Engineer',
      projectHints: ['Black Tie', 'CoverCraft', 'Trade Surveillance Platform', 'Landmark Lens'],
      summaryFocus: ['Next.js', 'TypeScript', 'FastAPI', 'LLM APIs', 'full-stack delivery']
    },
    balanced: {
      label: 'Balanced Technical Resume',
      summaryIdentity: 'Technical AI/Data Professional',
      projectHints: ['Mays AI Analytics Assistant', 'Trade Surveillance Platform', 'Black Tie', 'CoverCraft'],
      summaryFocus: ['analytics platforms', 'AI workflows', 'SQL', 'Python', 'stakeholder execution']
    }
  };
  return profiles[format] || profiles.balanced;
}

function normalizeResumeOutputText(text) {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u00A1(?=\s*\d)/g, '<')
    .replace(/\u02DC(?=\s*\d)/g, '~')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function resumeBulletHasMetric(text) {
  return /(\d+|%|\$|under|over|less than|more than|from\b.+\bto\b|reduced|increased|saved|cut|improved|boosting|slashing)/i.test(String(text || ''));
}

function resumeBulletQualityIssues(text) {
  var value = String(text || '').trim();
  var issues = [];
  if (/[–—]/.test(value)) issues.push('contains non-ASCII dash');
  if (/^(worked on|helped|assisted|responsible for|involved in|participated in|used|did|made)\b/i.test(value)) issues.push('weak opening verb');
  if (value.split(/[.!?]\s+/).filter(Boolean).length > 1) issues.push('more than one sentence');
  if (!resumeBulletHasMetric(value)) issues.push('missing visible impact metric');
  return issues;
}

function buildResumeDraftSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'experiences', 'projects', 'skills', 'comments'],
    properties: {
      summary: { type: 'string' },
      experiences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['company', 'bullets'],
          properties: {
            company: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      projects: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'description'],
          properties: {
            title: { type: 'string' },
            description: { type: 'string' }
          }
        }
      },
      skills: { type: 'array', items: { type: 'string' } },
      comments: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['company', 'bulletIndex', 'decision', 'matchedKeywords', 'justification'],
          properties: {
            company: { type: 'string' },
            bulletIndex: { type: 'number' },
            decision: { type: 'string' },
            matchedKeywords: { type: 'array', items: { type: 'string' } },
            justification: { type: 'string' }
          }
        }
      }
    }
  };
}

function buildResumeSystemPrompt(formatProfile) {
  formatProfile = formatProfile || resumeFormatProfile('balanced');
  return [
    'You tailor ATS-safe resume bullet points for a specific job posting.',
    'Return ONLY valid JSON.',
    'Do not include markdown or commentary.',
    'Preserve the exact experience ordering, company names, role titles, duration labels, location labels, and bullet counts.',
    'Some experiences have exactly 2 bullets and some have exactly 3 bullets. Never add or remove bullets.',
    'Do not change the header, education, certifications, leadership, company names, role titles, dates, or locations.',
    'Only tailor the experience bullet text, the project descriptions, and the skills selection/order.',
    'Do not change project titles or project links.',
    'Every bullet must follow FAANG resume style and the X-Y-Z rule: accomplished X, measured by Y, by doing Z.',
    'Every rewritten bullet must start with a strong action verb, include method/tool/domain context, and include quantified or business impact when grounded in the source.',
    'Avoid weak verbs: worked on, helped, assisted, responsible for, involved in, participated in, used, did, made.',
    'Never use em dashes or en dashes. Use commas, parentheses, semicolons, or ASCII hyphens only.',
    'Normalize symbols into plain ATS-safe text: use <, >, <=, >=, ~, %, $, and ASCII hyphen.',
    'Add a 2-line targeted summary using the target identity "' + formatProfile.summaryIdentity + '" and only truthful strengths.',
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
    'Provide concise comments explaining each KEEP or REWRITE decision for later review.',
    'Return exactly this shape:',
    '{"summary":"","experiences":[{"company":"","bullets":[""]}],"projects":[{"title":"","description":""}],"skills":[""],"comments":[{"company":"","bulletIndex":0,"decision":"KEEP","matchedKeywords":[""],"justification":""}]}'
  ].join('\n');
}

function buildResumeUserPrompt(session, resumeSource, formatProfile) {
  formatProfile = formatProfile || resumeFormatProfile('balanced');
  return [
    'Tailor this resume for the job below.',
    'Header, education, certifications, leadership, dates, locations, company names, and role titles stay fixed outside this output.',
    'The output must preserve the exact number of bullets for every experience. If the source has 2 bullets, return 2. If the source has 3 bullets, return 3.',
    'If a source bullet is already ideal, relevant, or even somewhat relevant, keep it unchanged.',
    'Only use a rewrite when it creates a clearly better match to the target role without weakening the bullet.',
    'Rewrite only the bullets that truly need better alignment for this specific job.',
    'Use FAANG-style bullet quality: action verb first, then what was built or improved, then impact and quantification when grounded in the source.',
    'Use the X-Y-Z rule where possible: accomplished X, measured by Y, by doing Z.',
    'For summary language, match this role family: ' + formatProfile.label + '.',
    'Summary focus terms, only when truthful: ' + formatProfile.summaryFocus.join(', ') + '.',
    'Project selection hints for this profile: ' + formatProfile.projectHints.join(' | ') + '.',
    'Do not let any bullet exceed its hard max word count.',
    'Treat targetWordCount as the intended length and minWordCount as the minimum acceptable density for a rewrite.',
    'Use the source bullet text itself as the pattern to imitate. Match its specificity, pacing, density, and sentence rhythm.',
    'If you rewrite a bullet, preserve the source bullet architecture: action verb -> scope/method -> outcome/impact.',
    'If a rewrite would become shorter but weaker, keep the original bullet unchanged.',
    'Do not add new metrics, dates, tools, project names, or company details.',
    'Project titles and references stay fixed; you may only rewrite project descriptions.',
    'Skills must be a subset of the provided inventory, reordered or trimmed to fit tightly, and should usually keep 15 to 20 skills when possible.',
    'For comments, explain why each bullet was kept or rewritten, which target keywords it supports, and what source evidence grounded it.',
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
	      targetKeywords: resumeSource.keywords,
	      roleFamily: formatProfile.label
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
	    }),
	    bulletComments: Array.isArray(resumeData && resumeData.comments) ? resumeData.comments : [],
	    qualityIssueCount: 0
	  };
	  summary.qualityIssueCount = summary.bulletComments.reduce(function(total, item) {
	    return total + (Array.isArray(item.qualityIssues) ? item.qualityIssues.length : 0);
	  }, 0);

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
  var draftComments = Array.isArray(draft.comments) ? draft.comments : [];
  function commentFor(company, bulletIndex) {
    var found = draftComments.find(function(item) {
      return item && String(item.company || '').trim().toLowerCase() === String(company || '').trim().toLowerCase() &&
        Number(item.bulletIndex) === Number(bulletIndex);
    });
    return found || null;
  }
  var comments = [];
  var normalizedExperiences = resumeSource.experiences.map(function(sourceExperience) {
    var matched = Array.isArray(draft.experiences) ? draft.experiences.find(function(entry) {
      return entry && String(entry.company || '').trim().toLowerCase() === sourceExperience.company.toLowerCase();
    }) : null;
    var bullets = Array.isArray(matched && matched.bullets) ? matched.bullets.map(function(item) {
      return String(item || '').trim();
    }).filter(Boolean) : [];
    while (bullets.length < sourceExperience.bullets.length) bullets.push(sourceExperience.bullets[bullets.length]);
    bullets = bullets.slice(0, sourceExperience.bullets.length).map(function(bullet, index) {
      var sourceBullet = normalizeResumeOutputText(sourceExperience.bullets[index]);
      var clipped = clipWords(normalizeResumeOutputText(bullet), sourceExperience.bulletBudgets[index]);
      if (shouldPreserveResumeSourceText(sourceExperience.bullets[index], clipped, resumeSource.keywords)) {
        clipped = sourceBullet;
      }
      var explicitComment = commentFor(sourceExperience.company, index);
      var changed = normalizeResumeComparisonText(sourceBullet) !== normalizeResumeComparisonText(clipped);
      comments.push({
        company: sourceExperience.company,
        role: sourceExperience.role,
        bulletIndex: index,
        decision: changed ? 'REWRITE' : 'KEEP',
        sourceText: sourceBullet,
        finalText: clipped,
        matchedKeywords: keywordMatchesForText(clipped, resumeSource.keywords, 6),
        qualityIssues: resumeBulletQualityIssues(clipped),
        justification: explicitComment && explicitComment.justification
          ? normalizeResumeOutputText(explicitComment.justification)
          : (changed
            ? 'Rewritten to align source evidence with the target role keywords while preserving the original metric and scope.'
            : 'Kept because the source bullet already carries relevant evidence, impact, or keyword alignment.')
      });
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
    var description = normalizeResumeOutputText(matched && matched.description || project.description || '') || project.description;
    if (shouldPreserveResumeSourceText(project.description, description, resumeSource.keywords)) {
      description = project.description;
    }
    return {
      title: project.title,
      description: clipWords(normalizeResumeOutputText(description), project.wordBudget),
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

  var summary = normalizeResumeOutputText(draft.summary || resumeSource.summary || '');
  if (!summary) {
    summary = clipWords([
      resumeSource.owner.title || 'Technical professional',
      'with experience across analytics platforms, AI-enabled workflows, data systems, and stakeholder-facing delivery.'
    ].join(' '), 38);
  }

  return {
    owner: resumeSource.owner,
    summary: summary,
    education: resumeSource.education,
    experiences: normalizedExperiences,
    projects: normalizedProjects,
    leadership: resumeSource.leadership,
    certifications: resumeSource.certifications,
    skills: normalizeResumeSkillString(selectedSkills.slice(0, 20).join(', '), 50),
    comments: comments
  };
}

function escapeLatexText(text) {
  return normalizeResumeOutputText(text)
    .replace(/\u00A0/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\u2248/g, 'approx. ')
    .replace(/\u200B/g, '')
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/</g, '\\textless{}')
    .replace(/>/g, '\\textgreater{}')
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

function buildResumePreviewText(resumeData) {
  var lines = [];
  var owner = resumeData.owner || {};
  lines.push(owner.name || 'Candidate');
  lines.push([owner.phone, owner.email, owner.website].filter(Boolean).join(' | '));
  if (resumeData.summary) {
    lines.push('');
    lines.push('SUMMARY');
    lines.push(normalizeResumeOutputText(resumeData.summary));
  }
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
      lines.push('- ' + normalizeResumeOutputText(bullet));
    });
    lines.push('');
  });
  lines.push('PROJECTS');
  (resumeData.projects || []).forEach(function(project) {
    lines.push(project.title + ': ' + normalizeResumeOutputText(project.description));
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
  var owner = resumeData.owner || {};
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

  var contactItems = [];
  if (owner.phone) contactItems.push('\\mbox{\\fontsize{10}{12}\\selectfont ' + escapeLatexText(owner.phone) + '}');
  if (owner.email) {
    contactItems.push('\\mbox{\\fontsize{10}{12}\\selectfont \\href{mailto:' + escapeLatexHrefTarget(owner.email) + '}{' + escapeLatexText(owner.email) + '}}');
  }
  if (owner.linkedin) {
    contactItems.push('\\mbox{\\fontsize{10}{12}\\selectfont \\href{' + escapeLatexHrefTarget(resumeWebsiteHref(owner.linkedin)) + '}{' + escapeLatexText(owner.linkedin.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')) + '}}');
  }
  if (owner.website) {
    contactItems.push('\\mbox{\\fontsize{10}{12}\\selectfont \\href{' + escapeLatexHrefTarget(resumeWebsiteHref(owner.website)) + '}{' + escapeLatexText(owner.website.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')) + '}}');
  }
	  var contactBlock = contactItems.join('\n    ~$\\vert$~\n    ');
	  var summaryText = escapeLatexText(resumeData.summary || '');

  var educationBlock = (resumeData.education || []).slice(0, 3).map(function(entry, index) {
    var degree = escapeLatexText(String(entry.degree || '').trim());
    if (entry.gpa) degree += (degree ? '\\enspace--\\enspace' : '') + '\\textbf{GPA: ' + escapeLatexText(entry.gpa) + '}';
    return [
      index ? '    \\eduentrygap' : '',
      '    \\resumeSubheading',
      '      {' + escapeLatexText(entry.institution || '') + '}{' + escapeLatexText(entry.location || '') + '}',
      '      {' + degree + '}{' + escapeLatexText(entry.duration || '') + '}'
    ].filter(Boolean).join('\n');
  }).join('\n');

  var certificationText = (resumeData.certifications || []).map(escapeLatexText).join(' $|$ ');
  var leadershipBlock = (resumeData.leadership || []).slice(0, 4).map(function(item, index, items) {
    return '  ' + escapeLatexText(item) + (index < items.length - 1 ? '\\\\[2pt]' : '%');
  }).join('\n');

  return [
    '%-------------------------',
    '% Resume in LaTeX - ' + String(owner.name || 'Candidate'),
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
    '    {\\Huge\\scshape ' + escapeLatexText(owner.name || 'Candidate') + '}\\\\[0pt]',
    contactBlock,
	    '\\end{center}',
	    '\\vspace{-6pt}',
	    '',
	    '%-----------SUMMARY-----------',
	    summaryText ? '\\noindent\\normalsize{' + summaryText + '}' : '% No summary available',
	    '\\vspace{2pt}',
	    '',
	    '%-----------EDUCATION-----------',
    '\\section{Education}',
    '  \\resumeSubHeadingListStart',
    educationBlock || '    % No education entries available',
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
    '  \\textbf{Certifications}: ' + certificationText + '%',
    '}',
    '',
    '%-----------LEADERSHIP & ACHIEVEMENTS-----------',
    '\\sectiongap',
    '\\section{Leadership \\& Achievements}',
    '\\vspace{2pt}',
    '\\noindent\\normalsize{%',
    leadershipBlock || '  % No leadership entries available',
    '}',
    '\\end{document}'
  ].join('\n');
}

async function generateResumeArtifact(session, model, portfolioBundle, options) {
  options = options || {};
  var resumeFormat = inferResumeFormat(session, options.resumeFormat || 'auto');
  var formatProfile = resumeFormatProfile(resumeFormat);
  var resumeSource = buildResumeSource(portfolioBundle, session, formatProfile);
  if (!resumeSource.owner.name || !resumeSource.experiences.length) {
    throw new Error('Your active portfolio does not have enough resume data yet. Import a fuller profile before generating a resume.');
  }

  var response = null;
  var resumeData = null;
	  try {
	    response = await aiChatMessages([
	      { role: 'system', content: buildResumeSystemPrompt(formatProfile) },
	      { role: 'user', content: buildResumeUserPrompt(session, resumeSource, formatProfile) }
	    ], {
	      temperature: 0.08,
	      maxTokens: 2600,
	      model: model,
	      responseSchemaName: 'tailored_resume',
	      responseSchema: Core.providerForModel(model) === 'openai' ? buildResumeDraftSchema() : null
	    });
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
	    resumeFormat: resumeFormat,
	    resumeFormatLabel: formatProfile.label,
	    previewText: previewText,
    latexSource: latexSource,
    modifications: modifications,
	    model: response.model || model,
	    prompt: {
	      system: buildResumeSystemPrompt(formatProfile),
	      user: buildResumeUserPrompt(session, resumeSource, formatProfile)
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

  if (message.type === 'OPEN_STORE') {
    chrome.tabs.create({ url: CHROME_WEB_STORE_URL });
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

  if (message.type === 'GET_SETTINGS' || message.type === 'GET_PRIVATE_SETTINGS' || message.type === 'RELOAD_CONFIG') {
    var includeProviderSecrets = message.type === 'GET_PRIVATE_SETTINGS' && senderCanReadProviderSecrets(sender);
    Promise.all([loadSettings(), getPortfolioBundle(), getCloudStatus(), localGet([MODEL_HEALTH_STORAGE_KEY, MODEL_USAGE_LOG_STORAGE_KEY])]).then(function(results) {
      MODEL_HEALTH_CACHE = Object.assign({}, results[3] && results[3][MODEL_HEALTH_STORAGE_KEY] || {}, MODEL_HEALTH_CACHE);
      MODEL_USAGE_LOG_CACHE = Array.isArray(results[3] && results[3][MODEL_USAGE_LOG_STORAGE_KEY]) ? results[3][MODEL_USAGE_LOG_STORAGE_KEY] : MODEL_USAGE_LOG_CACHE;
      rebuildModelHealthFromUsageLogs(MODEL_USAGE_LOG_CACHE);
      sendResponse({
        settings: includeProviderSecrets ? results[0] : settingsWithoutProviderSecrets(results[0]),
        portfolio: {
          source: results[1].source,
          owner: results[1].owner,
          warnings: results[1].validation.warnings,
          errors: results[1].validation.errors
        },
        cloud: results[2],
        modelHealth: getModelHealthSummary(),
        modelUsageLog: MODEL_USAGE_LOG_CACHE.slice(-MAX_MODEL_USAGE_LOGS)
      });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'RECORD_MODEL_HEALTH') {
    var payload = message.payload || {};
    rememberModelHealth(payload.model || DEFAULT_MODEL, {
      provider: payload.provider || Core.providerForModel(String(payload.model || '')),
      apiModel: payload.apiModel || payload.model || DEFAULT_MODEL,
      ok: !!payload.ok,
      status: payload.status || 0,
      error: payload.error || '',
      rateLimit: payload.rateLimit || {},
      limitKind: payload.limitKind || '',
      estimatedTokens: payload.estimatedTokens || 0,
      estimatedInputTokens: payload.estimatedInputTokens || 0,
      estimatedOutputTokens: payload.estimatedOutputTokens || 0,
      requestedOutputTokens: payload.requestedOutputTokens || 0,
      modelUsageTokens: payload.modelUsageTokens || 0,
      modelTokenLimit: payload.modelTokenLimit || 0,
      modelUsagePercent: payload.modelUsagePercent || 0,
      usageSource: payload.usageSource || 'estimate',
      inputTokens: payload.inputTokens || 0,
      outputTokens: payload.outputTokens || 0,
      totalTokens: payload.totalTokens || 0
    }).then(function() {
      sendResponse({ ok: true, modelHealth: getModelHealthSummary(), modelUsageLog: MODEL_USAGE_LOG_CACHE.slice(-MAX_MODEL_USAGE_LOGS) });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'GET_CLOUD_STATUS') {
    Promise.all([getCloudStatus(), getExtensionStorageStatus()]).then(function(results) {
      sendResponse({ cloud: results[0], storage: results[1] });
    }).catch(function(err) {
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'CLOUD_SIGN_IN') {
    queueMutation(async function() {
      requireOfficialInstallation();
      var responseSent = false;
      if (await getPendingCloudAuthFlow()) throw new Error('Google sign-in is already in progress.');
      var flow = { startedAt: Core.nowIso(), method: 'chrome_identity' };
      await savePendingCloudAuthFlow(flow);
      await saveCloudMeta({ lastError: '', authStartedAt: flow.startedAt });
      try {
        var auth = await signInToCloudWithGoogle();
        await finalizeFirebaseAuth({ ok: true, auth: auth });
        await backupGuestLocalState();
        await syncSet({ cloudSyncEnabled: true });
        responseSent = true;
        sendResponse({ ok: true, cloud: await getCloudStatus(), syncPending: true });
        var remote = await getRemoteCloudState().catch(function() { return { app: null, sessions: [], modelUsageLogs: [] }; });
        await mergeRemoteAppStateIntoLocal(remote.app || {}, { forcePortfolioReplace: true });
        await mergeRemoteSessionsIntoLocal(remote.sessions || []);
        await mergeRemoteModelUsageIntoLocal(remote.modelUsageLogs || []);
        var syncResult = await maybeSyncCloud('sign_in');
        if (!syncResult || syncResult.ok === false) throw new Error(syncResult && syncResult.error || 'Cloud sync failed after sign-in.');
        await clearPendingCloudAuthFlow();
        chrome.runtime.sendMessage({
          type: 'CLOUD_STATUS_UPDATE',
          cloud: await getCloudStatus(),
          syncResult: syncResult
        }, function() {
          void chrome.runtime.lastError;
        });
      } catch (err) {
        await clearPendingCloudAuthFlow();
        var phase = responseSent ? 'sync' : 'auth';
        var storageStatus = await getExtensionStorageStatus().catch(function() { return err && err.storageStatus || null; });
        var errorMessage = normalizeCloudErrorMessage(err, phase, storageStatus);
        await saveCloudMeta({ lastError: errorMessage }).catch(function() {});
        var cloudStatus = await getCloudStatus();
        if (!responseSent) {
          sendResponse({ error: errorMessage, cloud: cloudStatus, storage: storageStatus });
        } else {
          chrome.runtime.sendMessage({
            type: 'CLOUD_STATUS_UPDATE',
            cloud: cloudStatus,
            storage: storageStatus,
            error: errorMessage
          }, function() {
            void chrome.runtime.lastError;
          });
        }
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
      requireOfficialInstallation();
      var remote = await getRemoteCloudState().catch(function() { return { app: null, sessions: [], modelUsageLogs: [] }; });
      await mergeRemoteAppStateIntoLocal(remote.app || {});
      await mergeRemoteSessionsIntoLocal(remote.sessions || []);
      await mergeRemoteModelUsageIntoLocal(remote.modelUsageLogs || []);
      var result = await syncCloudState('manual_sync');
      sendResponse({ ok: true, result: result, cloud: await getCloudStatus(), storage: await getExtensionStorageStatus().catch(function() { return null; }) });
    }).catch(function(err) {
      getExtensionStorageStatus().catch(function() { return err && err.storageStatus || null; }).then(function(storageStatus) {
        sendResponse({ error: normalizeCloudErrorMessage(err, 'sync', storageStatus), storage: storageStatus });
      });
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
        model: sanitizeModelFromSettings(settings, message.payload.model),
        sessionId: message.payload.sessionId || '',
        forceNewSession: !!message.payload.forceNewSession,
        refreshNonce: message.payload.refreshNonce || ''
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
        var refreshWarning = isKnownProviderWarning(err);
        setSessionPipeline(refreshSession, 'refresh', refreshWarning ? 'provider_warning' : 'error', refreshWarning ? warningPipelineLabel(err, 'Context provider warning') : 'Context refresh failed', err.message || '', 100, refreshWarning ? 'warning' : 'error');
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
        model: model,
        sessionId: message.payload.sessionId || ''
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
        rankingContext: generated.rankingContext,
        tokenUsage: generated.tokenUsage || {},
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
          model: generated.model,
          tokenUsage: artifact.tokenUsage || {}
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
          model: artifact.model,
          tokenUsage: artifact.tokenUsage || {}
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
        var pipelineWarning = isKnownProviderWarning(err);
        setSessionPipeline(pipelineSession, 'generate', pipelineWarning ? 'provider_warning' : 'error', pipelineWarning ? warningPipelineLabel(err, 'Cover letter provider warning') : 'Cover letter generation failed', err.message || '', 100, pipelineWarning ? 'warning' : 'error');
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
      var generatedResume = await generateResumeArtifact(session, model, portfolioBundle, {
        resumeFormat: message.payload.resumeFormat || settings.resumeFormat || 'auto'
      });
      await savePipelineState(state, session, 'resume', 'render_resume', 'Step 5 · Building resume output', '', 92, 'running');

      var resumeArtifact = {
        id: 'resume_' + Core.shortHash(session.id + '|' + Core.nowIso() + '|' + generatedResume.previewText),
        createdAt: Core.nowIso(),
        model: generatedResume.model,
        resumeFormat: generatedResume.resumeFormat,
        resumeFormatLabel: generatedResume.resumeFormatLabel,
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
        var resumeWarning = isKnownProviderWarning(err);
        setSessionPipeline(resumeSession, 'resume', resumeWarning ? 'provider_warning' : 'error', resumeWarning ? warningPipelineLabel(err, 'Resume provider warning') : 'Resume generation failed', err.message || '', 100, resumeWarning ? 'warning' : 'error');
        resumeSession.updatedAt = Core.nowIso();
        saveSessionState(resumeState).then(function() {
          broadcastSessionUpdate(resumeSession);
        }).catch(function() {});
      }
      sendResponse({ error: err.message });
    });
    return true;
  }

  if (message.type === 'SAVE_MANUAL_COVER_LETTER') {
    queueMutation(async function() {
      var portfolioBundle = await getPortfolioBundle();
      var state = await getSessionState();
      var coverLetterText = String(message.payload.coverLetterText || '').trim();
      if (!coverLetterText) throw new Error('Manual cover letter text is required.');

      var session = ensureSessionBase(state, {
        pageUrl: message.payload.pageUrl,
        rawPageText: message.payload.rawPageText || '',
        pageTitle: message.payload.pageTitle,
        titleHint: message.payload.titleHint,
        companyHint: message.payload.companyHint,
        coverLetterType: 'manual',
        model: 'manual/no-ai'
      }, portfolioBundle.version);

      session.job = session.job || {};
      if (message.payload.titleHint) session.job.jobTitle = message.payload.titleHint;
      if (message.payload.companyHint) session.job.companyName = message.payload.companyHint;
      session.job.jobTitle = session.job.jobTitle || message.payload.pageTitle || 'Cover Letter';
      session.job.companyName = session.job.companyName || '';
      session.panel.open = true;
      session.panel.activeView = 'manual';

      var artifact = {
        id: 'manual_artifact_' + Core.shortHash(session.id + '|' + Core.nowIso() + '|' + coverLetterText),
        createdAt: Core.nowIso(),
        text: coverLetterText,
        style: 'manual',
        model: 'manual/no-ai',
        source: 'manual',
        noAi: true,
        owner: portfolioBundle.owner,
        prompt: {
          system: 'Manual cover letter pasted by the user. No AI call was made.',
          user: ''
        },
        rankingContext: null,
        sessionId: session.id,
        jobTitle: session.job.jobTitle || '',
        company: session.job.companyName || '',
        outputWords: Core.wordCount(coverLetterText),
        outputChars: coverLetterText.length
      };

      session.artifacts = Array.isArray(session.artifacts) ? session.artifacts : [];
      session.artifacts.unshift(artifact);
      session.artifacts = session.artifacts.slice(0, 20);
      session.latestStyle = 'manual';
      session.latestModel = 'manual/no-ai';
      clearSessionPipeline(session, 'manual', 'Manual cover letter saved');
      session.updatedAt = Core.nowIso();

      pushSessionActivity(session, {
        type: 'manual_cover_letter',
        createdAt: Core.nowIso(),
        payload: {
          artifactId: artifact.id,
          model: artifact.model,
          outputWords: artifact.outputWords,
          noAi: true
        }
      });

      await saveSessionState(state);
      broadcastSessionUpdate(session);
      await maybeSyncCloud('manual_cover_letter');
      await appendLegacyLog({
        kind: 'manual_cover_letter',
        id: Date.now(),
        timestamp: Core.nowIso(),
        url: session.page.url,
        style: 'manual',
        model: 'manual/no-ai',
        noAi: true,
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
        step3: session.research || null,
        step4: {
          rawResponse: artifact.text,
          outputWords: artifact.outputWords,
          outputChars: artifact.outputChars,
          model: artifact.model,
          noAi: true
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
        var askWarning = isKnownProviderWarning(err);
        setSessionPipeline(askSession, 'ask', askWarning ? 'provider_warning' : 'error', askWarning ? warningPipelineLabel(err, 'Answer provider warning') : 'Answer generation failed', err.message || '', 100, askWarning ? 'warning' : 'error');
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
    Promise.all([getSessionState(), getPortfolioBundle(), localGet([MODEL_HEALTH_STORAGE_KEY, MODEL_USAGE_LOG_STORAGE_KEY])]).then(function(results) {
      var state = results[0];
      MODEL_HEALTH_CACHE = Object.assign({}, results[2] && results[2][MODEL_HEALTH_STORAGE_KEY] || {}, MODEL_HEALTH_CACHE);
      MODEL_USAGE_LOG_CACHE = Array.isArray(results[2] && results[2][MODEL_USAGE_LOG_STORAGE_KEY]) ? results[2][MODEL_USAGE_LOG_STORAGE_KEY] : MODEL_USAGE_LOG_CACHE;
      rebuildModelHealthFromUsageLogs(MODEL_USAGE_LOG_CACHE);
      var sessions = state.order.map(function(id) {
        return state.sessions[id];
      }).filter(Boolean).map(serializeSession);
      sendResponse({
        sessions: sessions,
        modelHealth: getModelHealthSummary(),
        modelUsageLog: MODEL_USAGE_LOG_CACHE.slice(-MAX_MODEL_USAGE_LOGS),
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
