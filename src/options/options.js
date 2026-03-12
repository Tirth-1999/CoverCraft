// ─── Default values (baked-in keys as fallback) ───────────────────────────────
var DEFAULT_OR_KEY  = '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';
var DEFAULT_TV_KEY  = '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';
var DEFAULT_MODEL   = 'openrouter/free';

// ─── Load saved settings on open ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {
  chrome.storage.sync.get(['openrouterKey','tavilyKey','model','customModel','coverLetterType'], function(data) {
    var orKey  = data.openrouterKey  || DEFAULT_OR_KEY;
    var tvKey  = data.tavilyKey      || DEFAULT_TV_KEY;
    var model  = data.model          || DEFAULT_MODEL;
    var custom = data.customModel    || '';
    var style  = data.coverLetterType || 'formal';

    document.getElementById('openrouter-key').value = orKey;
    document.getElementById('tavily-key').value     = tvKey;
    document.getElementById('default-type').value   = style;
    document.getElementById('custom-model-input').value = custom;

    // Select the right model card
    selectModel(model);
  });

  // Model card click handlers
  document.querySelectorAll('.model-card').forEach(function(card) {
    card.addEventListener('click', function() {
      var radio = card.querySelector('input[type=radio]');
      if (radio) selectModel(radio.value);
    });
  });

  // Show/hide custom input
  document.getElementById('custom-model-input').addEventListener('input', function() {
    // If user types in custom, auto-select custom card
    selectModel('custom');
  });

  // Test buttons
  document.getElementById('test-openrouter-btn').addEventListener('click', testOpenRouter);
  document.getElementById('test-tavily-btn').addEventListener('click', testTavily);
  document.getElementById('save-btn').addEventListener('click', saveSettings);
});

function selectModel(value) {
  // Unselect all cards
  document.querySelectorAll('.model-card').forEach(function(c) { c.classList.remove('selected'); });

  // Find matching card and select it
  var matched = false;
  document.querySelectorAll('.model-card input[type=radio]').forEach(function(r) {
    if (r.value === value) {
      r.checked = true;
      r.closest('.model-card').classList.add('selected');
      matched = true;
    }
  });

  // If no standard card matched, select custom
  if (!matched) {
    var customRadio = document.querySelector('input[value="custom"]');
    if (customRadio) {
      customRadio.checked = true;
      customRadio.closest('.model-card').classList.add('selected');
    }
    // Put value in custom field if it's a real model string (not "custom")
    if (value !== 'custom') {
      document.getElementById('custom-model-input').value = value;
    }
  }

  // Show/hide custom text field
  var isCustom = !matched || value === 'custom';
  document.getElementById('custom-model-wrap').classList.toggle('visible', isCustom);
}

function getSelectedModel() {
  var checked = document.querySelector('.model-card input[type=radio]:checked');
  if (!checked) return DEFAULT_MODEL;
  if (checked.value === 'custom') {
    var custom = document.getElementById('custom-model-input').value.trim();
    return custom || DEFAULT_MODEL;
  }
  return checked.value;
}

// ─── Test OpenRouter key ──────────────────────────────────────────────────────
async function testOpenRouter() {
  var key = document.getElementById('openrouter-key').value.trim();
  var statusEl = document.getElementById('openrouter-status');
  if (!key) { showStatus(statusEl, 'error', 'Enter an API key first'); return; }

  showStatus(statusEl, 'loading', 'Testing...');
  try {
    var resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://covercraft.extension',
        'X-Title': 'CoverCraft Settings Test'
      },
      body: JSON.stringify({
        model: getSelectedModel(),
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_tokens: 10
      })
    });
    var data = await resp.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      var model = data.model || getSelectedModel();
      showStatus(statusEl, 'ok', 'Connected · Model: ' + model);
    } else if (data.error) {
      showStatus(statusEl, 'error', data.error.message || 'API error');
    } else {
      showStatus(statusEl, 'error', 'Unexpected response');
    }
  } catch(e) {
    showStatus(statusEl, 'error', 'Request failed: ' + e.message);
  }
}

// ─── Test Tavily key ──────────────────────────────────────────────────────────
async function testTavily() {
  var key = document.getElementById('tavily-key').value.trim();
  var statusEl = document.getElementById('tavily-status');
  if (!key) { showStatus(statusEl, 'error', 'Enter a Tavily key first'); return; }

  showStatus(statusEl, 'loading', 'Testing...');
  try {
    var resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ api_key: key, query: 'test', max_results: 1, search_depth: 'basic' })
    });
    if (resp.ok) {
      showStatus(statusEl, 'ok', 'Connected · Tavily search working');
    } else {
      var err = await resp.json().catch(function(){return {};});
      showStatus(statusEl, 'error', (err.detail || err.message || 'HTTP ' + resp.status));
    }
  } catch(e) {
    showStatus(statusEl, 'error', 'Request failed: ' + e.message);
  }
}

// ─── Save all settings ────────────────────────────────────────────────────────
function saveSettings() {
  var orKey  = document.getElementById('openrouter-key').value.trim() || DEFAULT_OR_KEY;
  var tvKey  = document.getElementById('tavily-key').value.trim()     || DEFAULT_TV_KEY;
  var model  = getSelectedModel();
  var custom = document.getElementById('custom-model-input').value.trim();
  var style  = document.getElementById('default-type').value;

  chrome.storage.sync.set({
    openrouterKey:   orKey,
    tavilyKey:       tvKey,
    model:           model,
    customModel:     custom,
    coverLetterType: style
  }, function() {
    // Tell background to reload its config
    chrome.runtime.sendMessage({ type: 'RELOAD_CONFIG' });

    var status = document.getElementById('save-status');
    status.style.opacity = '1';
    setTimeout(function() { status.style.opacity = '0'; }, 2500);
  });
}

// ─── Status display helper ────────────────────────────────────────────────────
function showStatus(el, type, msg) {
  el.innerHTML = '';
  var dot = document.createElement('div');
  dot.className = 'status-dot ' + (type === 'ok' ? 'dot-green' : type === 'error' ? 'dot-red' : 'dot-yellow');
  dot.textContent = (type === 'ok' ? '✓ ' : type === 'error' ? '✗ ' : '⟳ ') + msg;
  el.appendChild(dot);
}
