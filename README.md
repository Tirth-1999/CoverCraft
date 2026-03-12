# ✦ CoverCraft

**AI-powered cover letter generator for Tirth Shah — Chrome Extension (Manifest V3)**

CoverCraft is a Chrome extension that sits on any job posting page, scrapes the job description, researches the company via Tavily, and generates a tailored, professional cover letter using an LLM via OpenRouter — all in one click.

---

## ✨ Features

- **One-click generation** — open the floating panel on any job posting, click Generate, done.
- **4-step AI pipeline**: Page scrape → Job extraction → Company research (Tavily) → Cover letter generation (OpenRouter LLM)
- **5 writing styles**: Formal & Polished, Story-Driven, Achievement-Led, Concise, Startup Energy
- **Multi-model support**: Free Routing (Gemini Flash / DeepSeek R1), Auto, Gemini 2.0 Flash, DeepSeek R1, Claude 3 Haiku, or any custom OpenRouter model string
- **Full activity dashboard** with per-step logs, prompts, raw responses, and a CSV export
- **PDF download** of the generated cover letter
- **Baked-in portfolio** — Tirth Shah's complete work history, skills, certifications, and achievements are embedded so every letter is deeply personalised without any manual input

---

## 🗂 Project Structure

```
CoverCraft/
├── manifest.json               # Chrome Extension Manifest V3 config
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── src/
    ├── config.example.js       # ← Copy → src/config.js and fill in your keys
    ├── config.js               # API keys (gitignored — never committed)
    ├── background/
    │   └── background.js       # Service worker: pipeline orchestration, AI calls, log storage
    ├── content/
    │   └── content.js          # Injected script: page scraper + floating panel UI
    ├── popup/
    │   └── popup.html          # Extension toolbar popup (Open Panel / Dashboard / Settings)
    ├── options/
    │   ├── options.html        # Settings page UI
    │   └── options.js          # Settings logic: save/load API keys, model, style
    └── dashboard/
        ├── dashboard.html      # Full-page activity dashboard UI
        └── dashboard.js        # Dashboard logic: render logs, stats, tabs, CSV export
```

---

## ⚙️ Setup

### 1. Configure API Keys

```bash
cp src/config.example.js src/config.js
```

Edit `src/config.js` and replace the placeholder values with your real keys:

| Key | Where to get it | Cost |
|-----|----------------|------|
| `openrouterKey` | [openrouter.ai/keys](https://openrouter.ai/keys) | Free tier available |
| `tavilyKey` | [app.tavily.com](https://app.tavily.com) | 1,000 free searches/month |

> **`src/config.js` is in `.gitignore`** — your keys will never be committed to git.

### 2. Load in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `CoverCraft/` folder (the one containing `manifest.json`)

The ✦ CoverCraft icon will appear in your toolbar.

---

## 🚀 Usage

1. Navigate to any job posting (LinkedIn, Greenhouse, Lever, Workday, etc.)
2. Click the **✦ CoverCraft** toolbar icon → **Open Panel on This Page**
3. The floating panel appears. It auto-scrapes the page and detects the job title & company.
4. Choose your **AI model** and **cover letter style**
5. Click **Generate Cover Letter**
6. Copy to clipboard or **Download PDF**

You can also configure your preferred model and default style at **⚙ Settings**, and review every generation in **📊 Dashboard**.

---

## 📁 File Details

### `manifest.json`
Defines the extension: Manifest V3, service worker entry point, popup, options page, content script injected on all URLs, and permissions (`activeTab`, `scripting`, `storage`, `tabs`).

### `src/config.js` *(gitignored)*
Declares the `COVERCRAFT_CONFIG` global with your `openrouterKey` and `tavilyKey`. Loaded by `background.js` (via `importScripts`) and `options.html` (via `<script>` tag) so both always have the same fallback keys.

### `src/config.example.js`
Template for `src/config.js` — committed to git with placeholder values. Copy this to get started.

### `src/background/background.js`
The Manifest V3 service worker. Responsibilities:
- Loads API keys and config from `chrome.storage.sync` (Settings page overrides) falling back to `src/config.js`
- Contains Tirth Shah's complete **PORTFOLIO** object (experiences, skills, certifications, achievements)
- **Message router** handles: `EXTRACT_JOB_INFO`, `RUN_PIPELINE`, `GET_LOGS`, `CLEAR_LOGS`, `RELOAD_CONFIG`, `GET_CONFIG`, `OPEN_DASHBOARD`, `OPEN_SETTINGS`
- **`handleExtract`** — quick job title + company extraction (used for auto-fill)
- **`runPipeline`** — full 4-step pipeline:
  1. Record page scrape metadata
  2. AI extraction of job fields (title, company, keywords, responsibilities, requirements)
  3. Tavily web research (company culture + product/tech — 2 queries)
  4. Cover letter generation with style-specific system prompts
- **`buildSystemPrompt`** / **`buildUserPrompt`** — constructs rich prompts per writing style
- **Log storage** — all activity persisted to `chrome.storage.local` (max 100 entries)

### `src/content/content.js`
Injected into every page. Responsibilities:
- **Simplify detection** — sets the toolbar badge `✦` when the Simplify job-tracker extension is also present
- **`scrapePage()`** — clones the DOM, strips nav/footer/scripts/forms, cuts at application-form starts, strips EEO boilerplate, returns up to 12,000 characters of clean job text
- **Floating panel UI** — a 380 px fixed panel injected into the page with full CSS isolation:
  - Scrape status bar + rescrape button
  - Job title / company auto-fill inputs
  - Model selector (synced with Settings)
  - Style selector (synced with Settings)
  - Generate button → streams status updates
  - Output textarea with Copy and Download PDF buttons
  - Footer links to Dashboard and Settings

### `src/popup/popup.html`
The small (230 px) popup shown when you click the toolbar icon. Shows the active model, and provides three buttons:
- **Open Panel on This Page** — injects the panel into the current tab
- **Dashboard & Logs** — opens `src/dashboard/dashboard.html` in a new tab
- **Settings** — opens `src/options/options.html` in a new tab

### `src/options/options.html` + `src/options/options.js`
Full-page settings UI. Lets the user:
- Enter and **Test** OpenRouter and Tavily API keys
- Select an AI model (card-based UI with Free / Paid / Custom badges)
- Set the default cover letter style
- Save all settings to `chrome.storage.sync` (triggers a `RELOAD_CONFIG` message to the service worker)

### `src/dashboard/dashboard.html` + `src/dashboard/dashboard.js`
Full-page activity log viewer. Features:
- **Stats bar** — total runs, pipelines, extractions, letters generated
- **Tabbed view** — All Activity / Pipelines / Extractions
- **Expandable log cards** — each pipeline card shows all 4 steps with prompts, raw responses, parsed data, Tavily sources, and the final cover letter
- **Export Full Report (CSV)** — downloads a structured CSV of all logs
- **Clear All** — wipes log storage

---

## 🔑 API Keys & Privacy

- Keys are stored in `chrome.storage.sync` (encrypted by Chrome, synced to your Google account if you're signed in).
- The `src/config.js` file holds fallback keys for local development and is excluded from git via `.gitignore`.
- No data is sent anywhere except OpenRouter (for LLM calls) and Tavily (for company research). No analytics, no external tracking.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension platform | Chrome Extension Manifest V3 |
| Background | Service Worker (vanilla JS) |
| UI | Vanilla HTML/CSS/JS (no framework, no bundler) |
| LLM API | [OpenRouter](https://openrouter.ai) (supports Gemini, DeepSeek, Claude, etc.) |
| Web research | [Tavily](https://tavily.com) search API |
| Storage | `chrome.storage.local` (logs) + `chrome.storage.sync` (settings) |
