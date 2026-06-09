# Firebase Setup

## Firestore Rules

Deploy [firestore.rules](firestore.rules) to protect each user's data by UID.

## Auth Setup

Extension auth now uses `chrome.identity` directly and no longer depends on a hosted helper page.

The production Google OAuth client ID and Firebase project configuration are in `src/firebase.defaults.js`. Firebase web API keys and OAuth client IDs identify the project; they are not provider secrets.

Create that OAuth client in Google Cloud as a `Web application` client and add this redirect URI:

- `https://apnbkjkgobikeejmfjgnmbflonmbgffg.chromiumapp.org/firebase`

The production Chrome Web Store extension ID is `apnbkjkgobikeejmfjgnmbflonmbgffg`. The release manifest intentionally does not contain the previous development public key because it generated a different extension ID.

To make unpacked development builds use the production ID, open the Chrome Web Store Developer Dashboard, go to **Package**, choose **View public key**, remove the PEM header/footer and line breaks, and use that value as the manifest `key`. The extension ID alone cannot be converted back into the public key.

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
