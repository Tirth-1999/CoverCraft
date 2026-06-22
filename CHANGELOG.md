# Changelog

## 3.0.24 - 2026-06-21

### Resume Automation

- Added focused job-description scraping for LinkedIn and common ATS pages so resume generation uses the actual JD body instead of page chrome or a short preview.
- Expanded stored resume job context from a 500-character preview to a larger cleaned JD snapshot for keyword ranking, prompt input, and session audit review.
- Tightened the resume prompt with the attached FAANG/ATS rules: keyword mapping first, truthful JD keyword use, stronger X-Y-Z bullet structures, shorter summaries, and explicit rejection of dash clauses.
- Updated the resume session information to show the fuller job description used, making scraper failures visible before regenerating a resume.
- Rendered project links as compact bracketed labels such as `[GitHub]` and `[Demo]` for cleaner resume output.

## 3.0.23 - 2026-06-21

### Resume Automation

- Reworked resume layout policy to require exactly 3 bullets per selected experience and exactly 4 projects when source inventory allows it.
- Replaced prefix-clipping for project descriptions with complete two-line project summaries and project-specific fallbacks for known portfolio projects.
- Raised project and bullet budgets to match the reference DS resume instead of forcing one-line fragments.
- Strengthened education cleanup at structured and final output layers so `in,` degree commas cannot survive.
- Prioritized DS-relevant certifications, including Azure Data Engineer Associate, Azure Administrator Associate, Professional Scrum Master I (PSM), AWS Cloud Practitioner, and Azure fundamentals.
- Preserved model-provided JD-relevant skill categories when valid, while filtering certification names out of technical skills.
- Rebuilt the unpacked `build/extension` output and release ZIP so local extension testing uses the current runtime code.

## 3.0.22 - 2026-06-21

### Resume Automation

- Added exact final guards for repeated clipped endings: trailing ampersands, `to expose`, `and product`, `generating`, `tripling`, and `Predictive`.
- Expanded education cleanup so `Master of Science in, Management Information Systems` and `Bachelor of Engineering in, Computer Engineering` render without the comma.
- Added a hard certification-name filter to technical skill category output so Azure and Scrum credentials cannot leak into skills.

## 3.0.21 - 2026-06-21

### Resume Automation

- Added final fragment cleanup for resume summaries, experience bullets, and project descriptions so shortened text cannot end on dangling words such as "generating", "Predictive", "product", or "to expose".
- Tightened resume prompt rules to require complete clauses when fitting one-page word budgets instead of truncating sentences.
- Kept certification names out of technical skill category lines so credentials render only in the Certifications line.
- Added incomplete clipped endings to resume bullet quality flags for easier review in session audit details.

## 3.0.20 - 2026-06-21

### Job Extraction

- Added structured LinkedIn job top-card selectors for title and company extraction before AI parsing runs.
- Passed inferred page title/company hints into scrape, generate, and resume requests when manual fields are blank.
- Prepended detected title and company to scraped text so the background parser can recover employer names even when LinkedIn separates them from the job description body.

## 3.0.19 - 2026-06-21

### Resume Automation

- Expanded resume keyword matching to use the full structured portfolio skill corpus, including nested skill categories, project technologies, experience technologies, current focus items, and certifications.
- Added the job-description context used for each tailored resume to the resume review panel and spreadsheet export.
- Enforced 3-4 selected projects when source projects are available, tightened final bullet/project word caps, and hardened dash-clause cleanup so em dash style phrasing is converted before preview and LaTeX export.
- Cleaned education degree comma formatting, added location to the resume header, and rendered certifications as plain comma-separated linked credentials without bold Azure grouping or PSM abbreviation.

## 3.0.18 - 2026-06-21

### Resume Automation

- Added before/after job-keyword coverage scoring for tailored resumes.
- Added selected and omitted experience/project rationale to resume session details.
- Updated resume exports to include keyword match lift, matched/missing keywords, and evidence-selection decisions.

## 3.0.17 - 2026-06-21

### Resume Automation

- Tightened resume output budgets so experience bullets and project descriptions fit the one-page layout more reliably.
- Removed terminal periods from generated resume content and added stronger final caps for bullets and projects.
- Added GitHub to the resume header, recovered known project links by title, and rendered compact linked certifications with grouped Azure credentials.

## 3.0.16 - 2026-06-21

### Resume Automation

- Added a final visible-text sanitizer before resume preview and LaTeX export.
- Strips Unicode dashes, corrupted metric symbols, zero-width characters, replacement characters, and other non-ASCII visible artifacts from generated resume fields.
- Records residual visible-text issues on the resume artifact data for stricter debugging.

## 3.0.15 - 2026-06-21

### Resume Automation

- Added justified resume body text for summary, bullets, and project descriptions.
- Reworked experience selection so ranked full-time/external roles are favored over internships when relevance is similar, then selected roles render in reverse chronology.
- Tightened source matching and final text cleanup so raw fallback bullets cannot reintroduce dash-heavy clauses.

## 3.0.14 - 2026-06-21

### Resume Automation

- Tightened the resume prompt and final guardrails after reviewing the regenerated PDF output.
- Improved summary fallback quality, education institution/location/date cleanup, project link extraction, project description limits, and certification name cleanup.
- Added stricter final text normalization to avoid dash-style clauses and fragile metric formatting in rendered resumes.

## 3.0.13 - 2026-06-21

### Resume Automation

- Aligned generated resume layout with the uploaded one-page resume family: Summary, Work Experience, Projects, Education, then Technical Skills & Certifications.
- Switched generated LaTeX resume styling toward the compact sans-serif reference format with role/date work headers and education dates/locations right-aligned.
- Added role-aware project limits, categorized skills output, stricter bullet word budgets, and safer metric wording such as "under 15%" instead of fragile LaTeX comparison symbols.

## 3.0.12 - 2026-06-21

### Resume Automation

- Reworked resume generation into a section-aware ATS planner that analyzes the job, selects ranked experience/project evidence, and writes dense XYZ bullets.
- Resume output now selects up to 4 strongest experiences and 2-3 strongest projects instead of preserving the full original order.
- Removed Leadership & Achievements from generated one-page resume output and tightened LaTeX formatting around the cleaner template.

## 3.0.11 - 2026-06-21

### Fixes

- Increased OpenAI output budgets for extraction, cover-letter, Q&A, and resume workflows so reasoning models have room to finish.
- Kept model-tier caps in place while raising them enough to avoid premature `max_output_tokens` failures.

## 3.0.10 - 2026-06-21

### Fixes

- Fixed OpenAI generation by returning Responses API `output_text` instead of reading chat-completion `choices`.
- Treat OpenAI Responses API incomplete outputs as provider failures with a clearer error message.

## 3.0.9 - 2026-06-21

### Settings

- Added a dedicated API-key save action so local ZIP users can persist provider keys without scrolling to runtime defaults.
- Successful provider tests now save the tested keys into extension-local storage.
- Limited the model availability panel to a compact five-row snapshot.

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
