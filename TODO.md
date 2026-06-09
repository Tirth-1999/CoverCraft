# TODO

## Post-Approval Checklist

Complete these steps for the production Chrome Web Store extension ID `apnbkjkgobikeejmfjgnmbflonmbgffg`.

### Extension Identity

- Confirm the published install uses the same permanent ID across machines.
- Confirm unpacked ZIP installs show Local ZIP mode and cannot start production OAuth.
- Keep the release manifest free of a `key`; use a separate development OAuth project if local OAuth is needed later.

### Google OAuth And Firebase

- Add the published redirect URI to Google Cloud OAuth:
  - `https://apnbkjkgobikeejmfjgnmbflonmbgffg.chromiumapp.org/firebase`
- Confirm the production Google OAuth client ID in `src/firebase.defaults.js` owns that redirect URI.
- Recheck Firebase Auth settings and authorized domains.
- Verify Firestore rules are deployed for signed-in user isolation.

### Production Validation

- Install the published extension from the Chrome Web Store.
- Test Google sign-in from the published build.
- Test cloud sync from the published build.
- Test popup, dashboard, settings, and account flows from the published build.
- Verify generation still works with user-supplied OpenRouter, Groq, and Tavily keys.
- Load the ZIP unpacked and verify BYOK generation, profile import, sessions, and exports still work without sign-in.

### Release Follow-Up

- If auth or config changes are needed, bump the extension version.
- Rebuild the Chrome Web Store zip if any production-facing file changes.
- Upload the next package update only after published-auth testing is complete.

### Store And Launch Follow-Up

- Confirm the public Chrome Web Store listing is live and reachable.
- Recheck store screenshots, privacy policy URL, support email, and website links on the live listing.
- Watch for any Chrome Web Store reviewer notes, policy warnings, or follow-up requests after approval.
- Verify install, uninstall, impressions, users, and ratings begin appearing in store analytics.
- Track first-user feedback and note any onboarding confusion around API keys, sign-in, or setup.
- Remove any review-only instructions or temporary operational notes if they are no longer needed.

### Post-Launch Product Checks

- Verify the hosted site still matches the extension messaging after launch.
- Test the privacy page, sitemap, robots file, and security.txt from the production domain.
- Confirm analytics events are arriving in Umami, Clarity, and Google Analytics.
- Check that download/export flows still work on the published build.
- Review whether `<all_urls>` and current permissions remain necessary for the next version, or can be narrowed later.

### Website

- Confirm the public privacy policy is live:
  - `https://cover-craft.app/privacy.html`
- Confirm `robots.txt`, `sitemap.xml`, and `/.well-known/security.txt` resolve correctly on production.
- Verify analytics is receiving traffic after launch.
