var Core = window.CoverCraftCore;
var sessions = [];
var activeSurface = 'dashboard';
var activeSessionTab = 'letters';
var SESSION_LIMIT = 10;
var currentDraftSource = 'manual_editor';
var MAX_IMPORTED_RESUME_TEXT = 16000;
var dashboardInitialized = false;
var RESUME_WORKSPACE_SOURCE = 'COVERCRAFT_RESUME_WORKSPACE';
var pendingPortfolioDraft = null;
var lastCloudStatus = null;
var lastPortfolioOwner = null;
var lastPortfolioSource = 'local_file';
var dashboardRefreshTimer = null;
var dashboardRefreshInFlight = false;
var expandedCards = {};
var dashboardChartState = {};

function mk(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    var date = new Date(iso);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
      date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return iso;
  }
}

function copyText(text, button) {
  navigator.clipboard.writeText(text || '').then(function() {
    if (!button) return;
    var original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(function() { button.textContent = original; }, 1400);
  });
}

function setStatus(id, type, message) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = 'status' + (type ? ' ' + type : '');
  el.textContent = message || '';
}

function setPortfolioProgress(value) {
  var wrap = document.getElementById('portfolio-progress');
  var fill = document.getElementById('portfolio-progress-fill');
  if (!wrap || !fill) return;
  var amount = Math.max(0, Math.min(100, Number(value) || 0));
  wrap.classList.toggle('hidden', amount <= 0 || amount >= 100);
  fill.style.width = amount + '%';
}

function flashConfirmToast(message) {
  var toast = document.getElementById('confirm-toast');
  if (!toast) return;
  toast.textContent = message || 'Confirmed';
  toast.classList.add('show');
  clearTimeout(flashConfirmToast._timer);
  flashConfirmToast._timer = setTimeout(function() {
    toast.classList.remove('show');
  }, 1800);
}

function setInlineStatus(id, type, message) {
  var el = document.getElementById(id);
  if (!el) return;
  el.className = 'toolbar-status' + (type ? ' ' + type : '');
  el.textContent = message || '';
}

function flashButtonSuccess(button, successText, originalText) {
  if (!button) return;
  var previous = originalText || button.dataset.originalText || button.textContent;
  button.dataset.originalText = previous;
  button.disabled = true;
  button.textContent = successText || '✓ Synced';
  clearTimeout(button._covercraftFlashTimer);
  button._covercraftFlashTimer = setTimeout(function() {
    button.textContent = previous;
    button.disabled = false;
  }, 1600);
}

function setRefreshLoading(isLoading) {
  var button = document.getElementById('refresh-btn');
  if (!button) return;
  button.classList.toggle('loading', !!isLoading);
  button.disabled = !!isLoading;
  button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
}

function bindById(id, eventName, handler) {
  var el = document.getElementById(id);
  if (!el) return null;
  el.addEventListener(eventName, handler);
  return el;
}

function statusMessage(err, fallback) {
  if (!err) return fallback || 'Something went wrong.';
  if (typeof err === 'string') return err;
  if (err && err.message) return err.message;
  return fallback || 'Something went wrong.';
}

function limitText(text, maxChars) {
  var input = String(text || '').trim();
  if (!input) return '';
  var limit = typeof maxChars === 'number' ? maxChars : 120;
  if (input.length <= limit) return input;
  return input.slice(0, limit).replace(/\s+\S*$/, '').trim() + '…';
}

function dashboardDomReady() {
  return !!(
    document.querySelector('.surface-switch') &&
    document.getElementById('refresh-btn') &&
    document.getElementById('portfolio-status')
  );
}

function chip(text, kind) {
  var el = document.createElement('span');
  el.className = 'chip' + (kind ? ' ' + kind : '');
  el.textContent = text;
  return el;
}

function cardStateKey(group, id) {
  return group + ':' + id;
}

function bindCardExpansion(card, header, key) {
  if (!card || !header || !key) return;
  if (expandedCards[key]) card.classList.add('open');
  header.addEventListener('click', function() {
    card.classList.toggle('open');
    expandedCards[key] = card.classList.contains('open');
  });
}

function pipelineKind(session) {
  var pipeline = session && session.pipeline || null;
  var kind = pipeline && (pipeline.kind || pipeline.flow) || '';
  if (!kind) return '';
  var status = pipeline && pipeline.status || '';
  var stage = pipeline && pipeline.stage || '';
  if (status && status !== 'running' && status !== 'error' && stage !== 'error') return '';
  return kind;
}

function pipelineMessage(session, fallback) {
  if (session && session.pipeline && session.pipeline.error) return session.pipeline.error;
  if (session && session.pipeline && (session.pipeline.label || session.pipeline.message)) return session.pipeline.label || session.pipeline.message;
  return fallback || '';
}

function pipelineChipLabel(session) {
  if (!session || !session.pipeline || !(session.pipeline.kind || session.pipeline.flow)) return '';
  if (session.pipeline.status === 'error' || session.pipeline.stage === 'error') return 'Failed';
  return session.pipeline.label || session.pipeline.message || 'In progress';
}

function prettyPortfolio(portfolio) {
  return JSON.stringify(portfolio || {}, null, 2);
}

function selectedModel() {
  var model = document.getElementById('model-select').value;
  if (model === 'custom') return document.getElementById('custom-model-input').value.trim() || 'openrouter/free';
  return model;
}

function isGroqModel(model) {
  return /^groq\//.test(String(model || '').trim());
}

function selectedOpenRouterTestModel() {
  var model = selectedModel();
  return isGroqModel(model) ? 'openrouter/free' : model;
}

function selectedGroqTestModel() {
  var model = selectedModel();
  return isGroqModel(model) ? model.replace(/^groq\//, '') : 'llama-3.1-8b-instant';
}

function setCloudActionState(cloud) {
  var signInBtn = document.getElementById('cloud-sign-in-btn');
  var syncBtn = document.getElementById('cloud-sync-btn');
  var signOutBtn = document.getElementById('cloud-sign-out-btn');
  var configured = !!(cloud && cloud.configured);
  var signedIn = !!(cloud && cloud.signedIn);
  var syncEnabled = !!(cloud && cloud.enabled);

  if (signInBtn) {
    signInBtn.classList.toggle('hidden', configured && signedIn);
    signInBtn.disabled = !configured || signedIn;
  }
  if (syncBtn) {
    syncBtn.classList.toggle('hidden', !configured || !signedIn);
    syncBtn.disabled = !configured || !signedIn || !syncEnabled;
  }
  if (signOutBtn) {
    signOutBtn.classList.toggle('hidden', !configured || !signedIn);
    signOutBtn.disabled = !configured || !signedIn;
  }
}

function readFileAsText(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(String(reader.result || '')); };
    reader.onerror = function() { reject(new Error('Could not read file.')); };
    reader.readAsText(file);
  });
}

function normalizePdfText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function limitResumeText(text, maxChars) {
  var cleaned = normalizePdfText(text);
  var limit = maxChars || MAX_IMPORTED_RESUME_TEXT;
  if (cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, limit).replace(/\s+\S*$/, '').trim() + '\n\n[truncated for import]';
}

function renderValidation(validation, sourceLabel) {
  var sourceText = document.getElementById('portfolio-source-text');
  sourceText.textContent = sourceLabel || 'Local file or imported profile';

  var chips = document.getElementById('portfolio-validation');
  chips.innerHTML = '';
  if (!validation) return;
  if (!validation.errors.length && !validation.warnings.length) chips.appendChild(chip('Profile looks complete', ''));
  validation.errors.forEach(function(item) { chips.appendChild(chip(item, 'err')); });
  validation.warnings.forEach(function(item) { chips.appendChild(chip(item, 'warn')); });
}

function initialsForName(name, fallback) {
  var text = String(name || '').trim();
  if (!text) return fallback || 'G';
  var parts = text.split(/\s+/).filter(Boolean).slice(0, 2);
  var out = parts.map(function(part) { return part.charAt(0).toUpperCase(); }).join('');
  return out || (fallback || 'G');
}

function renderTopbarProfile(cloud) {
  var avatar = document.getElementById('topbar-profile-avatar');
  var name = document.getElementById('topbar-profile-name');
  var sub = document.getElementById('topbar-profile-sub');
  if (!avatar || !name || !sub) return;

  avatar.innerHTML = '';
  if (cloud && cloud.signedIn && cloud.user) {
    if (cloud.user.photoURL) {
      var img = document.createElement('img');
      img.src = cloud.user.photoURL;
      img.alt = cloud.user.displayName || cloud.user.email || 'User';
      avatar.appendChild(img);
    } else {
      avatar.textContent = initialsForName(cloud.user.displayName || cloud.user.email, 'U');
    }
    name.textContent = cloud.user.displayName || 'Signed in';
    sub.textContent = cloud.user.email || 'Account connected';
    return;
  }
  avatar.textContent = 'G';
  name.textContent = 'Guest';
  sub.textContent = 'Not signed in';
}

function renderProfileSurface() {
  var ownerName = document.getElementById('profile-owner-name');
  var ownerSub = document.getElementById('profile-owner-sub');
  var ownerChips = document.getElementById('profile-owner-chips');
  var portfolioCopy = document.getElementById('profile-portfolio-copy');
  if (!ownerName || !ownerSub || !ownerChips || !portfolioCopy) return;

  var cloud = lastCloudStatus || null;
  var owner = lastPortfolioOwner || {};
  ownerChips.innerHTML = '';

  if (cloud && cloud.signedIn && cloud.user) {
    ownerName.textContent = cloud.user.displayName || owner.name || 'Signed in';
    ownerSub.textContent = cloud.user.email || 'Account connected';
    if (cloud.lastSyncedAt) ownerChips.appendChild(chip('Last sync ' + fmtDate(cloud.lastSyncedAt), ''));
    ownerChips.appendChild(chip('Cloud connected', ''));
  } else {
    ownerName.textContent = owner.name || 'Guest';
    ownerSub.textContent = owner.email || 'Sign in with Google to keep your profile and sessions backed up.';
    ownerChips.appendChild(chip('Local only', 'warn'));
  }

  if (owner.phone) ownerChips.appendChild(chip(owner.phone, ''));
  if (owner.website) ownerChips.appendChild(chip(owner.website, ''));
  portfolioCopy.textContent = owner.name
    ? 'Current portfolio source: ' + lastPortfolioSource + '. This identity powers your letters, PDF header, and saved artifacts.'
    : 'No active portfolio identity has been loaded yet. Upload JSON or open Resume Import from Settings.';
}

function renderCloudStatus(cloud) {
  lastCloudStatus = cloud || null;
  var summary = document.getElementById('cloud-auth-summary');
  var chips = document.getElementById('cloud-auth-chips');
  if (!summary || !chips) return;

  chips.innerHTML = '';
  if (!cloud || !cloud.configured) {
    summary.textContent = 'Account sign-in is not configured yet.';
    chips.appendChild(chip('Helper missing', 'err'));
    setCloudActionState(cloud || null);
    renderTopbarProfile(cloud || null);
    renderProfileSurface();
    return;
  }

  if (cloud.signedIn && cloud.user) {
    summary.textContent = (cloud.user.displayName || 'Signed in') + (cloud.user.email ? ' — ' + cloud.user.email : '');
    chips.appendChild(chip('Google connected', ''));
    if (cloud.enabled) chips.appendChild(chip('Cloud sync enabled', ''));
    if (cloud.lastSyncedAt) chips.appendChild(chip('Last sync ' + fmtDate(cloud.lastSyncedAt), ''));
  } else {
    summary.textContent = 'Sign in with Google to sync sessions, research, cover letters, and your portfolio across devices.';
    chips.appendChild(chip('Signed out', 'warn'));
  }
  if (cloud.lastError) chips.appendChild(chip(limitText(cloud.lastError, 80), 'err'));
  setCloudActionState(cloud || null);
  renderTopbarProfile(cloud || null);
  renderProfileSurface();
}

function loadCloudStatus() {
  chrome.runtime.sendMessage({ type: 'GET_CLOUD_STATUS' }, function(response) {
    if (!response || response.error) {
      setStatus('cloud-auth-status', 'error', response && response.error || 'Could not load cloud status.');
      return;
    }
    renderCloudStatus(response.cloud || null);
  });
}

function signInToCloud() {
  setStatus('cloud-auth-status', 'loading', 'Opening Google sign-in…');
  chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN' }, function(response) {
    if (!response || response.error) {
      setStatus('cloud-auth-status', 'error', response && response.error || 'Google sign-in failed.');
      loadCloudStatus();
      return;
    }
    renderCloudStatus(response.cloud || null);
    setStatus('cloud-auth-status', 'ok', 'Signed in.');
    loadDashboard();
    loadSettingsSurface();
  });
}

function signOutOfCloud() {
  setStatus('cloud-auth-status', 'loading', 'Signing out…');
  chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_OUT' }, function(response) {
    if (!response || response.error) {
      setStatus('cloud-auth-status', 'error', response && response.error || 'Could not sign out.');
      return;
    }
    renderCloudStatus(response.cloud || null);
    setStatus('cloud-auth-status', 'ok', 'Signed out.');
    loadDashboard();
    loadSettingsSurface();
  });
}

function syncCloudNow() {
  var syncBtn = document.getElementById('cloud-sync-btn');
  var original = syncBtn ? syncBtn.textContent : 'Sync Now';
  if (syncBtn) {
    syncBtn.dataset.originalText = original;
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
  }
  setStatus('cloud-auth-status', 'loading', 'Syncing sessions and portfolio…');
  chrome.runtime.sendMessage({ type: 'SYNC_CLOUD_NOW' }, function(response) {
    if (!response || response.error) {
      if (syncBtn) {
        syncBtn.textContent = original;
        syncBtn.disabled = false;
      }
      setStatus('cloud-auth-status', 'error', response && response.error || 'Could not sync cloud state.');
      loadCloudStatus();
      return;
    }
    renderCloudStatus(response.cloud || null);
    var count = response && response.result && typeof response.result.count === 'number' ? response.result.count : null;
    setStatus('cloud-auth-status', 'ok', count != null ? ('Synced ' + count + ' session' + (count === 1 ? '' : 's') + ' to Firebase.') : 'Synced to Firebase.');
    flashButtonSuccess(syncBtn, '✓ Synced', original);
    loadDashboard();
    loadSettingsSurface();
  });
}

function setActiveSurface(surface, options) {
  var opts = options || {};
  activeSurface = surface;
  document.querySelectorAll('.surface-btn').forEach(function(button) {
    button.classList.toggle('active', button.dataset.surface === surface);
  });
  document.querySelectorAll('.surface-panel').forEach(function(panel) {
    panel.classList.toggle('active', panel.id === 'surface-' + surface);
  });
  if (surface === 'sessions' && !dashboardRefreshInFlight && !opts.skipLoad) loadDashboard();
  if (surface === 'settings' || surface === 'profile') window.location.hash = surface;
  else if (window.location.hash === '#settings' || window.location.hash === '#profile') history.replaceState(null, '', window.location.pathname + window.location.search);
}

function setActiveSessionTab(tab) {
  activeSessionTab = tab;
  document.querySelectorAll('.tab').forEach(function(button) {
    button.classList.toggle('active', button.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(function(panel) {
    panel.classList.toggle('active', panel.id === 'tab-' + tab);
  });
}

function openProfileSurface(event) {
  if (event && event.type === 'keydown') {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
  }
  setActiveSurface('profile');
}

function openSession(session, activeView) {
  var targetUrl = session && session.page && session.page.url || '';
  if (!/^https?:\/\//i.test(targetUrl)) {
    setInlineStatus('session-action-status', 'error', 'This saved item does not have a valid page URL to reopen.');
    return;
  }
  chrome.runtime.sendMessage({
    type: 'UPSERT_PANEL_STATE',
    payload: {
      sessionId: session.id,
      pageUrl: targetUrl,
      panel: { open: true, activeView: activeView || 'generate' }
    }
  }, function() {
    chrome.tabs.create({ url: targetUrl }, function() {
      if (chrome.runtime.lastError) {
        setInlineStatus('session-action-status', 'error', 'Chrome could not reopen this saved page.');
        return;
      }
      setInlineStatus('session-action-status', 'ok', 'Opened the saved job page.');
      setTimeout(function() {
        setInlineStatus('session-action-status', '', '');
      }, 1800);
    });
  });
}

function renderCurrentPortfolio(portfolio, sourceLabel, validation) {
  lastPortfolioOwner = Core.ownerSnapshot(portfolio || {});
  lastPortfolioSource = sourceLabel || 'Current portfolio loaded locally.';
  var editor = document.getElementById('portfolio-editor');
  var sourceText = document.getElementById('portfolio-source-text');
  var chips = document.getElementById('portfolio-validation');
  if (editor) editor.value = prettyPortfolio(portfolio || {});
  if (sourceText) sourceText.textContent = sourceLabel || 'Current portfolio loaded locally.';
  if (!chips) return;
  chips.innerHTML = '';
  var resolved = validation || Core.normalizePortfolio(portfolio || {});
  if (resolved && !resolved.errors.length && !resolved.warnings.length) chips.appendChild(chip('Profile looks complete', ''));
  (resolved.errors || []).forEach(function(item) { chips.appendChild(chip(item, 'err')); });
  (resolved.warnings || []).forEach(function(item) { chips.appendChild(chip(item, 'warn')); });
  renderProfileSurface();
}

function renderDraftPreview(draft, sourceLabel) {
  pendingPortfolioDraft = draft || null;
  var wrap = document.getElementById('portfolio-draft-wrap');
  var editor = document.getElementById('portfolio-draft-editor');
  var sourceText = document.getElementById('portfolio-draft-source');
  var chips = document.getElementById('portfolio-draft-validation');
  if (!wrap || !editor || !sourceText || !chips) return;
  if (!draft || !draft.portfolio) {
    wrap.classList.add('hidden');
    editor.value = '';
    sourceText.textContent = 'Review the imported portfolio JSON before replacing the current one.';
    chips.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  editor.value = prettyPortfolio(draft.portfolio);
  sourceText.textContent = sourceLabel || ('Imported source: ' + (draft.source || 'imported'));
  chips.innerHTML = '';
  (draft.errors || []).forEach(function(item) { chips.appendChild(chip(item, 'err')); });
  (draft.warnings || []).forEach(function(item) { chips.appendChild(chip(item, 'warn')); });
  if (!(draft.errors || []).length && !(draft.warnings || []).length) chips.appendChild(chip('Ready to replace', ''));
}

function clearDraftPreview(statusMessageText) {
  pendingPortfolioDraft = null;
  renderDraftPreview(null);
  chrome.runtime.sendMessage({ type: 'CLEAR_PORTFOLIO_DRAFT' }, function() {
    if (chrome.runtime.lastError) return;
  });
  if (statusMessageText != null) setStatus('portfolio-status', '', statusMessageText);
  setPortfolioProgress(0);
}

function saveCurrentPortfolio(portfolio, source, successMessage) {
  if (!portfolio) {
    setStatus('portfolio-status', 'error', 'There is no portfolio data to save.');
    setPortfolioProgress(0);
    return;
  }
  setStatus('portfolio-status', 'loading', 'Replacing the current portfolio...');
  setPortfolioProgress(82);
  chrome.runtime.sendMessage({
    type: 'SAVE_ACTIVE_PORTFOLIO',
    payload: {
      portfolio: portfolio,
      source: source || 'imported'
    }
  }, function(response) {
    if (!response || response.error) {
      setStatus('portfolio-status', 'error', response && response.error || 'Could not replace the current portfolio.');
      setPortfolioProgress(0);
      return;
    }
    currentDraftSource = source || 'imported';
    renderCurrentPortfolio(portfolio, 'Active source: ' + currentDraftSource, response.validation);
    clearDraftPreview();
    setStatus('portfolio-status', response.validation && response.validation.ok ? 'ok' : 'error', successMessage || (response.validation && response.validation.ok ? 'Current portfolio updated from the extracted text.' : 'Portfolio saved with warnings. Review the validation chips above.'));
    setPortfolioProgress(100);
    flashConfirmToast(response.validation && response.validation.ok ? 'Portfolio Confirmed' : 'Portfolio Saved');
    setTimeout(function() { setPortfolioProgress(0); }, 1500);
  });
}

function openResumeWorkspace() {
  var modal = document.getElementById('resume-workspace-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeResumeWorkspace() {
  var modal = document.getElementById('resume-workspace-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function importResumeTextToPortfolio(text, sourceLabel) {
  var usableText = limitResumeText(String(text || '').trim(), MAX_IMPORTED_RESUME_TEXT);
  if (!usableText) {
    setStatus('portfolio-status', 'error', 'There was no usable text to import.');
    setPortfolioProgress(0);
    return;
  }
  setStatus('portfolio-status', 'loading', 'Extracted text received. Building a portfolio JSON preview...');
  setPortfolioProgress(42);
  chrome.runtime.sendMessage({
    type: 'IMPORT_PORTFOLIO_TEXT',
    payload: {
      text: usableText,
      source: sourceLabel || 'resume_text'
    }
  }, function(response) {
    if (!response || response.error) {
      setStatus('portfolio-status', 'error', response && response.error || 'Could not build portfolio JSON from the extracted text.');
      setPortfolioProgress(0);
      return;
    }
    var draft = response.draft;
    if (!draft || !draft.portfolio) {
      setStatus('portfolio-status', 'error', 'The extracted text did not produce a usable portfolio JSON.');
      setPortfolioProgress(0);
      return;
    }
    renderDraftPreview(draft, 'Resume import preview');
    setStatus('portfolio-status', draft.errors && draft.errors.length ? 'error' : 'ok', 'Review the generated portfolio JSON, then choose whether to replace the current portfolio.');
    setPortfolioProgress(64);
  });
}

function handleWorkspaceMessage(event) {
  var frame = document.getElementById('resume-workspace-frame');
  if (!frame || event.source !== frame.contentWindow) return;
  if (!event.data || event.data.type !== RESUME_WORKSPACE_SOURCE) return;

  var payload = event.data.payload || {};
  var extractedText = String(payload.extractedText || payload.bestText || '').trim();
  if (!extractedText) {
    setStatus('portfolio-status', 'error', 'The resume workspace did not return usable extracted text.');
    setPortfolioProgress(0);
    return;
  }
  setStatus('portfolio-status', 'loading', 'Extracted text received. Building a portfolio JSON preview...');
  setPortfolioProgress(22);
  importResumeTextToPortfolio(extractedText, payload.source || 'resume_workspace');
  closeResumeWorkspace();
}

function buildMetric(label, value) {
  var el = mk('div', 'metric');
  el.appendChild(mk('div', 'k', label));
  el.appendChild(mk('div', 'v', value));
  return el;
}

function analyticsDayKey(iso) {
  if (!iso) return '';
  try {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
  } catch (_) {
    return '';
  }
}

function buildTimelineDays(daysBack) {
  var count = Math.max(1, Number(daysBack) || 10);
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var days = [];
  for (var index = count - 1; index >= 0; index--) {
    var date = new Date(today);
    date.setDate(today.getDate() - index);
    var key = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-');
    days.push({
      key: key,
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      sessions: 0,
      letters: 0,
      qa: 0,
      uniqueCompanies: 0,
      _companyMap: {}
    });
  }
  return days;
}

function buildDashboardAnalytics(daysBack) {
  var buckets = buildTimelineDays(daysBack || 10);
  var byKey = {};
  buckets.forEach(function(bucket) {
    byKey[bucket.key] = bucket;
  });

  sessions.forEach(function(session) {
    var sessionKey = analyticsDayKey(session.createdAt || session.updatedAt || session.page && session.page.lastSeenAt);
    var companyName = String(session && session.job && session.job.companyName || '').trim();
    if (sessionKey && byKey[sessionKey]) {
      byKey[sessionKey].sessions += 1;
      if (companyName) byKey[sessionKey]._companyMap[companyName.toLowerCase()] = companyName;
    }

    (session.artifacts || []).forEach(function(artifact) {
      var artifactKey = analyticsDayKey(artifact.createdAt || session.updatedAt);
      if (artifactKey && byKey[artifactKey]) byKey[artifactKey].letters += 1;
    });

    (session.chat || []).forEach(function(item) {
      var chatKey = analyticsDayKey(item.createdAt || session.updatedAt);
      if (chatKey && byKey[chatKey]) byKey[chatKey].qa += 1;
    });
  });

  buckets.forEach(function(bucket) {
    bucket.uniqueCompanies = Object.keys(bucket._companyMap).length;
    delete bucket._companyMap;
  });

  return buckets;
}

function svgNode(tag, attrs) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.keys(attrs || {}).forEach(function(key) {
    el.setAttribute(key, attrs[key]);
  });
  return el;
}

function sumSeries(points, key) {
  return points.reduce(function(total, point) {
    return total + (Number(point[key]) || 0);
  }, 0);
}

function maxSeries(points, keys) {
  return points.reduce(function(maxValue, point) {
    return Math.max(maxValue, keys.reduce(function(localMax, key) {
      return Math.max(localMax, Number(point[key]) || 0);
    }, 0));
  }, 0);
}

function getChartState(rootId, series) {
  if (!dashboardChartState[rootId]) {
    dashboardChartState[rootId] = {
      showCumulative: true,
      hiddenSeries: {}
    };
  }
  var state = dashboardChartState[rootId];
  (series || []).forEach(function(item) {
    if (typeof state.hiddenSeries[item.key] !== 'boolean') state.hiddenSeries[item.key] = false;
  });
  return state;
}

function buildRunningTotal(points, keys) {
  var total = 0;
  return points.map(function(point) {
    total += keys.reduce(function(sum, key) {
      return sum + (Number(point[key]) || 0);
    }, 0);
    return total;
  });
}

function buildChartTooltip(day, series, cumulativeValue, cumulativeLabel) {
  var tooltip = mk('div', 'chart-tooltip');
  tooltip.appendChild(mk('div', 'chart-tooltip-title', day.label));
  series.forEach(function(definition) {
    var row = mk('div', 'chart-tooltip-row');
    row.appendChild(mk('span', '', definition.label));
    row.appendChild(mk('strong', '', String(day[definition.key] || 0)));
    tooltip.appendChild(row);
  });
  if (typeof cumulativeValue === 'number') {
    var cumulativeRow = mk('div', 'chart-tooltip-row');
    cumulativeRow.appendChild(mk('span', '', cumulativeLabel || 'Cumulative'));
    cumulativeRow.appendChild(mk('strong', '', String(cumulativeValue)));
    tooltip.appendChild(cumulativeRow);
  }
  return tooltip;
}

function renderTimelineChart(rootId, config) {
  var root = document.getElementById(rootId);
  if (!root) return;
  root.innerHTML = '';
  var points = config && config.points || [];

  var state = getChartState(rootId, config.series || []);
  var activeSeries = (config.series || []).filter(function(definition) {
    return !state.hiddenSeries[definition.key];
  });
  if (!activeSeries.length) activeSeries = (config.series || []).slice(0, 1);

  var hasData = points.some(function(point) {
    return activeSeries.some(function(definition) { return Number(point[definition.key]) > 0; });
  });
  var shell = mk('div', 'chart-shell');
  var controls = mk('div', 'chart-controls');
  var legend = mk('div', 'chart-legend');
  (config.series || []).forEach(function(definition) {
    var button = mk('button', 'legend-btn' + (state.hiddenSeries[definition.key] ? ' inactive' : ''));
    button.type = 'button';
    var swatch = mk('span', 'legend-swatch');
    swatch.style.background = definition.color;
    button.appendChild(swatch);
    button.appendChild(mk('span', '', definition.label));
    button.addEventListener('click', function() {
      var visibleCount = (config.series || []).filter(function(item) { return !state.hiddenSeries[item.key]; }).length;
      if (visibleCount <= 1 && !state.hiddenSeries[definition.key]) return;
      state.hiddenSeries[definition.key] = !state.hiddenSeries[definition.key];
      renderTimelineChart(rootId, config);
    });
    legend.appendChild(button);
  });
  controls.appendChild(legend);
  var cumulativeToggle = mk('button', 'chart-toggle' + (state.showCumulative ? '' : ' inactive'), state.showCumulative ? 'Cumulative On' : 'Cumulative Off');
  cumulativeToggle.type = 'button';
  cumulativeToggle.addEventListener('click', function() {
    state.showCumulative = !state.showCumulative;
    renderTimelineChart(rootId, config);
  });
  controls.appendChild(cumulativeToggle);
  shell.appendChild(controls);

  if (!hasData) {
    shell.appendChild(mk('div', 'chart-empty', 'No activity yet. Generate a few sessions and the trend will appear here.'));
    root.appendChild(shell);
    return;
  }

  var stage = mk('div', 'chart-stage');
  var width = 860;
  var height = 320;
  var margin = { top: 18, right: 24, bottom: 56, left: 36 };
  var plotWidth = width - margin.left - margin.right;
  var plotHeight = height - margin.top - margin.bottom;
  var maxBarValue = Math.max(1, maxSeries(points, activeSeries.map(function(item) { return item.key; })));
  var cumulativeValues = buildRunningTotal(points, config.cumulativeKeys || activeSeries.map(function(item) { return item.key; }));
  var maxCumulativeValue = Math.max(1, cumulativeValues.reduce(function(maxValue, value) { return Math.max(maxValue, value); }, 0));
  var svg = svgNode('svg', {
    viewBox: '0 0 ' + width + ' ' + height,
    class: 'chart-svg',
    role: 'img',
    'aria-label': config.ariaLabel || 'Dashboard timeline chart'
  });

  [0, 0.33, 0.66, 1].forEach(function(ratio) {
    var y = margin.top + plotHeight - (plotHeight * ratio);
    svg.appendChild(svgNode('line', {
      x1: margin.left,
      y1: y,
      x2: width - margin.right,
      y2: y,
      stroke: 'rgba(148,163,184,0.15)',
      'stroke-width': '1'
    }));
  });

  var dayWidth = plotWidth / Math.max(1, points.length);
  var groupWidth = Math.min(74, dayWidth * 0.68);
  var barWidth = Math.max(10, Math.min(22, groupWidth / Math.max(1, activeSeries.length)));
  var linePath = [];
  var tooltip = mk('div', 'chart-tooltip');
  stage.appendChild(tooltip);

  points.forEach(function(point, index) {
    var xCenter = margin.left + (dayWidth * index) + (dayWidth / 2);
    var xBase = xCenter - ((barWidth * activeSeries.length) / 2);
    activeSeries.forEach(function(definition, seriesIndex) {
      var value = Number(point[definition.key]) || 0;
      var barHeight = (value / maxBarValue) * plotHeight;
      var x = xBase + (seriesIndex * barWidth);
      var y = margin.top + plotHeight - barHeight;
      var rect = svgNode('rect', {
        x: x,
        y: y,
        width: Math.max(8, barWidth - 4),
        height: Math.max(3, barHeight),
        rx: '5',
        fill: definition.color
      });
      svg.appendChild(rect);
    });

    if (state.showCumulative) {
      var cumulativeValue = cumulativeValues[index];
      var lineY = margin.top + plotHeight - ((cumulativeValue / maxCumulativeValue) * plotHeight);
      linePath.push((index ? 'L' : 'M') + xCenter + ' ' + lineY);
      var pointDot = svgNode('circle', {
        cx: xCenter,
        cy: lineY,
        r: '4',
        fill: config.cumulativeColor || '#f8fafc',
        stroke: 'rgba(15,15,24,0.88)',
        'stroke-width': '2'
      });
      svg.appendChild(pointDot);
    }

    var label = svgNode('text', {
      x: xCenter,
      y: height - 16,
      fill: '#94a3b8',
      'font-size': '12',
      'text-anchor': 'middle'
    });
    label.textContent = point.label.replace(' ', '\u00A0');
    svg.appendChild(label);

    var hitbox = svgNode('rect', {
      x: margin.left + (dayWidth * index),
      y: margin.top,
      width: dayWidth,
      height: plotHeight,
      fill: 'transparent'
    });
    hitbox.addEventListener('mouseenter', function() {
      tooltip.innerHTML = '';
      var tip = buildChartTooltip(point, activeSeries, cumulativeValues[index], config.cumulativeLabel || 'Cumulative');
      while (tip.firstChild) tooltip.appendChild(tip.firstChild);
      tooltip.classList.add('show');
    });
    hitbox.addEventListener('mousemove', function(event) {
      var bounds = stage.getBoundingClientRect();
      var tooltipWidth = 200;
      var left = Math.min(bounds.width - tooltipWidth - 8, Math.max(8, event.clientX - bounds.left + 14));
      var top = Math.max(8, event.clientY - bounds.top - 18);
      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
    });
    hitbox.addEventListener('mouseleave', function() {
      tooltip.classList.remove('show');
    });
    svg.appendChild(hitbox);
  });

  if (state.showCumulative && linePath.length) {
    svg.appendChild(svgNode('path', {
      d: linePath.join(' '),
      fill: 'none',
      stroke: config.cumulativeColor || '#f8fafc',
      'stroke-width': '3',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    }));
  }

  stage.appendChild(svg);
  shell.appendChild(stage);
  shell.appendChild(mk('div', 'chart-hint', 'Last 7 days · Hover each day for details'));
  root.appendChild(shell);
}

function renderDashboardAnalytics() {
  var activityRoot = document.getElementById('dashboard-activity-chart');
  var companyRoot = document.getElementById('dashboard-company-chart');
  if (!activityRoot || !companyRoot) return;

  var timeline = buildDashboardAnalytics(7);

  renderTimelineChart(
    'dashboard-activity-chart',
    {
    points: timeline,
    series: [
      { key: 'sessions', label: 'Sessions', color: 'rgba(129,140,248,0.94)' },
      { key: 'letters', label: 'Cover letters', color: 'rgba(74,222,128,0.92)' },
      { key: 'qa', label: 'Q&A', color: 'rgba(251,191,36,0.9)' }
    ],
    cumulativeKeys: ['sessions', 'letters', 'qa'],
    cumulativeLabel: 'Cumulative activity',
    cumulativeColor: '#f8fafc',
    ariaLabel: 'Activity timeline over the last seven days'
    }
  );

  renderTimelineChart(
    'dashboard-company-chart',
    {
    points: timeline,
    series: [
      { key: 'uniqueCompanies', label: 'Unique companies', color: 'rgba(139,92,246,0.94)' },
      { key: 'sessions', label: 'Sessions', color: 'rgba(96,165,250,0.9)' }
    ],
    cumulativeKeys: ['uniqueCompanies'],
    cumulativeLabel: 'Cumulative companies',
    cumulativeColor: '#f8fafc',
    ariaLabel: 'Company timeline over the last seven days'
    }
  );
}

function latestArtifactWithOwner(session) {
  var resumes = session && session.resumes || [];
  for (var r = 0; r < resumes.length; r++) {
    var resumeOwner = resumes[r] && resumes[r].owner || {};
    if (resumeOwner.name || resumeOwner.email || resumeOwner.phone || resumeOwner.website) return resumes[r];
  }
  var artifacts = session && session.artifacts || [];
  for (var i = 0; i < artifacts.length; i++) {
    var owner = artifacts[i] && artifacts[i].owner || {};
    if (owner.name || owner.email || owner.phone || owner.website) return artifacts[i];
  }
  return null;
}

function buildResumeEntries() {
  var items = [];
  sessions.forEach(function(session) {
    var resumes = session && session.resumes || [];
    resumes.forEach(function(artifact) {
      items.push({
        session: session,
        artifact: artifact,
        owner: artifact.owner || {}
      });
    });
  });
  items.sort(function(a, b) {
    return new Date(b.artifact.createdAt || b.session.updatedAt || 0) - new Date(a.artifact.createdAt || a.session.updatedAt || 0);
  });
  return items;
}

function sameIdentity(owner, activeOwner) {
  var left = owner || {};
  var right = activeOwner || {};
  return (
    String(left.name || '').trim().toLowerCase() === String(right.name || '').trim().toLowerCase() &&
    String(left.email || '').trim().toLowerCase() === String(right.email || '').trim().toLowerCase() &&
    String(left.phone || '').trim() === String(right.phone || '').trim() &&
    String(left.website || '').trim().toLowerCase() === String(right.website || '').trim().toLowerCase()
  );
}

function buildQAReplyCard(session, item) {
  var card = mk('article', 'card');
  var header = mk('div', 'card-header');
  var left = mk('div', 'card-left');
  left.appendChild(mk('div', 'session-title', session.job && session.job.companyName ? (session.job.jobTitle || 'Untitled role') + ' at ' + session.job.companyName : (session.title || 'Q&A reply')));
  left.appendChild(mk('div', 'session-sub', item.question || ''));
  var meta = mk('div', 'session-meta');
  meta.appendChild(mk('span', 'pill', fmtDate(item.createdAt)));
  meta.appendChild(mk('span', 'pill gray', item.model || '—'));
  if (!item.answer && pipelineKind(session) === 'ask') meta.appendChild(mk('span', 'pill gray', pipelineChipLabel(session) || 'In progress'));
  left.appendChild(meta);
  header.appendChild(left);
  var actions = mk('div', 'header-actions');
  var copyBtn = mk('button', 'btn', 'Copy');
  copyBtn.addEventListener('click', function(event) {
    event.stopPropagation();
    copyText(item.answer || '', copyBtn);
  });
  actions.appendChild(copyBtn);
  header.appendChild(actions);
  header.appendChild(mk('div', 'chev', '▶'));
  bindCardExpansion(card, header, cardStateKey('qa', item.id || (session.id + ':pending')));
  card.appendChild(header);

  var body = mk('div', 'card-body');
  var section = mk('section', 'section');
  section.appendChild(mk('h3', '', 'Answer'));
  var output = document.createElement('textarea');
  output.readOnly = true;
  output.value = item.answer
    ? 'Q: ' + (item.question || '') + '\n\nA: ' + (item.answer || '')
    : pipelineMessage(session, 'CoverCraft is still generating this answer.');
  section.appendChild(output);
  var actionsRow = mk('div', 'copy-row');
  var openBtn = mk('button', 'btn', 'Open In Session');
  openBtn.addEventListener('click', function(event) {
    event.stopPropagation();
    openSession(session);
  });
  actionsRow.appendChild(openBtn);
  section.appendChild(actionsRow);
  body.appendChild(section);
  card.appendChild(body);
  return card;
}

function buildResearchCard(session) {
  var extractActivity = latestActivityOfType(session, 'extract');
  var card = mk('article', 'card');
  var header = mk('div', 'card-header');
  var left = mk('div', 'card-left');
  left.appendChild(mk('div', 'session-title', session.job && session.job.companyName ? (session.job.jobTitle || 'Untitled role') + ' at ' + session.job.companyName : (session.title || 'Research cache')));
  left.appendChild(mk('div', 'session-sub', session.research.query1 || (extractActivity ? extractionMethodLabel(extractActivity) : '')));
  var meta = mk('div', 'session-meta');
  if (extractActivity) meta.appendChild(mk('span', 'pill', extractionMethodLabel(extractActivity)));
  meta.appendChild(mk('span', 'pill', session.research.sources && session.research.sources.length ? session.research.sources.length + ' sources' : 'No sources'));
  meta.appendChild(mk('span', 'pill gray', fmtDate(session.research.fetchedAt || extractActivity && extractActivity.createdAt || session.updatedAt)));
  if (session.research.reusedFromSessionId) meta.appendChild(mk('span', 'pill gray', 'Reused cache'));
  if (!session.research.summary && (pipelineKind(session) === 'refresh' || pipelineKind(session) === 'generate' || pipelineKind(session) === 'ask' || pipelineKind(session) === 'resume')) {
    meta.appendChild(mk('span', 'pill gray', pipelineChipLabel(session) || 'In progress'));
  }
  left.appendChild(meta);
  header.appendChild(left);
  header.appendChild(mk('div', 'chev', '▶'));
  bindCardExpansion(card, header, cardStateKey('research', session.id));
  card.appendChild(header);

  var body = mk('div', 'card-body');
  var section = mk('section', 'section');
  if (extractActivity) {
    section.appendChild(mk('h3', '', 'Job Identity Extraction'));
    var extractionGrid = mk('div', 'mini-grid');
    extractionGrid.appendChild(buildMetric('Method', extractionMethodLabel(extractActivity)));
    extractionGrid.appendChild(buildMetric('Model', extractActivity.model || extractActivity.payload && extractActivity.payload.model || '—'));
    extractionGrid.appendChild(buildMetric('Created', fmtDate(extractActivity.createdAt || session.updatedAt)));
    extractionGrid.appendChild(buildMetric('Company', session.job && session.job.companyName || 'Unknown company'));
    extractionGrid.appendChild(buildMetric('Job title', session.job && session.job.jobTitle || 'Untitled role'));
    section.appendChild(extractionGrid);
  }
  section.appendChild(mk('h3', '', 'Research Summary'));
  section.appendChild(mk('pre', '', session.research.summary || pipelineMessage(session, 'Research is still being collected.')));
  section.appendChild(mk('h3', '', 'Sources'));
  section.appendChild(buildSourceList(session));
  var actions = mk('div', 'copy-row');
  var openBtn = mk('button', 'btn', 'Open In Session');
  openBtn.addEventListener('click', function(event) {
    event.stopPropagation();
    openSession(session);
  });
  actions.appendChild(openBtn);
  section.appendChild(actions);
  body.appendChild(section);
  card.appendChild(body);
  return card;
}

function buildResumeCard(entry) {
  var session = entry.session;
  var artifact = entry.artifact;
  var owner = entry.owner || {};
  var activeMatch = sameIdentity(owner, lastPortfolioOwner || {});

  var card = mk('article', 'card');
  var header = mk('div', 'card-header');
  var left = mk('div', 'card-left');
  left.appendChild(mk('div', 'session-title', owner.name || 'Saved resume profile'));
  left.appendChild(mk('div', 'session-sub', session.job && session.job.companyName
    ? (session.job.jobTitle || 'Untitled role') + ' at ' + session.job.companyName
    : (session.title || 'Portfolio-linked session')));
  var meta = mk('div', 'session-meta');
  meta.appendChild(mk('span', 'pill', fmtDate(artifact.createdAt || session.updatedAt)));
  meta.appendChild(mk('span', 'pill gray', artifact.model || '—'));
  if (artifact.outputWords) meta.appendChild(mk('span', 'pill gray', artifact.outputWords + ' words'));
  if (artifact.modifications && artifact.modifications.modifiedBulletCount) {
    meta.appendChild(mk('span', 'pill gray', artifact.modifications.modifiedBulletCount + ' bullets changed'));
  }
  if (activeMatch) meta.appendChild(mk('span', 'pill', 'Current active profile'));
  left.appendChild(meta);
  header.appendChild(left);
  header.appendChild(mk('div', 'chev', '▶'));
  bindCardExpansion(card, header, cardStateKey('resume', artifact.id || session.id));
  card.appendChild(header);

  var body = mk('div', 'card-body');
  var stack = mk('div', 'section-stack');

  var identitySection = mk('section', 'section');
  identitySection.appendChild(mk('h3', '', 'Identity Snapshot'));
  var identityGrid = mk('div', 'mini-grid');
  identityGrid.appendChild(buildMetric('Name', owner.name || '—'));
  identityGrid.appendChild(buildMetric('Email', owner.email || '—'));
  identityGrid.appendChild(buildMetric('Phone', owner.phone || '—'));
  identityGrid.appendChild(buildMetric('Website', owner.website || '—'));
  identitySection.appendChild(identityGrid);
  stack.appendChild(identitySection);

  var sessionSection = mk('section', 'section');
  sessionSection.appendChild(mk('h3', '', 'Target Role'));
  var sessionGrid = mk('div', 'mini-grid');
  sessionGrid.appendChild(buildMetric('Role', session.job && session.job.jobTitle || 'Untitled role'));
  sessionGrid.appendChild(buildMetric('Company', session.job && session.job.companyName || 'Unknown company'));
  sessionGrid.appendChild(buildMetric('Last updated', fmtDate(session.updatedAt)));
  sessionGrid.appendChild(buildMetric('Source', session.page && session.page.hostname || 'Saved session'));
  sessionSection.appendChild(sessionGrid);
  stack.appendChild(sessionSection);

  var changeSection = mk('section', 'section');
  changeSection.appendChild(mk('h3', '', 'Tailoring Summary'));
  var modifications = artifact.modifications || {};
  var changeGrid = mk('div', 'mini-grid');
  changeGrid.appendChild(buildMetric('Modified bullets', String(modifications.modifiedBulletCount || 0)));
  changeGrid.appendChild(buildMetric('Skills included', String(modifications.finalSkillsCount || modifications.skillsCount || 0)));
  changeGrid.appendChild(buildMetric('Skills added', String(Array.isArray(modifications.addedSkills) ? modifications.addedSkills.length : 0)));
  changeGrid.appendChild(buildMetric('Base skills', String(modifications.baseSkillsCount || 0)));
  changeSection.appendChild(changeGrid);
  var changedRoles = Array.isArray(modifications.modifiedExperienceTitles) ? modifications.modifiedExperienceTitles.filter(Boolean) : [];
  var experienceChanges = Array.isArray(modifications.experienceChanges) ? modifications.experienceChanges : [];
  var summaryLines = [];
  if (changedRoles.length) summaryLines.push(changedRoles.join(', '));
  if (experienceChanges.length) {
    summaryLines.push(experienceChanges.map(function(item) {
      return (item.role || item.company || 'Experience') + ': ' + (item.changedBulletCount || 0) + ' bullet' + ((item.changedBulletCount || 0) === 1 ? '' : 's');
    }).join('\n'));
  }
  if (Array.isArray(modifications.addedSkills) && modifications.addedSkills.length) {
    summaryLines.push('Added skills: ' + modifications.addedSkills.join(', '));
  }
  changeSection.appendChild(mk('pre', '', summaryLines.length ? summaryLines.join('\n\n') : 'No experience bullets were changed for this tailored resume.'));
  stack.appendChild(changeSection);

  var draftSection = mk('section', 'section');
  draftSection.appendChild(mk('h3', '', 'Resume LaTeX'));
  if (artifact.latexSource) {
    var output = document.createElement('textarea');
    output.readOnly = true;
    output.value = artifact.latexSource;
    draftSection.appendChild(output);
  } else {
    draftSection.appendChild(mk('pre', '', 'No resume LaTeX is stored for this session yet.'));
  }
  stack.appendChild(draftSection);

  var actionSection = mk('section', 'section');
  actionSection.appendChild(mk('h3', '', 'Session Actions'));
  var actionRow = mk('div', 'copy-row');
  if (artifact.latexSource) {
    var copyLatexBtn = mk('button', 'btn', 'Copy LaTeX');
    copyLatexBtn.addEventListener('click', function(event) {
      event.stopPropagation();
      copyText(artifact.latexSource || '', copyLatexBtn);
    });
    actionRow.appendChild(copyLatexBtn);
    var texBtn = mk('button', 'btn btn-green', 'Download LaTeX');
    texBtn.addEventListener('click', function(event) {
      event.stopPropagation();
      if (!artifact.latexSource) return;
      var fileName = ((artifact.jobTitle || (session.job && session.job.jobTitle) || 'Resume') + ((artifact.company || (session.job && session.job.companyName) || '') ? '_' + (artifact.company || (session.job && session.job.companyName) || '') : '') + '_Resume.tex')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .replace(/_+/g, '_');
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_TEXT_FILE',
        payload: {
          text: artifact.latexSource,
          fileName: fileName,
          mimeType: 'text/x-tex'
        }
      }, function(response) {
        if (!response || response.error) {
          var original = texBtn.textContent;
          texBtn.textContent = 'Download Failed';
          setTimeout(function() {
            texBtn.textContent = original;
          }, 2600);
          return;
        }
        var previous = texBtn.textContent;
        texBtn.textContent = 'Downloaded';
        setTimeout(function() {
          texBtn.textContent = previous;
        }, 1600);
      });
    });
    actionRow.appendChild(texBtn);
  }
  var openBtn = mk('button', 'btn', 'Open In Session');
  openBtn.addEventListener('click', function(event) {
    event.stopPropagation();
    openSession(session, 'resume');
  });
  actionRow.appendChild(openBtn);
  actionSection.appendChild(actionRow);
  stack.appendChild(actionSection);

  body.appendChild(stack);
  card.appendChild(body);
  return card;
}

function buildSourceList(session) {
  var wrap = document.createElement('div');
  var sources = session.research && session.research.sources || [];
  if (!sources.length) {
    wrap.appendChild(mk('div', 'source', 'No research sources saved yet.'));
    return wrap;
  }
  sources.slice(0, 10).forEach(function(source) {
    var card = mk('div', 'source');
    card.appendChild(mk('div', 'title', source.title || 'Untitled source'));
    card.appendChild(mk('div', 'url', source.url || ''));
    card.appendChild(mk('div', 'snippet', source.snippet || ''));
    wrap.appendChild(card);
  });
  if (sources.length > 10) wrap.appendChild(mk('div', 'source', 'Showing top 10 sources only.'));
  return wrap;
}

function latestActivityOfType(session, type) {
  var activities = session && session.activities || [];
  for (var i = 0; i < activities.length; i++) {
    if (activities[i] && activities[i].type === type) return activities[i];
  }
  return null;
}

function extractionMethodLabel(extractActivity) {
  var method = extractActivity && extractActivity.payload && extractActivity.payload.method || '';
  if (method === 'ai') return 'AI extraction';
  if (method === 'heuristic') return 'Heuristic extraction';
  if (method === 'ai_plus_heuristic') return 'AI + heuristic';
  return 'Extraction';
}

function buildPromptContextSection(session, artifact) {
  var section = mk('div', 'context-summary');
  section.appendChild(mk('h3', '', 'Prompt Context'));
  section.appendChild(mk('div', 'section-note', 'CoverCraft saves the exact prompt text used for generation when available, including the embedded portfolio JSON and cached job context.'));

  var prompt = artifact && artifact.prompt || null;
  if (prompt && (prompt.system || prompt.user)) {
    var shell = mk('div', 'prompt-shell');
    if (prompt.system) {
      shell.appendChild(mk('div', 'label', 'System Prompt'));
      var systemText = document.createElement('textarea');
      systemText.readOnly = true;
      systemText.value = prompt.system;
      shell.appendChild(systemText);
    }
    if (prompt.user) {
      shell.appendChild(mk('div', 'label', 'User Prompt'));
      var userText = document.createElement('textarea');
      userText.readOnly = true;
      userText.value = prompt.user;
      shell.appendChild(userText);
    }
    section.appendChild(shell);
    return section;
  }

  var contextGrid = mk('div', 'context-grid');
  contextGrid.appendChild(mk('span', 'pill', 'Portfolio JSON embedded'));
  contextGrid.appendChild(mk('span', 'pill', (artifact && artifact.style) || session.latestStyle || 'formal'));
  contextGrid.appendChild(mk('span', 'pill', (artifact && artifact.model) || session.latestModel || '—'));
  section.appendChild(contextGrid);

  section.appendChild(mk('div', 'label', 'Prompt Summary'));
  section.appendChild(mk('pre', '', JSON.stringify({
    portfolioOwner: artifact && artifact.owner || {},
    page: session.page || {},
    job: session.job || {},
    research: session.research || {},
    scrapePreview: session.scrape && session.scrape.preview || ''
  }, null, 2)));
  return section;
}

function buildGenerationSnapshotSection(session, artifact) {
  var section = mk('section', 'section section-stack');
  section.appendChild(mk('h3', '', 'Generation Snapshot'));
  section.appendChild(mk('div', 'section-note', 'A compact summary of what was injected into the model for this letter, so the context stays auditable.'));

  var grid = mk('div', 'context-grid');
  [
    session.job && session.job.jobTitle ? session.job.jobTitle : 'Untitled role',
    session.job && session.job.companyName ? session.job.companyName : 'Unknown company',
    artifact && artifact.style || session.latestStyle || 'formal',
    artifact && artifact.model || session.latestModel || '—',
    artifact && artifact.owner && artifact.owner.name ? artifact.owner.name : 'Saved portfolio',
    session.scrape && session.scrape.wordCount ? session.scrape.wordCount + ' scraped words' : 'No scrape count'
  ].forEach(function(value) {
    grid.appendChild(chip(value, ''));
  });
  section.appendChild(grid);

  var pre = document.createElement('pre');
  pre.textContent = JSON.stringify({
    page: session.page || {},
    job: session.job || {},
    portfolioOwner: artifact && artifact.owner || {},
    researchSummary: session.research && session.research.summary || '',
    researchSources: session.research && session.research.sources ? session.research.sources.length : 0,
    scrapePreview: session.scrape && session.scrape.preview || ''
  }, null, 2);
  section.appendChild(pre);
  return section;
}

function buildLetterCard(session, artifact) {
  var card = mk('article', 'card');
  var header = mk('div', 'card-header');
  var left = mk('div', 'card-left');
  var title = session.job && session.job.companyName
    ? (session.job.jobTitle || 'Untitled role') + ' at ' + session.job.companyName
    : (session.title || 'Untitled session');

  left.appendChild(mk('div', 'session-title', title));
  left.appendChild(mk('div', 'session-sub', fmtDate(artifact && artifact.createdAt || session.updatedAt)));
  var meta = mk('div', 'session-meta');
  meta.appendChild(mk('span', 'pill', artifact ? artifact.outputWords + ' words' : 'No letter yet'));
  meta.appendChild(mk('span', 'pill gray', artifact && artifact.style || 'formal'));
  meta.appendChild(mk('span', 'pill gray', artifact && artifact.model || '—'));
  if (!artifact && (pipelineKind(session) === 'generate' || pipelineKind(session) === 'refresh')) {
    meta.appendChild(mk('span', 'pill gray', pipelineChipLabel(session) || 'In progress'));
  }
  left.appendChild(meta);
  header.appendChild(left);
  if (artifact && artifact.text) {
    var actions = mk('div', 'header-actions');
    actions.classList.add('centered');
    var copyBtn = mk('button', 'btn', 'Copy');
    copyBtn.addEventListener('click', function(event) {
      event.stopPropagation();
      copyText(artifact.text || '', copyBtn);
    });
    actions.appendChild(copyBtn);
    var pdfBtn = mk('button', 'btn btn-green', 'Download PDF');
    pdfBtn.addEventListener('click', function(event) {
      event.stopPropagation();
      var payload = CoverCraftPdf.buildCoverLetterPdfDownload({
        text: artifact.text,
        jobTitle: session.job && session.job.jobTitle || 'Cover Letter',
        company: session.job && session.job.companyName || '',
        owner: artifact.owner || {}
      });
      if (!payload) return;
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PDF_DATA_URL',
        payload: {
          dataUrl: payload.dataUrl,
          fileName: payload.fileName
        }
      }, function() {});
    });
    actions.appendChild(pdfBtn);
    header.appendChild(actions);
  }
  header.appendChild(mk('div', 'chev', '▶'));
  bindCardExpansion(card, header, cardStateKey('letter', artifact ? artifact.id : (session.id + ':pending')));
  card.appendChild(header);

  var body = mk('div', 'card-body');
  var stack = mk('div', 'section-stack');

  stack.appendChild(buildPromptContextSection(session, artifact));

  var leftSection = mk('section', 'section');
  leftSection.appendChild(mk('h3', '', 'Cover Letter'));
  if (artifact && artifact.text) {
    var output = document.createElement('textarea');
    output.readOnly = true;
    output.value = artifact.text;
    leftSection.appendChild(output);
  } else {
    leftSection.appendChild(mk('pre', '', pipelineMessage(session, 'No cover letter has been generated for this session yet.')));
  }
  var metricsWrap = mk('div', 'mini-grid');
  metricsWrap.appendChild(buildMetric('Created', fmtDate(artifact && artifact.createdAt || session.updatedAt)));
  metricsWrap.appendChild(buildMetric('Words scraped', String(session.scrape && session.scrape.wordCount || 0)));
  metricsWrap.appendChild(buildMetric('Style', artifact && artifact.style || session.latestStyle || 'formal'));
  metricsWrap.appendChild(buildMetric('Model', artifact && artifact.model || session.latestModel || '—'));
  leftSection.appendChild(metricsWrap);
  stack.appendChild(leftSection);

  var rightSection = buildGenerationSnapshotSection(session, artifact);
  stack.appendChild(rightSection);

  var researchSection = mk('section', 'section');
  researchSection.appendChild(mk('h3', '', 'Cached Research'));
  if (session.research && session.research.summary) researchSection.appendChild(mk('pre', '', session.research.summary));
  else researchSection.appendChild(mk('pre', '', 'No company research is cached yet.'));
  stack.appendChild(researchSection);

  var sourcesSection = mk('section', 'section');
  sourcesSection.appendChild(mk('h3', '', 'Sources'));
  sourcesSection.appendChild(buildSourceList(session));
  stack.appendChild(sourcesSection);

  var actionsSection = mk('section', 'section');
  actionsSection.appendChild(mk('h3', '', 'Session Actions'));
  var actionRow = mk('div', 'copy-row');
  var openBtn = mk('button', 'btn', 'Open In Session');
  openBtn.addEventListener('click', function() { openSession(session); });
  actionRow.appendChild(openBtn);
  actionsSection.appendChild(actionRow);
  stack.appendChild(actionsSection);

  body.appendChild(stack);
  card.appendChild(body);
  return card;
}

function renderDashboardStats() {
  var root = document.getElementById('stats');
  root.innerHTML = '';
  var totalArtifacts = sessions.reduce(function(sum, session) { return sum + ((session.artifacts || []).length); }, 0);
  var totalChats = sessions.reduce(function(sum, session) { return sum + ((session.chat || []).length); }, 0);
  var resumeEntries = buildResumeEntries();
  var companies = {};
  var reusedResearchCount = 0;
  sessions.forEach(function(session) {
    var company = session.job && session.job.companyName || 'Unknown';
    companies[company] = 1;
    if (session.research && session.research.reusedFromSessionId) reusedResearchCount++;
  });
  [
    [sessions.length, 'Sessions'],
    [totalArtifacts, 'Cover Letters'],
    [totalChats, 'Q&A Replies'],
    [Object.keys(companies).length, 'Unique Companies'],
    [resumeEntries.length, 'Resume Sessions']
  ].forEach(function(item) {
    var stat = mk('div', 'stat');
    stat.appendChild(mk('div', 'num', item[0]));
    stat.appendChild(mk('div', 'lbl', item[1]));
    root.appendChild(stat);
  });

  var summary = document.getElementById('dashboard-summary');
  summary.innerHTML = '';
  summary.appendChild(buildMetric('Cached research reuse', reusedResearchCount + ' sessions'));
  summary.appendChild(buildMetric('Latest session', sessions[0] ? fmtDate(sessions[0].updatedAt) : '—'));
  summary.appendChild(buildMetric('Top 10 default', Math.min(sessions.length, SESSION_LIMIT) + ' visible rows'));
  summary.appendChild(buildMetric('Research-ready sessions', sessions.filter(function(session) { return session.research && session.research.summary; }).length));
  summary.appendChild(buildMetric('Resume-linked sessions', resumeEntries.length));
  summary.appendChild(buildMetric('Active profile', lastPortfolioOwner && lastPortfolioOwner.name ? lastPortfolioOwner.name : 'Guest'));

  var watchlist = document.getElementById('dashboard-watchlist');
  watchlist.innerHTML = '';
  watchlist.appendChild(buildMetric('Tavily savings', reusedResearchCount ? reusedResearchCount + ' repeat-company lookups reused cached research.' : 'No repeated-company reuse yet.'));
  watchlist.appendChild(buildMetric('Portfolio coverage', sessions.length ? 'Portfolio imports and active profile are available from Settings.' : 'No session data yet.'));
  watchlist.appendChild(buildMetric('Resume continuity', resumeEntries.length ? resumeEntries.filter(function(entry) { return sameIdentity(entry.owner, lastPortfolioOwner || {}); }).length + ' saved sessions match the current active profile.' : 'No saved resume-linked sessions yet.'));
  watchlist.appendChild(buildMetric('Trend layer', sessions.length ? 'Activity and company timelines are now live above for the latest 10 days.' : 'Trend charts will light up once session activity is recorded.'));
  renderDashboardAnalytics();
}

function renderLettersTab() {
  var root = document.getElementById('letters');
  root.innerHTML = '';
  var letters = [];
  var pending = [];
  sessions.forEach(function(session) {
    (session.artifacts || []).forEach(function(artifact) {
      letters.push({ session: session, artifact: artifact });
    });
    if (!(session.artifacts || []).length && (pipelineKind(session) === 'generate' || pipelineKind(session) === 'refresh')) {
      pending.push({ session: session, artifact: null });
    }
  });
  letters.sort(function(a, b) {
    return new Date(b.artifact.createdAt || b.session.updatedAt || 0) - new Date(a.artifact.createdAt || a.session.updatedAt || 0);
  });
  pending.sort(function(a, b) {
    return new Date(b.session.updatedAt || 0) - new Date(a.session.updatedAt || 0);
  });
  var letterCountText = letters.length + ' letters';
  if (pending.length) letterCountText += ' · ' + pending.length + ' in progress';
  document.getElementById('letters-count').textContent = letterCountText;
  if (!letters.length && !pending.length) {
    root.innerHTML = '<div class="empty">No generated cover letters yet.</div>';
    return;
  }
  letters.slice(0, 10).forEach(function(item) {
    root.appendChild(buildLetterCard(item.session, item.artifact));
  });
  pending.slice(0, 10).forEach(function(item) {
    root.appendChild(buildLetterCard(item.session, item.artifact));
  });
}

function renderQATab() {
  var root = document.getElementById('qa');
  root.innerHTML = '';
  var answers = [];
  var pending = [];
  sessions.forEach(function(session) {
    (session.chat || []).forEach(function(item) {
      answers.push({ session: session, item: item });
    });
    if (!(session.chat || []).length && pipelineKind(session) === 'ask') {
      pending.push({
        session: session,
        item: {
          id: session.id + ':pending',
          createdAt: session.pipeline && session.pipeline.updatedAt || session.updatedAt,
          question: '',
          answer: '',
          model: session.latestModel || '—'
        }
      });
    }
  });
  answers.sort(function(a, b) {
    return new Date(b.item.createdAt || b.session.updatedAt || 0) - new Date(a.item.createdAt || a.session.updatedAt || 0);
  });
  pending.sort(function(a, b) {
    return new Date(b.item.createdAt || 0) - new Date(a.item.createdAt || 0);
  });
  var qaCountText = answers.length + ' replies';
  if (pending.length) qaCountText += ' · ' + pending.length + ' in progress';
  document.getElementById('qa-count').textContent = qaCountText;
  if (!answers.length && !pending.length) {
    root.innerHTML = '<div class="empty">No Q&amp;A replies yet.</div>';
    return;
  }
  answers.slice(0, 10).forEach(function(entry) {
    root.appendChild(buildQAReplyCard(entry.session, entry.item));
  });
  pending.slice(0, 10).forEach(function(entry) {
    root.appendChild(buildQAReplyCard(entry.session, entry.item));
  });
}

function renderResearchTab() {
  var root = document.getElementById('research');
  root.innerHTML = '';
  var researchItems = sessions.filter(function(session) {
    if (session.research && session.research.summary) return true;
    if (latestActivityOfType(session, 'extract')) return true;
    return pipelineKind(session) === 'refresh' || pipelineKind(session) === 'generate' || pipelineKind(session) === 'ask' || pipelineKind(session) === 'resume';
  });
  researchItems.sort(function(a, b) {
    var aExtract = latestActivityOfType(a, 'extract');
    var bExtract = latestActivityOfType(b, 'extract');
    return new Date(b.research && b.research.fetchedAt || bExtract && bExtract.createdAt || b.updatedAt || 0) - new Date(a.research && a.research.fetchedAt || aExtract && aExtract.createdAt || a.updatedAt || 0);
  });
  var completedResearch = researchItems.filter(function(session) { return session.research && session.research.summary; }).length;
  var extractionOnly = researchItems.filter(function(session) {
    return !!latestActivityOfType(session, 'extract') && !(session.research && session.research.summary);
  }).length;
  var pendingResearch = researchItems.length - completedResearch - extractionOnly;
  var researchCountText = completedResearch + ' sessions with research';
  if (extractionOnly > 0) researchCountText += ' · ' + extractionOnly + ' extraction only';
  if (pendingResearch > 0) researchCountText += ' · ' + pendingResearch + ' in progress';
  document.getElementById('research-count').textContent = researchCountText;
  if (!researchItems.length) {
    root.innerHTML = '<div class="empty">No extraction or cached research yet.</div>';
    return;
  }
  researchItems.slice(0, 10).forEach(function(session) {
    root.appendChild(buildResearchCard(session));
  });
}

function renderResumeTab() {
  var root = document.getElementById('resume');
  var countNode = document.getElementById('resume-count');
  if (!root || !countNode) return;
  root.innerHTML = '';
  var resumeItems = buildResumeEntries();
  var pending = sessions.filter(function(session) {
    return (!(session.resumes || []).length) && pipelineKind(session) === 'resume';
  });
  countNode.textContent = resumeItems.length + ' resumes' + (pending.length ? ' · ' + pending.length + ' in progress' : '');
  if (!resumeItems.length && !pending.length) {
    root.innerHTML = '<div class="empty">No tailored resumes yet.</div>';
    return;
  }
  resumeItems.slice(0, 10).forEach(function(entry) {
    root.appendChild(buildResumeCard(entry));
  });
  pending.slice(0, 10).forEach(function(session) {
    var pendingCard = mk('article', 'card');
    var header = mk('div', 'card-header');
    var left = mk('div', 'card-left');
    left.appendChild(mk('div', 'session-title', session.job && session.job.companyName ? (session.job.jobTitle || 'Untitled role') + ' at ' + session.job.companyName : (session.title || 'Resume in progress')));
    left.appendChild(mk('div', 'session-sub', pipelineMessage(session, 'Resume generation is in progress.')));
    var meta = mk('div', 'session-meta');
    meta.appendChild(mk('span', 'pill gray', pipelineChipLabel(session) || 'In progress'));
    left.appendChild(meta);
    header.appendChild(left);
    pendingCard.appendChild(header);
    root.appendChild(pendingCard);
  });
}

function renderDashboard() {
  renderDashboardStats();
  renderLettersTab();
  renderQATab();
  renderResumeTab();
  renderResearchTab();
}

function upsertSessionSnapshot(session) {
  if (!session || !session.id) return;
  var found = false;
  sessions = sessions.map(function(existing) {
    if (existing.id !== session.id) return existing;
    found = true;
    return session;
  });
  if (!found) sessions.unshift(session);
  sessions.sort(function(a, b) {
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}

function exportExcel() {
  if (!sessions.length) {
    alert('No sessions to export.');
    return;
  }
  var sheets = [];
  var summaryRows = [['CoverCraft Sessions Export', new Date().toISOString()], [], ['Metric', 'Value']];
  summaryRows.push(['Sessions', sessions.length]);
  summaryRows.push(['Cover Letters', sessions.reduce(function(sum, session) { return sum + ((session.artifacts || []).length); }, 0)]);
  summaryRows.push(['Q&A Replies', sessions.reduce(function(sum, session) { return sum + ((session.chat || []).length); }, 0)]);
  summaryRows.push(['Resume Sessions', buildResumeEntries().length]);
  summaryRows.push(['Research Reuse', sessions.filter(function(session) { return session.research && session.research.reusedFromSessionId; }).length]);
  sheets.push({ name: 'Summary', rows: summaryRows });

  var sessionRows = [['Title', 'Company', 'Job Title', 'Updated At', 'URL', 'Words Scraped', 'Artifacts', 'Chat Replies', 'Resume Name', 'Resume Email']];
  sessions.forEach(function(session) {
    var ownerArtifact = latestArtifactWithOwner(session);
    var owner = ownerArtifact && ownerArtifact.owner || {};
    sessionRows.push([
      session.title || '',
      session.job && session.job.companyName || '',
      session.job && session.job.jobTitle || '',
      fmtDate(session.updatedAt),
      session.page && session.page.url || '',
      session.scrape && session.scrape.wordCount || 0,
      (session.artifacts || []).length,
      (session.chat || []).length,
      owner.name || '',
      owner.email || ''
    ]);
  });
  sheets.push({ name: 'Sessions', rows: sessionRows });

  var letterRows = [['Session', 'Created At', 'Style', 'Model', 'Words', 'Text']];
  sessions.forEach(function(session) {
    (session.artifacts || []).forEach(function(artifact) {
      letterRows.push([session.title || '', fmtDate(artifact.createdAt), artifact.style || '', artifact.model || '', artifact.outputWords || 0, artifact.text || '']);
    });
  });
  sheets.push({ name: 'Cover Letters', rows: letterRows });

  var chatRows = [['Session', 'Created At', 'Question', 'Answer', 'Model']];
  sessions.forEach(function(session) {
    (session.chat || []).forEach(function(item) {
      chatRows.push([session.title || '', fmtDate(item.createdAt), item.question || '', item.answer || '', item.model || '']);
    });
  });
  sheets.push({ name: 'Q&A', rows: chatRows });

  var resumeRows = [['Session', 'Created At', 'Name', 'Email', 'Phone', 'Website', 'Company', 'Job Title', 'Modified Bullets', 'Modified Roles', 'Per-Role Changes', 'Base Skills', 'Skills Included', 'Skills Added']];
  buildResumeEntries().forEach(function(entry) {
    var modifications = entry.artifact.modifications || {};
    resumeRows.push([
      entry.session.title || '',
      fmtDate(entry.artifact.createdAt || entry.session.updatedAt),
      entry.owner.name || '',
      entry.owner.email || '',
      entry.owner.phone || '',
      entry.owner.website || '',
      entry.session.job && entry.session.job.companyName || '',
      entry.session.job && entry.session.job.jobTitle || '',
      modifications.modifiedBulletCount || 0,
      Array.isArray(modifications.modifiedExperienceTitles) ? modifications.modifiedExperienceTitles.join(', ') : '',
      Array.isArray(modifications.experienceChanges) ? modifications.experienceChanges.map(function(item) { return (item.role || item.company || 'Experience') + ': ' + (item.changedBulletCount || 0); }).join(' | ') : '',
      modifications.baseSkillsCount || 0,
      modifications.finalSkillsCount || modifications.skillsCount || 0,
      Array.isArray(modifications.addedSkills) ? modifications.addedSkills.join(', ') : ''
    ]);
  });
  sheets.push({ name: 'Resume', rows: resumeRows });

  var researchRows = [['Session', 'Summary', 'Query 1', 'Query 2', 'Sources', 'Reused']];
  sessions.forEach(function(session) {
    researchRows.push([
      session.title || '',
      session.research && session.research.summary || '',
      session.research && session.research.query1 || '',
      session.research && session.research.query2 || '',
      session.research && session.research.sources ? session.research.sources.map(function(source) { return source.url || ''; }).join(' | ') : '',
      session.research && session.research.reusedFromSessionId ? 'Yes' : 'No'
    ]);
  });
  sheets.push({ name: 'Research', rows: researchRows });

  var bytes = XLSXGen.generate(sheets);
  var anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  anchor.download = 'CoverCraft_Sessions_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(function() { URL.revokeObjectURL(anchor.href); }, 5000);
}

function loadDashboard() {
  if (dashboardRefreshInFlight) return;
  dashboardRefreshInFlight = true;
  var startedAt = Date.now();
  setRefreshLoading(true);
  chrome.runtime.sendMessage({ type: 'GET_DASHBOARD_DATA' }, function(response) {
    var applyRefresh = function() {
      dashboardRefreshInFlight = false;
      setRefreshLoading(false);
      if (chrome.runtime.lastError || !response || response.error || !Array.isArray(response.sessions)) {
        setInlineStatus('session-action-status', 'error', response && response.error || chrome.runtime.lastError && chrome.runtime.lastError.message || 'Could not refresh sessions right now.');
        setTimeout(function() {
          if (document.getElementById('session-action-status')) setInlineStatus('session-action-status', '', '');
        }, 2200);
        return;
      }
      setInlineStatus('session-action-status', '', '');
      sessions = response.sessions;
      if (response.portfolio) {
        lastPortfolioOwner = response.portfolio.owner || lastPortfolioOwner;
        lastPortfolioSource = response.portfolio.source || lastPortfolioSource;
      }
      renderDashboard();
      setActiveSurface(activeSurface, { skipLoad: true });
      setActiveSessionTab(activeSessionTab);
    };
    var delay = Math.max(0, 1200 - (Date.now() - startedAt));
    setTimeout(applyRefresh, delay);
  });
}

function startDashboardAutoRefresh() {
  if (dashboardRefreshTimer) clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = null;
}

function loadSettingsSurface() {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, function(response) {
    var settings = response && response.settings || {};
    document.getElementById('openrouter-key').value = settings.openrouterKey || '';
    document.getElementById('groq-key').value = settings.groqKey || '';
    document.getElementById('tavily-key').value = settings.tavilyKey || '';
    document.getElementById('default-type').value = settings.coverLetterType || 'formal';
    document.getElementById('trigger-mode').value = settings.triggerMode || 'manual';
    document.getElementById('cloud-sync-enabled').checked = !!settings.cloudSyncEnabled;
    var knownModels = ['openrouter/free', 'google/gemma-3-12b-it:free', 'meta-llama/llama-3.3-70b-instruct:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'minimax/minimax-m2.5:free', 'groq/llama-3.1-8b-instant', 'groq/llama-3.3-70b-versatile', 'groq/meta-llama/llama-4-scout-17b-16e-instruct', 'groq/moonshotai/kimi-k2-instruct', 'groq/moonshotai/kimi-k2-instruct-0905', 'groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b', 'groq/qwen/qwen3-32b'];
    if (knownModels.indexOf(settings.model) !== -1) {
      document.getElementById('model-select').value = settings.model;
      document.getElementById('custom-model-input').value = '';
    } else {
      document.getElementById('model-select').value = 'custom';
      document.getElementById('custom-model-input').value = settings.model || '';
    }
    lastPortfolioOwner = response && response.portfolio && response.portfolio.owner ? response.portfolio.owner : lastPortfolioOwner;
    renderCloudStatus(response && response.cloud || null);
  });
  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PORTFOLIO' }, function(response) {
    if (!response) return;
    currentDraftSource = response.source || 'local_file';
    renderCurrentPortfolio(response.portfolio, 'Active source: ' + currentDraftSource, response.validation);
    renderDraftPreview(response.draft || null, response.draft ? 'Imported source: ' + (response.draft.source || 'imported') : '');
    setPortfolioProgress(0);
  });
}

async function testOpenRouter() {
  var key = document.getElementById('openrouter-key').value.trim();
  if (!key) {
    setStatus('openrouter-status', 'error', 'Enter an API key first.');
    return;
  }
  var testedModel = selectedOpenRouterTestModel();
  setStatus('openrouter-status', 'loading', 'Testing OpenRouter…');
  try {
    var response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://covercraft.extension',
        'X-Title': 'CoverCraft Settings Test'
      },
      body: JSON.stringify({
        model: testedModel,
        messages: [{ role: 'user', content: 'Reply with exactly OK' }],
        max_tokens: 10
      })
    });
    var data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) setStatus('openrouter-status', 'ok', 'OpenRouter is working for ' + testedModel + '.');
    else throw new Error((data.error && data.error.message) || 'Unexpected response.');
  } catch (err) {
    setStatus('openrouter-status', 'error', err.message);
  }
}

async function testGroq() {
  var key = document.getElementById('groq-key').value.trim();
  if (!key) {
    setStatus('groq-status', 'error', 'Enter a Groq key first.');
    return;
  }
  var testedModel = selectedGroqTestModel();
  setStatus('groq-status', 'loading', 'Testing Groq…');
  try {
    var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: testedModel,
        messages: [{ role: 'user', content: 'Reply with exactly OK' }],
        max_tokens: 10
      })
    });
    var data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) setStatus('groq-status', 'ok', 'Groq is working for ' + testedModel + '.');
    else throw new Error((data.error && data.error.message) || 'Unexpected response.');
  } catch (err) {
    setStatus('groq-status', 'error', err.message);
  }
}

async function testTavily() {
  var key = document.getElementById('tavily-key').value.trim();
  if (!key) {
    setStatus('tavily-status', 'error', 'Enter a Tavily key first.');
    return;
  }
  setStatus('tavily-status', 'loading', 'Testing Tavily…');
  try {
    var response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ api_key: key, query: 'CoverCraft test', max_results: 1, search_depth: 'basic' })
    });
    if (!response.ok) {
      var err = await response.json().catch(function() { return {}; });
      throw new Error(err.detail || err.message || ('HTTP ' + response.status));
    }
    setStatus('tavily-status', 'ok', 'Tavily is working.');
  } catch (err) {
    setStatus('tavily-status', 'error', err.message);
  }
}

function saveRuntimeSettings() {
  chrome.storage.sync.set({
    openrouterKey: document.getElementById('openrouter-key').value.trim(),
    groqKey: document.getElementById('groq-key').value.trim(),
    tavilyKey: document.getElementById('tavily-key').value.trim(),
    model: document.getElementById('model-select').value === 'custom' ? 'custom' : document.getElementById('model-select').value,
    customModel: document.getElementById('custom-model-input').value.trim(),
    coverLetterType: document.getElementById('default-type').value,
    triggerMode: document.getElementById('trigger-mode').value,
    cloudSyncEnabled: document.getElementById('cloud-sync-enabled').checked
  }, function() {
    chrome.runtime.sendMessage({ type: 'RELOAD_CONFIG' }, function() {
      setStatus('save-status', 'ok', 'Runtime settings saved.');
      if (document.getElementById('cloud-sync-enabled').checked) {
        chrome.runtime.sendMessage({ type: 'SYNC_CLOUD_NOW' }, function() {
          loadCloudStatus();
        });
      } else {
        loadCloudStatus();
      }
      setTimeout(function() { setStatus('save-status', '', ''); }, 2200);
    });
  });
}

function openWebsite() {
  chrome.tabs.create({ url: chrome.runtime.getURL('site/index.html') });
}

function handleImportedDraft(response, successLabel) {
  if (!response || response.error) {
    setStatus('portfolio-status', 'error', response && response.error || 'Import failed.');
    setPortfolioProgress(0);
    return;
  }
  var draft = response.draft;
  if (!draft || !draft.portfolio) {
    setStatus('portfolio-status', 'error', 'Could not build a usable portfolio from that import.');
    setPortfolioProgress(0);
    return;
  }
  renderDraftPreview(draft, successLabel || 'JSON import preview');
  setStatus('portfolio-status', draft.errors && draft.errors.length ? 'error' : 'ok', 'Review the imported JSON, then choose whether to replace the current portfolio.');
  setPortfolioProgress(56);
}

async function handleJsonUpload(event) {
  var input = event && event.target ? event.target : null;
  var file = input && input.files ? input.files[0] : null;
  if (!file) return;
  setStatus('portfolio-status', 'loading', 'Importing portfolio JSON…');
  setPortfolioProgress(20);
  try {
    var text = await readFileAsText(file);
    chrome.runtime.sendMessage({ type: 'IMPORT_PORTFOLIO_JSON', payload: { text: text } }, function(response) {
      handleImportedDraft(response, 'JSON import preview');
    });
  } catch (err) {
    setStatus('portfolio-status', 'error', statusMessage(err, 'Could not import the JSON file.'));
    setPortfolioProgress(0);
  } finally {
    if (input) input.value = '';
  }
}

function initDashboardPage() {
  if (dashboardInitialized) return;
  if (!dashboardDomReady()) {
    window.setTimeout(initDashboardPage, 30);
    return;
  }
  dashboardInitialized = true;
  document.querySelectorAll('.surface-btn').forEach(function(button) {
    button.addEventListener('click', function() { setActiveSurface(button.dataset.surface); });
  });
  document.querySelectorAll('.tab').forEach(function(button) {
    button.addEventListener('click', function() { setActiveSessionTab(button.dataset.tab); });
  });
  bindById('refresh-btn', 'click', loadDashboard);
  bindById('export-btn', 'click', exportExcel);
  bindById('clear-btn', 'click', function() {
    if (!confirm('Clear all CoverCraft sessions and history?')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_ALL_DATA' }, function() {
      sessions = [];
      renderDashboard();
    });
  });
  bindById('test-openrouter-btn', 'click', testOpenRouter);
  bindById('test-groq-btn', 'click', testGroq);
  bindById('test-tavily-btn', 'click', testTavily);
  bindById('save-btn', 'click', saveRuntimeSettings);
  bindById('cloud-sign-in-btn', 'click', signInToCloud);
  bindById('cloud-sync-btn', 'click', syncCloudNow);
  bindById('cloud-sign-out-btn', 'click', signOutOfCloud);
  bindById('topbar-profile-chip', 'click', openProfileSurface);
  bindById('topbar-profile-chip', 'keydown', openProfileSurface);
  bindById('upload-json-btn', 'click', function() {
    var input = document.getElementById('json-input');
    if (input) input.click();
  });
  bindById('open-resume-workspace-btn', 'click', openResumeWorkspace);
  bindById('close-resume-workspace-btn', 'click', closeResumeWorkspace);
  bindById('json-input', 'change', handleJsonUpload);
  bindById('dashboard-website-link', 'click', function(event) {
    event.preventDefault();
    openWebsite();
  });
  bindById('replace-portfolio-btn', 'click', function() {
    if (!pendingPortfolioDraft || !pendingPortfolioDraft.portfolio) {
      setStatus('portfolio-status', 'error', 'There is no imported portfolio preview to apply.');
      return;
    }
    saveCurrentPortfolio(
      pendingPortfolioDraft.portfolio,
      pendingPortfolioDraft.source || 'imported',
      'Current portfolio replaced.'
    );
  });
  bindById('discard-portfolio-btn', 'click', function() {
    clearDraftPreview('Kept the current portfolio.');
  });
  try {
    chrome.runtime.onMessage.addListener(function(message) {
      if (!message || message.type !== 'SESSION_PIPELINE_UPDATE' || !message.session) return;
      upsertSessionSnapshot(message.session);
      renderDashboard();
      setActiveSessionTab(activeSessionTab);
    });
  } catch (_) {}
  window.addEventListener('message', handleWorkspaceMessage);
  bindById('resume-workspace-modal', 'click', function(event) {
    if (event.target && event.target.id === 'resume-workspace-modal') closeResumeWorkspace();
  });

  loadDashboard();
  startDashboardAutoRefresh();
  loadSettingsSurface();
  loadCloudStatus();
  if (window.location.hash === '#settings') setActiveSurface('settings');
  if (window.location.hash === '#profile') setActiveSurface('profile');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDashboardPage);
} else {
  initDashboardPage();
}
