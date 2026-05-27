# Firebase Setup

## Firestore Rules

Deploy [firestore.rules](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/firebase/firestore.rules) to protect each user's data by UID.

## Auth Setup

Extension auth now uses `chrome.identity` directly and no longer depends on a hosted helper page.

You still need a Google OAuth client ID for the extension auth flow. Add that client ID to [src/firebase.js](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/src/firebase.js) as `googleClientId`.

Create that OAuth client in Google Cloud as a `Web application` client and add this redirect URI:

- `https://bpeioeajciicdpdpdjfkhfkgockfpfcb.chromiumapp.org/firebase`

The extension ID is pinned by the manifest `key`, so unpacked installs from the zip should keep using `bpeioeajciicdpdpdjfkhfkgockfpfcb` instead of generating a different ID per user. After loading the unpacked extension, confirm the ID in `chrome://extensions`.

Website auth helper pages are not packaged with the extension. Keep extension sign-in on the `chrome.identity` flow so the MV3 package does not include remotely hosted Firebase code.

## Firebase Console Checklist

1. Enable Google Authentication.
2. Create a Google OAuth client for the extension redirect flow, add `https://bpeioeajciicdpdpdjfkhfkgockfpfcb.chromiumapp.org/firebase` as an authorized redirect URI, and paste the client ID into [src/firebase.js](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/src/firebase.js) as `googleClientId`.
3. Add only the domains needed for your active Firebase auth flow.
4. Deploy the Firestore rules from [firestore.rules](/Users/tirthcshah/Desktop/Tirth%20Shah/Projects/CoverCraft/firebase/firestore.rules).
5. Keep API keys local in CoverCraft Settings; sessions, research, cover letters, tailored resumes, the active portfolio, model availability snapshots, and recent model usage logs sync to Firestore.
