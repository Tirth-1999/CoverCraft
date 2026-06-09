# Firebase Setup

## Firestore Rules

Deploy [firestore.rules](firestore.rules) to protect each user's data by UID.

## Auth Setup

Extension auth now uses `chrome.identity` directly and no longer depends on a hosted helper page.

The production Google OAuth client ID and Firebase project configuration are in `src/firebase.defaults.js`. Firebase web API keys and OAuth client IDs identify the project; they are not provider secrets.

Create that OAuth client in Google Cloud as a `Web application` client and add this redirect URI:

- `https://apnbkjkgobikeejmfjgnmbflonmbgffg.chromiumapp.org/firebase`

The production Chrome Web Store extension ID is `apnbkjkgobikeejmfjgnmbflonmbgffg`. The release manifest intentionally has no `key`, so an unpacked ZIP receives a different ID.

CoverCraft checks `chrome.runtime.id` at runtime. Production Google sign-in and Firebase sync are available only for the official Store ID. Unpacked ZIP installations remain BYOK/local-only; do not add arbitrary unpacked redirect URIs to the production OAuth client.

If a developer later needs OAuth in a separate development build, use a separate OAuth/Firebase development project and explicit development configuration. Do not weaken the production-ID check.

Website auth helper pages are not packaged with the extension. Keep extension sign-in on the `chrome.identity` flow so the MV3 package does not include remotely hosted Firebase code.

## Firebase Console Checklist

1. In Firebase Authentication, enable the Google provider and select a project support email.
2. In Firebase Authentication > Settings > Authorized domains, add `apnbkjkgobikeejmfjgnmbflonmbgffg.chromiumapp.org`.
3. In Google Cloud Console > Google Auth Platform > Clients, edit the web OAuth client used by `googleClientId` and add `https://apnbkjkgobikeejmfjgnmbflonmbgffg.chromiumapp.org/firebase` as an exact authorized redirect URI.
4. In Google Auth Platform > Audience, use **External** and publish the app to **In production** before launch. Testing mode only permits listed test users.
5. Confirm the consent screen app name, support email, developer contact, homepage, privacy policy, and authorized domains are complete.
6. Deploy the Firestore rules from [firestore.rules](firestore.rules).
7. Keep Firebase on the Spark plan if its only responsibilities are Authentication, Firestore sync, and Hosting.

AI generation does not use Firebase. Users provide their own OpenRouter or Groq key, plus a Tavily key for company research, in CoverCraft Settings.
