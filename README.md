# ✦ CoverCraft

[![Visitors](https://visitor-badge.laobi.icu/badge?page_id=Tirth-1999.CoverCraft)](https://github.com/Tirth-1999/CoverCraft)

**AI-powered cover letter generator — Chrome Extension (Manifest V3)**

CoverCraft is a Chrome extension that sits on any job posting page, scrapes the job description, researches the company via Tavily, and generates a tailored, professional cover letter using an LLM — all in one click. It is fully **white-label**: swap in your own portfolio file and API keys, reload the extension, and every generated letter is deeply personalized to *you*.

---

## ✨ Features

- **One-click generation** — open the floating panel on any job posting, click Generate, done.
- **4-step AI pipeline**: Page scrape → Job extraction → Company research (Tavily) → Cover letter generation (OpenRouter LLM)
- **5 writing styles**: Formal & Polished, Story-Driven, Achievement-Led, Concise, Startup Energy
- **Multi-model support**: Arcee Trinity (default, free), Free Routing (Gemini Flash / DeepSeek R1), Auto, Gemini 2.0 Flash, DeepSeek R1, Claude 3 Haiku, or any custom OpenRouter model string
- **Full activity dashboard** with per-step logs, prompts, raw responses, and an Excel export
- **PDF download** of the generated cover letter — fully formatted with your name and contact details from your portfolio
- **Human-voice prompts** — bans AI buzzwords (orchestrated, leveraged, synergy, etc.) and em-dashes; enforces first-person, natural prose
- **Experience integrity** — each paragraph is pinned to a single portfolio entry; no cross-experience blending
- **Auto-retry** on empty model responses (common with free-tier models)
- **White-label portfolio** — your work history, skills, certifications, and achievements live in `src/portfolio.js` (gitignored); copy from the example template and fill in your details

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
    ├── config.example.js       # ← Copy → src/config.js and fill in your API keys
    ├── config.js               # Your API keys (gitignored — never committed)
    ├── portfolio.example.js    # ← Copy → src/portfolio.js and fill in YOUR details
    ├── portfolio.js            # Your personal portfolio data (gitignored — never committed)
    ├── background/
    │   └── background.js       # Service worker: pipeline orchestration, AI calls, log storage
    ├── content/
    │   └── content.js          # Injected script: page scraper + floating panel UI + PDF generator
    ├── popup/
    │   ├── popup.html          # Extension toolbar popup (Open Panel / Dashboard / Settings)
    │   └── popup.js            # Popup logic: active model badge, button actions
    ├── options/
    │   ├── options.html        # Settings page UI
    │   └── options.js          # Settings logic: save/load API keys, model, style
    └── dashboard/
        ├── dashboard.html      # Full-page activity dashboard UI
        ├── dashboard.js        # Dashboard logic: render logs, stats, tabs, Excel export
        └── xlsxgen.js          # In-browser XLSX generator (no server needed)
```

---

## ⚙️ Setup

### Prerequisites

- Google Chrome (or any Chromium-based browser)
- An [OpenRouter](https://openrouter.ai/keys) API key — free tier is available and sufficient for most models
- A [Tavily](https://app.tavily.com) API key — 1,000 free searches/month

### Step 1 — Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/CoverCraft.git
cd CoverCraft
```

### Step 2 — Configure API Keys

```bash
cp src/config.example.js src/config.js
```

Open `src/config.js` and replace the placeholder strings with your real keys:

```js
const COVERCRAFT_CONFIG = {
  openrouterKey: 'sk-or-YOUR_KEY_HERE',
  tavilyKey:     'tvly-YOUR_KEY_HERE',
};
```

> **`src/config.js` is in `.gitignore`** — your keys will never be committed to git.  
> You can also enter keys directly in the extension's **Settings** page after loading it — they are stored in `chrome.storage.sync`.

### Step 3 — Add Your Portfolio

```bash
cp src/portfolio.example.js src/portfolio.js
```

Open `src/portfolio.js` and fill in your details:

| Field | Description |
|-------|-------------|
| `name` | Your full name (used in PDF header and sign-off) |
| `phone` | Your phone number (PDF header) |
| `email` | Your email address (PDF header) |
| `website` | Your portfolio/LinkedIn URL (PDF header — shown as a clickable hyperlink) |
| `education` | Degree, institution, graduation year |
| `experiences` | Array of work experience entries — see template for structure |
| `skills` | Technical and soft skills |
| `certifications` | Certifications and credentials |
| `awards` | Awards and recognition |

**The more specific your highlights and metrics, the better the cover letters.** Numbers beat adjectives — e.g. "reduced latency by 40%" is far more useful than "improved performance".

> **`src/portfolio.js` is in `.gitignore`** — your personal data will never be committed to git.

### Step 4 — Load the Extension in Chrome

1. Open Chrome → navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `CoverCraft/` folder (the root folder containing `manifest.json`)

The **✦ CoverCraft** icon will appear in your Chrome toolbar. If you see a service worker error, double-check that `src/config.js` and `src/portfolio.js` both exist — the service worker will fail to start if either file is missing.

---

## 🚀 Usage

1. Navigate to any job posting (LinkedIn, Greenhouse, Lever, Workday, Indeed, etc.)
2. Click the **✦ CoverCraft** toolbar icon → **Open Panel on This Page**
3. The floating panel appears — it auto-scrapes the page and fills in the job title and company name
4. Choose your **AI model** and **cover letter style** (or keep the defaults)
5. Click **Generate Cover Letter**
6. Watch the 4-step pipeline run in real time; the letter appears when complete
7. **Copy** to clipboard or **Download PDF**

To redo a generation (try a different model or style), just change the selections and click Generate again — the model and style selectors stay visible at all times.

---

## 🤖 AI Models

| Model | Provider | Cost | Notes |
|-------|----------|------|-------|
| `arcee-ai/trinity-large-preview:free` | Arcee AI via OpenRouter | **Free** | Default — fast, high-quality, great for cover letters |
| `google/gemini-flash-1.5` | Google via OpenRouter | **Free** | Good fallback |
| `deepseek/deepseek-r1:free` | DeepSeek via OpenRouter | **Free** | Strong reasoning |
| `anthropic/claude-3-haiku` | Anthropic via OpenRouter | Paid | Faster Claude option |
| `google/gemini-2.0-flash-001` | Google via OpenRouter | Paid | Latest Gemini |
| Custom | Any OpenRouter model | Varies | Enter any model string from [openrouter.ai/models](https://openrouter.ai/models) |

> Free models occasionally return empty responses. CoverCraft automatically retries Step 4 up to 3 times when this happens.

---

## 📄 Cover Letter Styles

| Style | Description |
|-------|-------------|
| **Formal & Polished** | Structured, professional, paragraph-by-paragraph evidence |
| **Story-Driven** | Narrative arc — opens with a real moment, builds to the close |
| **Achievement-Led** | Every paragraph anchored with hard metrics and outcomes |
| **Concise & Punchy** | 5 tight paragraphs, nothing wasted |
| **Startup Energy** | Direct, builder-first language — leads with your most impressive independent work |

---

## 📊 Dashboard

Click **Dashboard & Logs** in the popup to open the full activity log. Each pipeline run is stored with:
- All 4 step results (scrape → extract → research → generate)
- The exact prompts sent and raw model responses
- Tavily search results and sources
- The final cover letter text

Use **Export Full Report (Excel)** to download everything as a `.xlsx` file.

---

## 🔑 API Keys & Privacy

- Keys entered in Settings are stored in `chrome.storage.sync` (encrypted by Chrome, synced to your Google account if signed in).
- `src/config.js` holds fallback keys for local development only — it is gitignored.
- No data is sent anywhere except OpenRouter (LLM calls) and Tavily (company research). No analytics, no external tracking, no data stored server-side.

---

## 🛠 Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension platform | Chrome Extension Manifest V3 |
| Background | Service Worker (vanilla JS) |
| UI | Vanilla HTML/CSS/JS — no framework, no bundler, no build step |
| LLM API | [OpenRouter](https://openrouter.ai) (routes to Gemini, DeepSeek, Claude, Arcee, etc.) |
| Web research | [Tavily](https://tavily.com) search API |
| PDF generation | Hand-rolled PDF/1.4 — no libraries, full justification, AFM-accurate line wrapping |
| XLSX generation | In-browser XLSX builder — no server, no libraries |
| Storage | `chrome.storage.local` (logs) + `chrome.storage.sync` (settings) |

---

## 🪄 White-Labeling

CoverCraft is designed to be forked and personalized:

1. Fork the repository
2. Fill in `src/portfolio.js` with your own details (copy from `portfolio.example.js`)
3. Add your API keys to `src/config.js` (copy from `config.example.js`)
4. Load unpacked in Chrome
5. Done — every cover letter will be tailored to *your* portfolio

The two gitignored files (`portfolio.js` and `config.js`) are the only files you need to change for a fully personalized setup. All other files are generic and can be committed publicly.

---

## 🤝 Contributing

Pull requests welcome. For major changes, open an issue first.

---

## 📜 License

MIT

