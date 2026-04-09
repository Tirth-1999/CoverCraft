(function() {
  function byId(id) {
    return document.getElementById(id);
  }

  function bind(id, eventName, handler) {
    var el = byId(id);
    if (!el) return null;
    el.addEventListener(eventName, handler);
    return el;
  }

  function showStatus(msg) {
    var status = byId('status');
    if (status) status.textContent = msg;
  }

  function initialsForName(name, fallback) {
    var text = String(name || '').trim();
    if (!text) return fallback || 'G';
    return text.split(/\s+/).filter(Boolean).slice(0, 2).map(function(part) {
      return part.charAt(0).toUpperCase();
    }).join('') || (fallback || 'G');
  }

  function renderAccount(cloud) {
    var avatar = byId('account-avatar');
    var name = byId('account-name');
    var sub = byId('account-sub');
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

  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, function(resp) {
    var settings = resp && resp.settings || {};
    var model = settings.model || 'openrouter/free';
    var badge = byId('model-badge');
    if (badge) badge.textContent = '\u2B21 ' + model;
    renderAccount(resp && resp.cloud || null);
  });

  // Open Panel — dispatch event to content script
  bind('open-btn', 'click', function() {
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
  bind('dash-btn', 'click', function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') }, function() {
      if (chrome.runtime.lastError) { showStatus('Could not open dashboard.'); return; }
      window.close();
    });
  });

  // Settings — open options page
  bind('settings-btn', 'click', function() {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#profile') }, function() {
      window.close();
    });
  });

  bind('website-link', 'click', function(event) {
    event.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('site/index.html') }, function() {
      if (!chrome.runtime.lastError) window.close();
    });
  });
})();
