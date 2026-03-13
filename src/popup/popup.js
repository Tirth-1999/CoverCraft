(function() {
  function showStatus(msg) {
    document.getElementById('status').textContent = msg;
  }

  // Load model name
  chrome.storage.sync.get(['model'], function(d) {
    var m = d.model || 'openrouter/free';
    document.getElementById('model-badge').textContent = '\u2B21 ' + m;
  });

  // Open Panel — dispatch event to content script
  document.getElementById('open-btn').addEventListener('click', function() {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (!tabs || !tabs[0]) { showStatus('No active tab found.'); return; }
      var tabId = tabs[0].id;
      var url   = tabs[0].url || '';

      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) {
        showStatus('Cannot open on this page type.');
        return;
      }

      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function() {
          document.dispatchEvent(new CustomEvent('covercraft:open'));
          return 'dispatched';
        }
      }, function(results) {
        if (chrome.runtime.lastError) {
          showStatus('Could not open: ' + chrome.runtime.lastError.message);
          return;
        }
        window.close();
      });
    });
  });

  // Dashboard — open new tab
  document.getElementById('dash-btn').addEventListener('click', function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') }, function() {
      if (chrome.runtime.lastError) { showStatus('Could not open dashboard.'); return; }
      window.close();
    });
  });

  // Settings — open options page
  document.getElementById('settings-btn').addEventListener('click', function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') }, function() {
      window.close();
    });
  });
})();
