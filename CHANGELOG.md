# Changelog

## 3.0.8 - 2026-06-21

### Providers

- Added the broader OpenAI model list to the normal model selector while keeping lower-cost and advanced models separated.
- Added reasoning-effort handling for OpenAI `o3` and `o3-pro` test and generation calls.

## 3.0.7 - 2026-06-21

### Fixes

- Fixed OpenAI API-key tests by using the Responses API minimum `max_output_tokens` value.
- Added a background safeguard so OpenAI generation requests never send fewer than 16 output tokens.

## 3.0.6 - 2026-06-21

### Resume Automation

- Added role-specific resume formats for Auto, Data / AI / ML, AI Product Manager, Technical Business Analyst, AI Full-Stack, and Balanced resumes.
- Added targeted summary generation, stricter ATS/FAANG bullet instructions, and bullet-level audit comments.
- Normalized problematic resume symbols such as malformed less-than and approximate signs before preview and LaTeX export.

### Providers

- Added OpenAI BYOK support across settings, dashboard, content panel, background generation, and release permissions.
- Added lower-cost OpenAI model options and conservative OpenAI output-token caps.

### Packaging

- Added safe packaged placeholders for optional local override files so Chrome MV3 does not fail with a generic script-fetch error.
- Rebuilt the downloadable extension ZIP with the updated runtime files.

## 3.0.5 - 2026-06-09

### Account Experience

- Added direct Google sign-in to the official extension popup.
- Added account-aware popup actions for signed-in, signed-out, and local ZIP users.
- Rebuilt the website installation comparison as polished Store and local-mode product cards.
- Reworked the account page around the actual extension sign-in flow and removed misleading website-login presentation.

## 3.0.4 - 2026-06-09

### Installation Identity

- Restricted production Google sign-in and Firebase sync to Chrome Web Store ID `apnbkjkgobikeejmfjgnmbflonmbgffg`.
- Kept unpacked ZIP installations fully usable for BYOK generation, local profiles, sessions, and exports.
- Added clear local-install status and Store installation actions to popup, dashboard, and settings.
- Made the Store listing the primary website installation path and labeled the ZIP as local mode.
- Replaced misleading hosted account controls with an installation-mode guide.

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
