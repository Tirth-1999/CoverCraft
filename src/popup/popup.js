(function() {
  var currentCloud = null;

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

  function pageAccessError(url) {
    var text = String(url || '');
    if (/^(chrome|edge|brave|vivaldi|opera|about):\/\//i.test(text)) return 'CoverCraft cannot run on browser settings pages.';
    if (/^chrome-extension:\/\//i.test(text)) return 'CoverCraft cannot run inside another extension page.';
    if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//i.test(text)) return 'Chrome blocks extensions from running on the Chrome Web Store.';
    if (/^file:\/\//i.test(text)) return 'Chrome blocks this extension on local files unless file access is enabled for CoverCraft in chrome://extensions.';
    if (/^(devtools|view-source):/i.test(text)) return 'CoverCraft cannot run on this page type.';
    return '';
  }

  function explainInjectionError(message, file) {
    var text = String(message || '').trim();
    var lower = text.toLowerCase();
    if (lower.indexOf('cannot access') !== -1 || lower.indexOf('permissions') !== -1 || lower.indexOf('scheme') !== -1) {
      return text;
    }
    if (lower.indexOf('fetching the script') !== -1 || lower.indexOf('could not load file') !== -1 || lower.indexOf('failed to fetch') !== -1) {
      return 'Chrome could not fetch ' + file + ' from the extension package. Re-download and unzip the latest CoverCraft package, then load the unzipped folder that contains manifest.json.';
    }
    return text || 'Could not inject ' + file + '.';
  }

  function ensurePackagedFile(file) {
    var url = chrome.runtime.getURL(file);
    return fetch(url, { cache: 'no-store' }).then(function(response) {
      if (!response.ok) throw new Error('Missing packaged file: ' + file);
      return true;
    }).catch(function(err) {
      throw new Error(err && err.message || ('Missing packaged file: ' + file));
    });
  }

  function initialsForName(name, fallback) {
    var text = String(name || '').trim();
    if (!text) return fallback || 'G';
    return text.split(/\s+/).filter(Boolean).slice(0, 2).map(function(part) {
      return part.charAt(0).toUpperCase();
    }).join('') || (fallback || 'G');
  }

  function renderAccount(cloud) {
    currentCloud = cloud || null;
    var avatar = byId('account-avatar');
    var name = byId('account-name');
    var sub = byId('account-sub');
    var accountAction = byId('account-action-btn');
    if (!avatar || !name || !sub) return;
    avatar.innerHTML = '';
    var installation = cloud && cloud.installation || null;
    var storeLink = byId('store-link');
    if (storeLink) storeLink.classList.toggle('hidden', !installation || installation.official);
    if (installation && !installation.official) {
      avatar.textContent = 'L';
      name.textContent = 'Local ZIP mode';
      sub.textContent = 'BYOK and local storage only';
      if (accountAction) accountAction.textContent = 'Open Local Profile & Keys';
      return;
    }
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
      if (accountAction) accountAction.textContent = 'Manage Account';
      return;
    }
    avatar.textContent = 'G';
    name.textContent = 'Guest';
    sub.textContent = 'Not signed in';
    if (accountAction) accountAction.textContent = 'Sign In With Google';
  }

  function injectPanelScripts(tabId, callback) {
    var files = ['src/shared/core.js', 'src/shared/pdf.js', 'src/content/content.js'];
    function injectNext(index) {
      if (index >= files.length) {
        callback(null);
        return;
      }
      var file = files[index];
      ensurePackagedFile(file).then(function() {
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: [file]
        }, function() {
          if (chrome.runtime.lastError) {
            callback(explainInjectionError(chrome.runtime.lastError.message, file));
            return;
          }
          injectNext(index + 1);
        });
      }).catch(function(err) {
        callback(err && err.message || ('Missing packaged file: ' + file));
      });
    }
    injectNext(0);
  }

  function dispatchOpen(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function() {
        document.dispatchEvent(new CustomEvent('covercraft:open'));
        return 'dispatched';
      }
    }, function() {
      if (chrome.runtime.lastError) {
        showStatus('Could not open: ' + chrome.runtime.lastError.message);
        return;
      }
      window.close();
    });
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
      var blocked = pageAccessError(url);

      if (blocked) {
        showStatus(blocked);
        return;
      }

      injectPanelScripts(tabId, function(error) {
        if (error) {
          showStatus('Could not load CoverCraft: ' + error);
          return;
        }
        dispatchOpen(tabId);
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

  bind('account-action-btn', 'click', function() {
    var button = byId('account-action-btn');
    var installation = currentCloud && currentCloud.installation;
    if (!installation || !installation.official || currentCloud.signedIn) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html#profile') }, function() {
        window.close();
      });
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Opening Google Sign-In...';
    }
    showStatus('');
    chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN' }, function(response) {
      if (!response || response.error) {
        if (button) {
          button.disabled = false;
          button.textContent = 'Sign In With Google';
        }
        showStatus(response && response.error || 'Google sign-in failed.');
        return;
      }
      renderAccount(response.cloud || null);
      if (button) button.disabled = false;
      showStatus(response.syncPending ? 'Signed in. Cloud sync is finishing in the background.' : 'Signed in.');
    });
  });

  bind('website-link', 'click', function(event) {
    event.preventDefault();
    chrome.tabs.create({ url: 'https://cover-craft.app/' }, function() {
      if (!chrome.runtime.lastError) window.close();
    });
  });

  bind('store-link', 'click', function(event) {
    event.preventDefault();
    chrome.runtime.sendMessage({ type: 'OPEN_STORE' }, function() {
      window.close();
    });
  });
})();
