# Security Policy

## Reporting a Vulnerability

If you discover a security issue in CoverCraft, please report it privately by emailing:

- <tirth.shah@tamu.edu>

Please do not open a public GitHub issue for suspected security vulnerabilities.

When possible, include:

- a clear description of the issue
- steps to reproduce it
- the affected surface or file
- any proof-of-concept or screenshots
- the potential impact

## Response Expectations

CoverCraft aims to review security reports as quickly as possible and follow up with next steps, remediation status, or clarifying questions.

## Scope

This policy covers:

- the Chrome extension
- the hosted website under `site/`
- account, sync, and related application surfaces

## Sensitive Areas

Please take extra care when reporting issues related to:

- authentication and session handling
- cloud sync and stored user data
- provider API key handling
- generated file exports
- page-content extraction and prompt routing

## Secret Handling

Never put developer-owned OpenRouter, Groq, Tavily, or other privileged provider keys in extension source or a downloadable ZIP. Browser extension code is controlled by the user and cannot protect shared secrets.

CoverCraft uses a bring-your-own-key model. Each user may save their own provider keys in extension-local storage restricted to trusted extension pages, and requests go directly to the selected provider. Provider keys are not placed in Chrome Sync or Firebase. Firebase is used only for optional Google sign-in and data sync.

If a provider key was ever included in a distributed build, revoke and rotate it immediately. Removing it from a later ZIP does not invalidate copies users already downloaded.

Build the release archive with:

```bash
./scripts/build-extension.sh
```

The builder uses an allowlist and fails when it finds local configuration files, personal portfolio data, environment files, or provider-key patterns.
