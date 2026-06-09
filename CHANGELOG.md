# Changelog

## 3.0.3 - 2026-06-09

### Security

- Removed developer-owned provider credentials and personal profile data from the production package.
- Moved user-supplied OpenRouter, Groq, and Tavily keys from Chrome Sync to trusted extension-local storage.
- Redacted provider-key values from content-script settings responses.
- Added OAuth state, nonce, audience, issuer, and expiration validation before Firebase exchange.
- Removed unnecessary `tabs` and Tavily website permissions.

### Product

- Made tailored resume prompts, previews, and LaTeX exports use the active user profile.
- Added a neutral first-install profile so users must import or create their own identity.
- Kept Google sign-in and Firestore sync on Firebase Spark-compatible client APIs.
- Centralized shared model metadata used by the service worker, page panel, dashboard, and settings.

### Packaging

- Replaced the release archive with a 744 KB allowlisted runtime package.
- Excluded the hosted marketing site, branding media, local configuration, and development artifacts.
- Added repeatable ZIP integrity, required-file, and provider-secret checks.
- Added Remotion demo-video source while excluding dependencies, copied assets, and rendered output.

### Documentation

- Documented the production Chrome Web Store ID and exact OAuth redirect URI.
- Clarified BYOK storage, first-run profile setup, Firebase console prerequisites, and release verification.
