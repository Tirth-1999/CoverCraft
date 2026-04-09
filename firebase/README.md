# Firebase Setup

## Firestore Rules

Deploy [firestore.rules](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/firebase/firestore.rules) to protect each user's data by UID.

## Auth Setup

Extension auth now uses `chrome.identity` directly and no longer depends on a hosted helper page.

You still need a Google OAuth client ID for the extension auth flow. Add that client ID to [src/firebase.js](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/src/firebase.js) as `googleClientId`.

Create that OAuth client in Google Cloud as a `Web application` client and add this redirect URI:

- `https://YOUR_EXTENSION_ID.chromiumapp.org/firebase`

You can get the real extension ID from `chrome://extensions` after loading the unpacked extension.

If you also want website auth on the hosted site, deploy [auth-helper.html](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/site/auth-helper.html) and [auth-helper.js](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/site/auth-helper.js) from the `site/` folder to a hosted web origin such as:

- `https://covercraft-951de.web.app/auth-helper.html`
- `https://covercraft-951de.firebaseapp.com/auth-helper.html`

The website auth helper is optional and website-only. Extension auth does not use it anymore.

The website auth helper can also be tested locally from:

- `http://127.0.0.1:5500/site/auth-helper.html`
- `http://localhost:5500/site/auth-helper.html`

## Firebase Console Checklist

1. Enable Google Authentication.
2. Create a Google OAuth client for the extension redirect flow and paste it into [src/firebase.js](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/src/firebase.js) as `googleClientId`.
3. Add your website auth helper origins as authorized domains if you are using hosted website auth:
   `127.0.0.1`
   `localhost`
   `covercraft-951de.web.app`
   `covercraft-951de.firebaseapp.com`
4. Deploy the Firestore rules from [firestore.rules](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/firebase/firestore.rules).
5. If you want website auth, deploy the `site/` folder to Firebase Hosting or another hosted origin so the helper page is reachable.
6. Keep API keys local in CoverCraft Settings; only sessions, research, cover letters, tailored resumes, and the active portfolio sync to Firestore.
