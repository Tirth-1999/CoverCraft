import { getApp, getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js';
import { getAuth, getRedirectResult, GoogleAuthProvider, signInWithPopup, signInWithRedirect } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js';

let authInFlight = false;
const REDIRECT_SENTINEL = 'covercraft-auth-redirect-started';

function status(message, kind) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = message || '';
  el.dataset.kind = kind || 'info';
}

function queryConfig() {
  const params = new URLSearchParams(window.location.search);
  return {
    apiKey: params.get('apiKey') || '',
    authDomain: params.get('authDomain') || '',
    projectId: params.get('projectId') || '',
    storageBucket: params.get('storageBucket') || '',
    messagingSenderId: params.get('messagingSenderId') || '',
    appId: params.get('appId') || ''
  };
}

function queryReturnUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('cc_return') || '';
}

function isRedirectMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get('cc_mode') === 'redirect' && !!queryReturnUrl();
}

function parentOrigin() {
  if (document.location.ancestorOrigins && document.location.ancestorOrigins.length) {
    return document.location.ancestorOrigins[0];
  }
  if (document.referrer) {
    try { return new URL(document.referrer).origin; } catch (_) {}
  }
  return '*';
}

function send(result) {
  window.parent.postMessage(JSON.stringify(result), parentOrigin());
}

function redirectBack(result) {
  const returnUrl = queryReturnUrl();
  if (!returnUrl) return;
  const payload = encodeURIComponent(JSON.stringify(result));
  try { sessionStorage.removeItem(REDIRECT_SENTINEL); } catch (_) {}
  window.location.replace(returnUrl + '#ccAuthResult=' + payload);
}

function friendlyAuthError(err) {
  var code = err && err.code ? String(err.code) : '';
  if (code === 'auth/unauthorized-domain') {
    return 'Firebase blocked Google sign-in because this auth helper origin is not in Authorized Domains. Add 127.0.0.1, localhost, and your deployed helper domain in Firebase Auth.';
  }
  return err && err.message ? err.message : 'Google sign-in failed.';
}

function authPayloadFromCredential(credential) {
  var user = credential.user;
  return {
    source: 'covercraft-auth-helper',
    ok: true,
    auth: {
      uid: user.uid,
      email: user.email || '',
      displayName: user.displayName || '',
      photoURL: user.photoURL || '',
      idToken: '',
      refreshToken: user.refreshToken || '',
      expiresAt: user.stsTokenManager && user.stsTokenManager.expirationTime ? new Date(user.stsTokenManager.expirationTime).toISOString() : '',
      providerId: credential.providerId || 'google.com'
    }
  };
}

async function enrichAuthPayload(result) {
  var payload = authPayloadFromCredential(result);
  payload.auth.idToken = await result.user.getIdToken();
  return payload;
}

async function bootRedirectFlow() {
  var firebaseConfig = queryConfig();
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !firebaseConfig.authDomain) {
    redirectBack({ source: 'covercraft-auth-helper', ok: false, error: 'Firebase config is incomplete.' });
    return;
  }

  var app = getApps().some(function(entry) { return entry.name === 'covercraft-auth-helper'; })
    ? getApp('covercraft-auth-helper')
    : initializeApp(firebaseConfig, 'covercraft-auth-helper');
  var auth = getAuth(app);
  var provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  status('Checking Google sign-in…');

  try {
    var redirectResult = await getRedirectResult(auth);
    if (redirectResult && redirectResult.user) {
      status('Google sign-in completed. Returning to CoverCraft…', 'ok');
      redirectBack(await enrichAuthPayload(redirectResult));
      return;
    }

    var started = false;
    try { started = sessionStorage.getItem(REDIRECT_SENTINEL) === '1'; } catch (_) {}
    if (started) {
      redirectBack({
        source: 'covercraft-auth-helper',
        ok: false,
        error: 'Google sign-in did not return a usable result. Please try again.'
      });
      return;
    }

    try { sessionStorage.setItem(REDIRECT_SENTINEL, '1'); } catch (_) {}
    status('Opening Google account chooser…');
    await signInWithRedirect(auth, provider);
  } catch (err) {
    redirectBack({
      source: 'covercraft-auth-helper',
      ok: false,
      error: friendlyAuthError(err)
    });
  }
}

window.addEventListener('message', async function(event) {
  if (authInFlight) return;
  if (!event.data || event.data.type !== 'covercraft:init-auth') return;

  var firebaseConfig = event.data.firebaseConfig || {};
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId || !firebaseConfig.authDomain) {
    send({ source: 'covercraft-auth-helper', ok: false, error: 'Firebase config is incomplete.' });
    return;
  }

  authInFlight = true;
  try {
    var app = getApps().some(function(entry) { return entry.name === 'covercraft-auth-helper'; })
      ? getApp('covercraft-auth-helper')
      : initializeApp(firebaseConfig, 'covercraft-auth-helper');
    var auth = getAuth(app);
    var provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    var credential = await signInWithPopup(auth, provider);
    send(await enrichAuthPayload(credential));
  } catch (err) {
    send({
      source: 'covercraft-auth-helper',
      ok: false,
      error: friendlyAuthError(err)
    });
  } finally {
    authInFlight = false;
  }
}, false);

if (isRedirectMode()) {
  bootRedirectFlow();
}
