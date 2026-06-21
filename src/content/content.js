(function() {
  'use strict';

  if (window.__covercraftContentLoaded) return;
  window.__covercraftContentLoaded = true;

  var Core = window.CoverCraftCore;
  var injected = false;
  var shadow = null;
  var host = null;
  var currentSession = null;
  var currentOwner = null;
  var currentCloud = null;
  var currentSettings = null;
  var currentModelHealth = {};
  var GROQ_BASE_LIMITS = Core.GROQ_BASE_LIMITS;
  var currentPortfolio = null;
  var currentPortfolioSource = '';
  var triggerObserver = null;
  var sessionProgressPollTimer = null;
  var modelHealthTickTimer = null;
  var titleHintDirty = false;
  var companyHintDirty = false;
  var lastAiView = 'generate';
  var generateViewState = {
    kind: '',
    message: ''
  };
  var manualViewState = {
    kind: '',
    message: ''
  };
  var askViewState = {
    kind: '',
    message: ''
  };
  var resumeViewState = {
    kind: '',
    message: '',
    text: ''
  };

  function ctxOk() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
    catch (_) { return false; }
  }

  function safeMsg(message, callback) {
    if (!ctxOk()) return;
    try {
      chrome.runtime.sendMessage(message, callback || function() { void chrome.runtime.lastError; });
    } catch (_) {}
  }

  function syncGet(keys, callback) {
    if (!ctxOk()) return;
    try { chrome.storage.sync.get(keys, callback); }
    catch (_) {}
  }

  function syncSet(obj, callback) {
    if (!ctxOk()) return;
    try { chrome.storage.sync.set(obj, callback || function() {}); }
    catch (_) {}
  }

  function $id(id) {
    return shadow ? shadow.getElementById(id) : document.getElementById(id);
  }

  function bindShadow(id, eventName, handler) {
    var el = $id(id);
    if (!el) return null;
    el.addEventListener(eventName, handler);
    return el;
  }

  function resetHintDirtyState() {
    titleHintDirty = false;
    companyHintDirty = false;
  }

  function currentManualHints() {
    return {
      titleHint: titleHintDirty ? (($id('cc-title-hint').value || '').trim()) : '',
      companyHint: companyHintDirty ? (($id('cc-company-hint').value || '').trim()) : ''
    };
  }

  function detectSimplify() {
    var selectors = [
      '#simplify-app', '.simplify-app', '[data-simplify]', 'simplify-app',
      '#simplify-extension-root', '.simplify-sidebar', '[class*="simplify-"]',
      'iframe[src*="simplify"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      if (document.querySelector(selectors[i])) return true;
    }
    return false;
  }

  function detectNorthstarDemoPage() {
    var title = String(document.title || '').toLowerCase();
    var pathname = String(window.location.pathname || '').toLowerCase();
    var bodyText = document.body ? String(document.body.innerText || document.body.textContent || '').toLowerCase() : '';
    if (pathname.indexOf('demo-job') !== -1) return true;
    if (title.indexOf('northstar signal') !== -1) return true;
    if (bodyText.indexOf('fictional demo company') !== -1 && bodyText.indexOf('northstar signal') !== -1) return true;
    return false;
  }

  function scrapePage() {
    var body = document.body;
    if (!body) return '';
    var clone = body.cloneNode(true);
    ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside', 'iframe', 'form'].forEach(function(tag) {
      clone.querySelectorAll(tag).forEach(function(el) { el.remove(); });
    });
    clone.querySelectorAll('[aria-hidden="true"],[hidden]').forEach(function(el) { el.remove(); });

    var text = (clone.innerText || clone.textContent || '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();

    var lead = [];
    var title = String(document.title || '').trim();
    if (title) lead.push(title);
    var h1 = document.querySelector('h1');
    var h1Text = h1 ? String(h1.textContent || '').trim() : '';
    if (h1Text && lead.indexOf(h1Text) === -1) lead.push(h1Text);
    var leadText = lead.filter(Boolean).join('\n');
    if (leadText) text = leadText + '\n\n' + text;

    var cutPatterns = [
      /\n(first name|last name|full name|legal name)\s*[\n*:]/i,
      /\n(email address|phone number|upload resume|attach resume|upload cv)\s*[\n*:]/i,
      /\n(linkedin url|portfolio url)\s*[\n*:]/i,
      /\n(submit application|submit your application)\s*\n/i,
      /\napplication form\s*\n/i
    ];
    var cut = text.length;
    cutPatterns.forEach(function(pattern) {
      var match = text.search(pattern);
      if (match !== -1 && match < cut) cut = match;
    });

    return text.slice(0, cut).trim().slice(0, 14000);
  }

  function inferIdentityHints() {
    var titleText = String(document.title || '').replace(/\s+/g, ' ').trim();
    var h1 = document.querySelector('h1');
    var headingText = h1 ? String(h1.textContent || '').replace(/\s+/g, ' ').trim() : '';
    var source = headingText || titleText;
    var titleHint = '';
    var companyHint = '';
    var rolePattern = /(analyst|engineer|scientist|manager|developer|intern|specialist|associate|consultant|coordinator|architect|administrator|strategist|researcher|lead|director|officer|writer|designer)/i;
    var platformPattern = /\b(jobright(?:\.ai)?|linkedin|indeed|glassdoor|greenhouse|lever|workday|ashby|simplify|ziprecruiter|monster|wellfound|dice)\b/i;

    function cleanEntity(text) {
      return String(text || '').replace(/\s+/g, ' ').replace(/^[\s:|@-]+/, '').replace(/[\s|·•]+$/, '').trim();
    }

    function looksLikePlatform(text) {
      return platformPattern.test(cleanEntity(text));
    }

    if (source) {
      var direct = source.match(/^(.*?)\s+(?:at|@)\s+(.+?)(?:\s*[|–—-].*)?$/i);
      if (direct) {
        titleHint = cleanEntity(direct[1]);
        companyHint = cleanEntity(direct[2]);
        if (looksLikePlatform(companyHint)) companyHint = '';
      } else {
        var segments = source.split(/\s*[|–—-]\s*/).map(function(segment) {
          return cleanEntity(segment);
        }).filter(Boolean).filter(function(segment) {
          return !looksLikePlatform(segment);
        });
        for (var i = 0; i < segments.length; i++) {
          if (!rolePattern.test(segments[i])) continue;
          titleHint = segments[i];
          companyHint = cleanEntity(segments[i + 1] || segments[i - 1] || '');
          if (looksLikePlatform(companyHint)) companyHint = '';
          break;
        }
      }
    }

    return {
      pageTitle: titleText,
      titleHint: titleHint,
      companyHint: companyHint
    };
  }

  function getPanelHTML() {
    return [
      '<div id="cc-panel">',
        '<div id="cc-header">',
          '<div class="cc-brand">',
            '<span class="cc-star">✦</span>',
            '<div class="cc-title">CoverCraft</div>',
          '</div>',
          '<div id="cc-header-actions">',
            '<button id="cc-scrape-btn" class="cc-sm-btn" title="Scrape page and refresh context">Scrape</button>',
            '<button id="cc-settings-btn" class="cc-sm-btn cc-icon-btn" title="Open settings" aria-label="Open settings">⚙</button>',
            '<button id="cc-model-health-refresh-btn" class="cc-sm-btn cc-icon-btn" title="Refresh model availability" aria-label="Refresh model availability">↻</button>',
            '<button id="cc-min-btn" title="Minimize">−</button>',
            '<button id="cc-close-btn" title="Close">✕</button>',
          '</div>',
        '</div>',

        '<div id="cc-body">',
          '<textarea id="cc-raw-text" style="display:none"></textarea>',

          '<div class="cc-mode-bar cc-ai-tabs" role="tablist" aria-label="AI tools">',
            '<button class="cc-mode active" data-view="generate" type="button">Cover Letter</button>',
            '<button class="cc-mode" data-view="ask" type="button">Question</button>',
            '<button class="cc-mode" data-view="resume" type="button">Resume</button>',
          '</div>',

          '<div class="cc-row2">',
            '<div class="cc-field">',
              '<label class="cc-lbl">Job Title</label>',
              '<input type="text" id="cc-title-hint" class="cc-input" placeholder="Optional hint or correction" />',
            '</div>',
            '<div class="cc-field">',
              '<label class="cc-lbl">Company</label>',
              '<input type="text" id="cc-company-hint" class="cc-input" placeholder="Optional hint or correction" />',
            '</div>',
          '</div>',

          '<section class="cc-view active" id="cc-view-generate">',
            '<div class="cc-field">',
              '<label class="cc-lbl">AI Model</label>',
              '<select id="cc-model-select" class="cc-select">',
                '<optgroup label="OpenRouter">',
                '<option value="openrouter/free">Free Routing</option>',
                '<option value="google/gemma-3-12b-it:free">Google Gemma 3 12B</option>',
                '<option value="meta-llama/llama-3.3-70b-instruct:free">Meta Llama 3.3 70B</option>',
                '<option value="nvidia/nemotron-3-super-120b-a12b:free">NVIDIA Nemotron 3 Super 120B</option>',
	                '<option value="minimax/minimax-m2.5:free">MiniMax M2.5</option>',
	                '</optgroup>',
	                '<optgroup label="OpenAI - lower cost">',
	                '<option value="openai/gpt-5-nano">OpenAI GPT-5 Nano (lowest cost)</option>',
	                '<option value="openai/gpt-5-mini">OpenAI GPT-5 Mini (lower cost)</option>',
	                '<option value="openai/gpt-4.1-mini">OpenAI GPT-4.1 Mini</option>',
	                '<option value="openai/gpt-4o-mini">OpenAI GPT-4o Mini</option>',
	                '</optgroup>',
	                '<optgroup label="OpenAI - advanced / higher cost">',
	                '<option value="openai/gpt-5.3-codex">OpenAI GPT-5.3 Codex</option>',
	                '<option value="openai/gpt-5.2">OpenAI GPT-5.2</option>',
	                '<option value="openai/gpt-5.2-pro">OpenAI GPT-5.2 Pro</option>',
	                '<option value="openai/gpt-5.1">OpenAI GPT-5.1</option>',
	                '<option value="openai/gpt-5">OpenAI GPT-5</option>',
	                '<option value="openai/gpt-5-pro">OpenAI GPT-5 Pro</option>',
	                '<option value="openai/o3-pro">OpenAI o3-pro</option>',
	                '<option value="openai/o3">OpenAI o3</option>',
	                '<option value="openai/gpt-4.1">OpenAI GPT-4.1</option>',
	                '</optgroup>',
	                '<optgroup label="Groq">',
                '<option value="groq/llama-3.1-8b-instant">Groq Llama 3.1 8B Instant</option>',
                '<option value="groq/llama-3.3-70b-versatile">Groq Llama 3.3 70B Versatile</option>',
                '<option value="groq/openai/gpt-oss-120b">Groq GPT-OSS 120B</option>',
                '<option value="groq/openai/gpt-oss-20b">Groq GPT-OSS 20B</option>',
                '<option value="groq/meta-llama/llama-4-scout-17b-16e-instruct">Groq Llama 4 Scout 17B Preview</option>',
                '<option value="groq/qwen/qwen3-32b">Groq Qwen3 32B</option>',
                '<option value="groq/compound-mini">Groq Compound Mini</option>',
                '<option value="groq/compound">Groq Compound</option>',
                '</optgroup>',
              '</select>',
              '<div id="cc-model-health" class="cc-model-health" title="Model availability"></div>',
            '</div>',

            '<div class="cc-field">',
              '<label class="cc-lbl">Cover Letter Style</label>',
              '<select id="cc-style-select" class="cc-select">',
                '<option value="formal">Formal &amp; Polished</option>',
                '<option value="storytelling">Story-Driven</option>',
                '<option value="achievement">Achievement-Led</option>',
                '<option value="concise">Concise &amp; Punchy</option>',
                '<option value="startup">Startup Energy</option>',
              '</select>',
            '</div>',

            '<button id="cc-generate-btn" class="cc-btn-primary" type="button">',
              '<span class="cc-btn-label">Generate Cover Letter</span>',
              '<span class="cc-btn-progress"><span class="cc-btn-progress-fill"></span></span>',
            '</button>',
            '<div id="cc-generate-status" class="cc-inline-status cc-hidden" role="alert"></div>',

            '<div id="cc-output-wrap" class="cc-card cc-hidden">',
              '<div class="cc-card-head">Latest Cover Letter (Editable)</div>',
              '<textarea id="cc-output" class="cc-output" rows="12" spellcheck="true" aria-label="Editable generated cover letter"></textarea>',
              '<div class="cc-action-row">',
                '<button id="cc-copy-btn" class="cc-action-btn" disabled>⎘ Copy</button>',
                '<button id="cc-pdf-btn" class="cc-action-btn cc-pdf-btn" disabled>⬇ Download PDF</button>',
              '</div>',
            '</div>',
          '</section>',

          '<section class="cc-view" id="cc-view-manual">',
            '<div class="cc-card">',
              '<div class="cc-card-head">Manual Cover Letter</div>',
              '<textarea id="cc-manual-text" class="cc-output cc-manual-text" rows="12" spellcheck="true" placeholder="Dear Hiring Manager,&#10;&#10;Paste or write your cover letter here..."></textarea>',
              '<button id="cc-manual-save-btn" class="cc-btn-primary" type="button">',
                '<span class="cc-btn-label">Download Manual Letter</span>',
                '<span class="cc-btn-progress"><span class="cc-btn-progress-fill"></span></span>',
              '</button>',
              '<div id="cc-manual-status" class="cc-inline-status cc-hidden" role="alert"></div>',
            '</div>',
          '</section>',

          '<section class="cc-view" id="cc-view-ask">',
            '<div class="cc-card cc-ask-card">',
              '<div class="cc-card-head">Ask A Question</div>',
              '<textarea id="cc-question" class="cc-output cc-question" rows="5" placeholder="Example: Write a concise answer for why I want to join this company."></textarea>',
              '<button id="cc-ask-btn" class="cc-btn-primary" type="button">',
                '<span class="cc-btn-label">Answer Question</span>',
                '<span class="cc-btn-progress"><span class="cc-btn-progress-fill"></span></span>',
              '</button>',
              '<div id="cc-ask-status" class="cc-inline-status cc-hidden" role="alert"></div>',
            '</div>',
            '<div id="cc-answer-wrap" class="cc-card cc-hidden">',
              '<div class="cc-card-head">Latest Answer</div>',
              '<textarea id="cc-answer" class="cc-output" rows="10" readonly></textarea>',
              '<div class="cc-action-row">',
                '<button id="cc-copy-answer-btn" class="cc-action-btn" disabled>⎘ Copy Answer</button>',
              '</div>',
            '</div>',
          '</section>',

          '<section class="cc-view" id="cc-view-resume">',
            '<div class="cc-card">',
              '<div class="cc-card-head">Resume Mode</div>',
              '<div class="cc-note cc-hidden"></div>',
              '<div class="cc-resume-grid">',
                '<div class="cc-mini-stat">',
                  '<span class="cc-mini-stat-k">Profile</span>',
                  '<strong id="cc-resume-profile">Loading…</strong>',
                '</div>',
                '<div class="cc-mini-stat">',
                  '<span class="cc-mini-stat-k">Source</span>',
                  '<strong id="cc-resume-source">Loading…</strong>',
                '</div>',
                '<div class="cc-mini-stat">',
                  '<span class="cc-mini-stat-k">Experiences</span>',
                  '<strong id="cc-resume-experiences">0</strong>',
                '</div>',
                '<div class="cc-mini-stat">',
                  '<span class="cc-mini-stat-k">Skills</span>',
                  '<strong id="cc-resume-skills">0</strong>',
                '</div>',
                '<div class="cc-mini-stat">',
                  '<span class="cc-mini-stat-k">Job Title</span>',
                  '<strong id="cc-resume-job-title">Not loaded</strong>',
                '</div>',
                '<div class="cc-mini-stat">',
                  '<span class="cc-mini-stat-k">Company</span>',
                  '<strong id="cc-resume-company">Not loaded</strong>',
                '</div>',
	              '</div>',
	              '<div class="cc-field">',
	                '<label class="cc-lbl">Resume Format</label>',
	                '<select id="cc-resume-format" class="cc-select">',
	                  '<option value="auto">Auto by job</option>',
	                  '<option value="data_ai">Data AI/ML Engineer</option>',
	                  '<option value="ai_pm">AI Product Manager</option>',
	                  '<option value="ba_pm">Technical Business Analyst</option>',
	                  '<option value="full_stack_ai">AI Full-Stack Engineer</option>',
	                  '<option value="balanced">Balanced Technical Resume</option>',
	                '</select>',
	              '</div>',
	              '<button id="cc-resume-btn" class="cc-btn-primary" type="button">',
                '<span class="cc-btn-label">Tailor Resume</span>',
                '<span class="cc-btn-progress"><span class="cc-btn-progress-fill"></span></span>',
              '</button>',
              '<div id="cc-resume-status" class="cc-inline-status cc-hidden" role="alert"></div>',
            '</div>',

            '<div id="cc-resume-output-wrap" class="cc-card cc-hidden">',
              '<div class="cc-card-head">Resume LaTeX</div>',
              '<textarea id="cc-resume-output" class="cc-output" rows="10" readonly></textarea>',
              '<div class="cc-action-row">',
                '<button id="cc-copy-resume-latex-btn" class="cc-action-btn" disabled>⎘ Copy LaTeX</button>',
                '<button id="cc-resume-tex-btn" class="cc-action-btn cc-pdf-btn" disabled>⬇ Download LaTeX</button>',
              '</div>',
            '</div>',
          '</section>',
        '</div>',

        '<div id="cc-footer">',
          '<div class="cc-foot-links">',
            '<button class="cc-foot-btn" id="cc-foot-dash">Dashboard</button>',
            '<div class="cc-footer-mode-switch" role="tablist" aria-label="CoverCraft workspace mode">',
              '<button class="cc-primary-mode active" data-primary-mode="ai" type="button">AI</button>',
              '<button class="cc-primary-mode" data-primary-mode="manual" type="button">Manual</button>',
            '</div>',
          '</div>',
          '<button class="cc-foot-profile" id="cc-foot-profile" title="Profile" aria-label="Open Profile">',
            '<span class="cc-foot-profile-avatar" id="cc-foot-profile-avatar">G</span>',
          '</button>',
        '</div>',
      '</div>'
    ].join('');
  }

  function buildStyles() {
    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;display:block;font-family:Inter,"Segoe UI",system-ui,sans-serif;font-size:13px;color:#e2e8f0;text-align:left;direction:ltr;line-height:1.4;letter-spacing:normal;text-transform:none;text-indent:0;word-spacing:normal;white-space:normal;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;transition:right .24s cubic-bezier(.2,.8,.2,1),bottom .24s cubic-bezier(.2,.8,.2,1),transform .24s cubic-bezier(.2,.8,.2,1)}',
      ':host,:host *,:host *::before,:host *::after{box-sizing:border-box}',
      '#cc-panel,#cc-panel *{font-family:Inter,"Segoe UI",system-ui,sans-serif;letter-spacing:normal;text-transform:none;text-indent:0;word-spacing:normal;line-height:1.4;direction:ltr;text-align:left;writing-mode:horizontal-tb}',
      '#cc-panel{width:380px;max-height:min(70vh,620px);background:#0c0c15;border:1px solid #24243b;border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;contain:layout style paint;transition:width .24s cubic-bezier(.2,.8,.2,1),max-height .24s cubic-bezier(.2,.8,.2,1),border-radius .24s cubic-bezier(.2,.8,.2,1),box-shadow .24s cubic-bezier(.2,.8,.2,1),transform .24s cubic-bezier(.2,.8,.2,1)}',
      '#cc-header{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;background:linear-gradient(180deg,rgba(17,17,30,.98),rgba(14,14,24,.94));border-bottom:1px solid rgba(129,140,248,.14);user-select:none}',
      '.cc-brand{display:flex;align-items:center;gap:8px;min-width:0}',
      '.cc-star{font-size:18px;color:#818cf8}',
      '.cc-title{font-family:Syne,Inter,system-ui,sans-serif;font-size:15px;font-weight:800;color:#fff;letter-spacing:-.02em;white-space:nowrap}',
      '#cc-header-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}',
      '#cc-header-actions button{all:unset;height:24px;min-width:24px;padding:0 8px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:#94a3b8;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;display:flex;align-items:center;justify-content:center;box-sizing:border-box}',
      '#cc-header-actions button:hover{background:rgba(255,255,255,.09);color:#fff}',
      '.cc-icon-btn{width:26px;min-width:26px;padding:0 !important;font-size:15px !important;line-height:1}',
      '#cc-settings-btn{font-size:16px !important}',
      '.cc-footer-mode-switch{display:flex;gap:4px;flex:1.45 1 0;min-width:0;padding:3px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);box-sizing:border-box}',
      '.cc-primary-mode{all:unset;flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:4px 8px;border-radius:999px;background:transparent;border:1px solid transparent;color:#64748b;font-size:10.5px;font-weight:850;cursor:pointer;white-space:nowrap;box-sizing:border-box}',
      '.cc-primary-mode.active{background:linear-gradient(135deg,rgba(99,102,241,.32),rgba(139,92,246,.22));border-color:rgba(129,140,248,.28);color:#fff}',
      '.cc-mode-bar{display:flex;gap:8px;padding:0 0 2px;background:transparent}',
      '.cc-mode-bar .cc-mode{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:9px 8px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#64748b;font-size:10.5px;font-weight:800;cursor:pointer;white-space:nowrap;box-sizing:border-box}',
      '.cc-mode-bar .cc-mode.active{background:rgba(99,102,241,.18);color:#c7d2fe}',
      '.cc-ai-tabs.cc-hidden{display:none !important}',
      '.cc-sm-btn{all:unset;padding:0 9px;height:24px;border-radius:7px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);color:#94a3b8;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;display:flex;align-items:center;justify-content:center;box-sizing:border-box;transition:background .18s ease,border-color .18s ease,color .18s ease,transform .18s ease}',
      '.cc-sm-btn:hover{background:rgba(255,255,255,.09);color:#fff}',
      '.cc-sm-btn[data-state="loading"]{background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.34);color:#86efac}',
      '#cc-body{padding:11px 12px 12px;display:flex;flex-direction:column;gap:9px;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;-ms-overflow-style:none;background:radial-gradient(circle at top right,rgba(99,102,241,.12),transparent 38%),#0c0c15}',
      '#cc-body::-webkit-scrollbar,.cc-output::-webkit-scrollbar{width:0;height:0}',
      '.cc-row2{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
      '.cc-field{display:flex;flex-direction:column;gap:4px}',
      '.cc-lbl{font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em}',
      '.cc-input,.cc-select,.cc-output{all:unset;display:block;box-sizing:border-box;width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:8px 10px;color:#e2e8f0;font-size:12px;line-height:1.45}',
      '.cc-input:focus,.cc-select:focus,.cc-output:focus{border-color:rgba(129,140,248,.45)}',
      '.cc-input::placeholder,.cc-question::placeholder{color:#475569}',
      '.cc-select{padding-right:28px;cursor:pointer;-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%23818cf8\' stroke-width=\'2.5\'%3E%3Cpath d=\'m6 9 6 6 6-6\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}',
      '.cc-select option{background:#0f0f18;color:#e2e8f0}',
      '.cc-model-health{height:6px;color:#64748b;padding:0;display:block}',
      '.cc-model-health.ok{color:#86efac}',
      '.cc-model-health.warn{color:#facc15}',
      '.cc-model-health.error{color:#fca5a5}',
      '.cc-model-health.wait{color:#fcd34d}',
      '.cc-model-health-line{display:none}',
      '.cc-model-health-dot{font-size:9px;line-height:1}',
      '.cc-model-health-text{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.cc-model-health-meter{width:100%;height:6px;border-radius:999px;overflow:hidden;background:rgba(148,163,184,.16)}',
      '.cc-model-health-meter-fill{display:block;height:100%;width:0;background:#10b981;transition:width .25s ease,background .25s ease}',
      '.cc-model-health.warn .cc-model-health-meter-fill,.cc-model-health.wait .cc-model-health-meter-fill{background:#f59e0b}',
      '.cc-model-health.error .cc-model-health-meter-fill{background:#ef4444}',
      '.cc-view{display:none;flex-direction:column;gap:10px;min-height:0}',
      '.cc-view.active{display:flex}',
      '.cc-btn-primary{all:unset;position:relative;display:flex;width:100%;min-height:44px;box-sizing:border-box;padding:10px 12px;border-radius:11px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;font-size:12px;font-weight:800;text-align:center;cursor:pointer;box-shadow:0 14px 30px rgba(99,102,241,.22);overflow:hidden;align-items:center;justify-content:center}',
      '.cc-btn-primary:disabled{opacity:.9;cursor:wait}',
      '.cc-btn-primary:hover{transform:translateY(-1px)}',
      '.cc-btn-label{position:relative;z-index:2;white-space:nowrap}',
      '.cc-btn-progress{position:absolute;inset:auto 0 0 0;height:3px;background:rgba(255,255,255,.14)}',
      '.cc-btn-progress-fill{display:block;height:100%;width:0;background:rgba(255,255,255,.92);transition:width .28s ease,background .28s ease}',
      '.cc-btn-primary.loading .cc-btn-progress-fill{background:#c7d2fe}',
      '.cc-btn-primary.success{background:linear-gradient(135deg,#10b981,#22c55e);box-shadow:0 14px 30px rgba(16,185,129,.22)}',
      '.cc-btn-primary.success .cc-btn-progress-fill{background:#dcfce7}',
      '.cc-btn-primary.error{background:linear-gradient(135deg,#ef4444,#f97316);box-shadow:0 14px 30px rgba(239,68,68,.2)}',
      '.cc-btn-primary.error .cc-btn-progress-fill{background:#fee2e2}',
      '.cc-card{display:flex;flex-direction:column;gap:8px;padding:11px;border-radius:14px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08)}',
      '.cc-card-head{font-size:10px;font-weight:800;color:#e2e8f0;text-transform:uppercase;letter-spacing:.08em}',
      '.cc-note{font-size:11px;line-height:1.6;color:#94a3b8}',
      '.cc-resume-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.cc-mini-stat{display:flex;flex-direction:column;gap:4px;padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06)}',
      '.cc-mini-stat-k{font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em}',
      '.cc-mini-stat strong{font-size:12px;font-weight:700;color:#e2e8f0;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.cc-inline-status{padding:9px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#94a3b8;font-size:11px;line-height:1.55;overflow-wrap:anywhere}',
      '.cc-inline-status.loading{background:rgba(99,102,241,.08);border-color:rgba(129,140,248,.2);color:#dbe4ff}',
      '.cc-inline-status.ok{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.18);color:#d1fae5}',
      '.cc-inline-status.error{background:rgba(239,68,68,.08);border-color:rgba(239,68,68,.2);color:#fee2e2}',
      '.cc-output{resize:vertical;min-height:110px;max-height:360px;overflow:auto;scrollbar-width:none;-ms-overflow-style:none}',
      '.cc-manual-text{min-height:220px}',
      '.cc-question{min-height:90px}',
      '.cc-action-row{display:flex;gap:8px;justify-content:center;align-items:center}',
      '.cc-action-btn{all:unset;flex:1;display:flex;align-items:center;justify-content:center;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#cbd5e1;font-size:11px;font-weight:700;text-align:center;cursor:pointer}',
      '.cc-action-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.cc-pdf-btn{background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.2);color:#6ee7b7}',
      '#cc-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;background:#10101a;border-top:1px solid rgba(255,255,255,.06)}',
      '.cc-foot-links{display:flex;gap:8px;align-items:center;min-width:0;flex:1}',
      '.cc-foot-btn{all:unset;flex:.85 1 0;min-width:0;padding:7px 12px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#94a3b8;font-size:11px;font-weight:700;text-align:center;cursor:pointer;box-sizing:border-box;display:flex;align-items:center;justify-content:center}',
      '.cc-foot-btn:hover{color:#fff;background:rgba(255,255,255,.08)}',
      '.cc-foot-profile{all:unset;display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);cursor:pointer;flex-shrink:0;transition:transform .18s ease,background .18s ease,border-color .18s ease}',
      '.cc-foot-profile:hover{transform:translateY(-1px);background:rgba(255,255,255,.08);border-color:rgba(129,140,248,.26)}',
      '.cc-foot-profile-avatar{width:100%;height:100%;border-radius:999px;overflow:hidden;display:grid;place-items:center;background:rgba(129,140,248,.14);color:#dbe4ff;font-family:Syne,Inter,system-ui,sans-serif;font-size:11px;font-weight:800}',
      '.cc-foot-profile-avatar img{width:100%;height:100%;display:block;object-fit:cover}',
      '.cc-hidden{display:none !important}',
      ':host(.cc-minimized)::after{content:"";position:absolute;right:0;top:50%;width:16px;height:46px;transform:translate(8px,-50%);border-radius:0 999px 999px 0;background:linear-gradient(180deg,rgba(129,140,248,.88),rgba(139,92,246,.72));opacity:.9;pointer-events:none;box-shadow:0 0 18px rgba(129,140,248,.2)}',
      ':host(.cc-minimized) #cc-panel{width:58px;max-height:84px;border-radius:20px 0 0 20px;box-shadow:0 16px 42px rgba(0,0,0,.34);transform:translateX(0)}',
      ':host(.cc-minimized:hover) #cc-panel,:host(.cc-minimized:focus-within) #cc-panel{transform:translateX(-4px);box-shadow:0 18px 48px rgba(0,0,0,.42)}',
      ':host(.cc-minimized) #cc-header{padding:0;border-bottom:none;cursor:pointer;min-height:86px;justify-content:center}',
      ':host(.cc-minimized) #cc-header-actions{display:none !important}',
      ':host(.cc-minimized) #cc-scrape-btn,:host(.cc-minimized) .cc-mode-bar,:host(.cc-minimized) #cc-body,:host(.cc-minimized) #cc-footer{display:none !important}',
      ':host(.cc-minimized) .cc-brand{width:100%;justify-content:center}',
      ':host(.cc-minimized) .cc-star{font-size:21px;color:#818cf8;opacity:1;transition:opacity .24s cubic-bezier(.2,.8,.2,1),color .24s cubic-bezier(.2,.8,.2,1)}',
      ':host(.cc-minimized:hover) .cc-star,:host(.cc-minimized:focus-within) .cc-star{color:#c7d2fe}',
      ':host(.cc-minimized) .cc-title{display:none}',
      ':host(.cc-minimized) #cc-panel{overflow:hidden}',
      '@media (max-width: 640px){#cc-panel{width:min(92vw,392px)}.cc-row2,.cc-resume-grid{grid-template-columns:1fr}.cc-mode-bar{padding-top:0}}'
    ].join('\n');
    return style;
  }

  function buttonParts(id) {
    var button = $id(id);
    if (!button) return null;
    return {
      button: button,
      label: button.querySelector('.cc-btn-label'),
      fill: button.querySelector('.cc-btn-progress-fill')
    };
  }

  function setMinimizedControls(minimized) {
    var button = $id('cc-min-btn');
    if (!button) return;
    if (minimized) {
      button.textContent = '▢';
      button.setAttribute('title', 'Restore');
      return;
    }
    button.textContent = '−';
    button.setAttribute('title', 'Minimize');
  }

  function setButtonState(id, state) {
    var parts = buttonParts(id);
    if (!parts) return;
    var config = state || {};
    parts.button.classList.remove('loading', 'success', 'error');
    if (config.kind) parts.button.classList.add(config.kind);
    parts.button.disabled = !!config.disabled;
    if (parts.label && config.label != null) parts.label.textContent = config.label;
    if (parts.fill) parts.fill.style.width = (typeof config.progress === 'number' ? Math.max(0, Math.min(100, config.progress)) : 0) + '%';
  }

  function resetActionButton(id) {
    if (id === 'cc-generate-btn') {
      stopSessionProgressPolling();
      setButtonState(id, { label: 'Generate Cover Letter', progress: 0, disabled: false });
      return;
    }
    if (id === 'cc-manual-save-btn') {
      setButtonState(id, { label: 'Download Manual Letter', progress: 0, disabled: false });
      return;
    }
    if (id === 'cc-ask-btn') {
      stopSessionProgressPolling();
      setButtonState(id, { label: 'Answer Question', progress: 0, disabled: false });
      return;
    }
    if (id === 'cc-resume-btn') {
      stopSessionProgressPolling();
      setButtonState(id, { label: 'Tailor Resume', progress: 0, disabled: false });
    }
  }

  function flashButtonState(id, label, kind, holdMs) {
    setButtonState(id, { label: label, progress: kind === 'success' ? 100 : 0, kind: kind, disabled: false });
    window.setTimeout(function() {
      resetActionButton(id);
    }, holdMs || 2200);
  }

  function flashSmallButton(id, label, holdMs) {
    var button = $id(id);
    if (!button) return;
    var original = button.getAttribute('data-idle-label') || button.textContent || 'Scrape';
    button.setAttribute('data-idle-label', original);
    button.disabled = true;
    button.textContent = label;
    window.setTimeout(function() {
      if (!$id(id)) return;
      button.disabled = false;
      button.textContent = original;
    }, holdMs || 1800);
  }

  function shortFailureLabel(errorText, fallback) {
    var text = String(errorText || '').trim().toLowerCase();
    if (!text) return fallback || 'Request Failed';
	    if (text.indexOf('tavily api key') !== -1) return 'Add Tavily Key';
	    if (text.indexOf('groq api key') !== -1) return 'Add Groq Key';
	    if (text.indexOf('openai api key') !== -1) return 'Add OpenAI Key';
	    if (text.indexOf('openrouter api key') !== -1) return 'Add OpenRouter Key';
    if (text.indexOf('job title or company') !== -1) return 'Need Job Details';
    if (text.indexOf('could not parse') !== -1) return 'Parse Error';
    if (text.indexOf('incomplete cover letter') !== -1) return 'Model Output Failed';
    if (text.indexOf('empty response') !== -1) return 'Empty AI Output';
    if (text.indexOf('http') !== -1) return 'API Request Failed';
    return fallback || 'Request Failed';
  }

  function detailedFailureMessage(errorText, fallback) {
    var text = String(errorText || '').replace(/\s+/g, ' ').trim();
    return text || fallback || 'Something went wrong.';
  }

  function selectedModelValue() {
    return ($id('cc-model-select') && $id('cc-model-select').value) || 'openrouter/free';
  }

	  function modelUsesGroq(model) {
	    return /^groq\//i.test(String(model || ''));
	  }

	  function modelUsesOpenAI(model) {
	    return /^openai\//i.test(String(model || ''));
	  }

  function hasCachedResearch() {
    return !!(currentSession && currentSession.research && currentSession.research.summary);
  }

  function runtimeValidationMessage(action, settings) {
    settings = settings || {};
    var model = selectedModelValue();
    var missing = [];
	    if (modelUsesGroq(model)) {
	      if (!settings.groqKey) missing.push('Groq API key for the selected model');
	    } else if (modelUsesOpenAI(model)) {
	      if (!settings.openaiKey) missing.push('OpenAI API key for the selected model');
	    } else if (!settings.openrouterKey) {
      missing.push('OpenRouter API key for the selected model');
    }
    var needsResearch = action === 'generate' || action === 'resume' || (action === 'ask' && !hasCachedResearch());
    if (needsResearch && !settings.tavilyKey) missing.push('Tavily API key for company research');
    if (!missing.length) return '';
    return 'Missing setup: ' + missing.join(', ') + '. Open CoverCraft Settings, add the missing key' + (missing.length === 1 ? '' : 's') + ', save, then try again.';
  }

  function withRuntimeValidation(action, statusFn, buttonId, callback) {
    safeMsg({ type: 'GET_SETTINGS' }, function(response) {
      if (!ctxOk() || chrome.runtime.lastError) {
        statusFn('error', 'CoverCraft could not read settings. Reopen the extension and try again.');
        flashButtonState(buttonId, 'Settings Error', 'error', 2200);
        return;
      }
      if (!response || response.error) {
        statusFn('error', response && response.error || 'CoverCraft could not read settings.');
        flashButtonState(buttonId, 'Settings Error', 'error', 2200);
        return;
      }
      currentSettings = response.settings || {};
      currentModelHealth = response.modelHealth || currentModelHealth || {};
      renderModelHealth();
      var message = runtimeValidationMessage(action, currentSettings);
      if (message) {
        statusFn('error', message);
        flashButtonState(buttonId, 'Missing Setup', 'error', 2400);
        return;
      }
      callback();
    });
  }

  function formatHealthTimestamp(value) {
    if (!value) return '';
    try {
      return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (_) {
      return '';
    }
  }

  function renderModelHealth() {
    var el = $id('cc-model-health');
    var select = $id('cc-model-select');
    if (!el || !select) return;
    scheduleModelHealthTicker();
    var model = select.value || 'openrouter/free';
    var health = Core.lookupModelHealth(currentModelHealth, model);
    updateModelOptionAvailability();
    el.className = 'cc-model-health';
    el.innerHTML = '';
    function setHealthContent(availability, text) {
      el.title = text || 'Model availability';
      var meter = document.createElement('div');
      var fill = document.createElement('span');
      meter.className = 'cc-model-health-meter';
      fill.className = 'cc-model-health-meter-fill';
      fill.style.width = (availability.percent == null ? 0 : availability.percent) + '%';
      meter.appendChild(fill);
      el.appendChild(meter);
    }
    if (!health) {
      setHealthContent(Core.modelAvailability(null), 'No provider telemetry recorded yet.');
      return;
    }
    var availability = Core.modelAvailability(health);
    var waitMs = health.blockedUntil ? health.blockedUntil - Date.now() : 0;
    var rate = health.rateLimit || {};
    var parts = [];
    var checkedAt = formatHealthTimestamp(health.checkedAt);
    if (availability.percent != null) parts.push(availability.percent + '% ' + (availability.source || 'capacity') + ' available');
    if (checkedAt) parts.push('checked ' + checkedAt);
    if (rate.remainingTokens) parts.push(rate.remainingTokens + ' TPM left');
    if (rate.limitTokens) parts.push(rate.limitTokens + ' TPM limit');
    if (rate.remainingRequests) parts.push(rate.remainingRequests + ' daily requests left');
    if (rate.resetTokens) parts.push('resets in ' + rate.resetTokens);
    if (health.totalTokens) parts.push('actual ' + health.totalTokens + ' tokens');
    if (health.estimatedTokens) parts.push('last request ~' + health.estimatedTokens + ' tokens');
    if (health.ok) {
      el.classList.add(availability.tone);
      setHealthContent(availability, (availability.status === 'limited' ? 'Low capacity: ' : 'Available: ') + (parts.length ? parts.join(' · ') : 'Last request succeeded.'));
      return;
    }
    el.classList.add(availability.tone);
    setHealthContent(availability, (waitMs > 0 ? 'Wait ' + formatHealthWait(waitMs) : 'Unavailable' + (health.status ? ' (' + health.status + ')' : '')) + ': ' + (parts.join(' · ') || (health.error || 'No provider headers returned.')));
  }

  function hasActiveModelCooldown() {
    var now = Date.now();
    return Object.keys(currentModelHealth || {}).some(function(model) {
      var health = currentModelHealth[model];
      return health && health.blockedUntil && health.blockedUntil > now && (health.status === 429 || health.status === 413);
    });
  }

  function scheduleModelHealthTicker() {
    if (modelHealthTickTimer || !hasActiveModelCooldown()) return;
    modelHealthTickTimer = window.setTimeout(function() {
      modelHealthTickTimer = null;
      refreshModelHealth();
    }, nextModelCooldownDelay());
  }

  function formatHealthWait(ms) {
    if (!ms || ms <= 0) return '';
    var seconds = Math.ceil(ms / 1000);
    return seconds < 60 ? seconds + 's' : Math.ceil(seconds / 60) + 'm';
  }

  function nextModelCooldownDelay() {
    var now = Date.now();
    var next = Object.keys(currentModelHealth || {}).reduce(function(min, model) {
      var health = currentModelHealth[model];
      if (!health || !health.blockedUntil || health.blockedUntil <= now || (health.status !== 429 && health.status !== 413)) return min;
      return Math.min(min, health.blockedUntil - now);
    }, 60000);
    return Math.max(1000, Math.min(next + 250, 60000));
  }

  function cleanModelOptionLabel(option) {
    return String(option.dataset.baseLabel || option.textContent || '')
      .replace(/^[🟢🟡🔴⚪]\s+/u, '')
      .replace(/\s+\(wait .*?\)$/i, '')
      .replace(/\s+\(unavailable\)$/i, '');
  }

  function updateModelOptionAvailability() {
    var select = $id('cc-model-select');
    if (!select) return;
    Array.prototype.slice.call(select.options).forEach(function(option) {
      option.dataset.baseLabel = cleanModelOptionLabel(option);
      var health = Core.lookupModelHealth(currentModelHealth, option.value);
      var availability = Core.modelAvailability(health);
      var waitMs = health && health.blockedUntil ? health.blockedUntil - Date.now() : 0;
      var unavailable = availability.status === 'unavailable';
      var suffix = unavailable && waitMs > 0 ? ' (wait ' + formatHealthWait(waitMs) + ')' : (unavailable ? ' (unavailable)' : '');
      option.disabled = unavailable && option.value !== select.value;
      option.textContent = (availability.dot ? availability.dot + ' ' : '') + option.dataset.baseLabel + suffix;
      option.title = health && health.error ? health.error : availability.label;
    });
  }

  function refreshModelHealth() {
    safeMsg({ type: 'GET_SETTINGS' }, function(response) {
      if (!response || response.error) return;
      currentModelHealth = response.modelHealth || currentModelHealth || {};
      renderModelHealth();
    });
  }

  function refreshModelHealthFromHeader() {
    var button = $id('cc-model-health-refresh-btn');
    if (button) {
      button.disabled = true;
      button.textContent = '⟳';
    }
    safeMsg({ type: 'GET_SETTINGS' }, function(response) {
      if (response && response.modelHealth) currentModelHealth = response.modelHealth;
      renderModelHealth();
      if (!button) return;
      window.setTimeout(function() {
        if (!$id('cc-model-health-refresh-btn')) return;
        button.disabled = false;
        button.textContent = '↻';
      }, 350);
    });
  }

  function setGenerateStatus(kind, message) {
    var el = $id('cc-generate-status');
    if (!el) return;
    showElement('cc-generate-status', !!(kind && message));
    el.className = 'cc-inline-status' + (kind ? ' ' + kind : '');
    el.textContent = message || '';
    generateViewState.kind = kind || '';
    generateViewState.message = el.textContent;
  }

  function setManualStatus(kind, message) {
    var el = $id('cc-manual-status');
    if (!el) return;
    showElement('cc-manual-status', !!(kind && message));
    el.className = 'cc-inline-status' + (kind ? ' ' + kind : '');
    el.textContent = message || '';
    manualViewState.kind = kind || '';
    manualViewState.message = el.textContent;
  }

  function setAskStatus(kind, message) {
    var el = $id('cc-ask-status');
    if (!el) return;
    showElement('cc-ask-status', !!(kind && message));
    el.className = 'cc-inline-status' + (kind ? ' ' + kind : '');
    el.textContent = message || '';
    askViewState.kind = kind || '';
    askViewState.message = el.textContent;
  }

  function startGenerateProgress() {
    hideOutput();
    refreshModelHealth();
    setGenerateStatus('', '');
    resetActionButton('cc-generate-btn');
    setButtonState('cc-generate-btn', { label: 'Step 1 · Job Details', progress: 20, kind: 'loading', disabled: true });
    startSessionProgressPolling('cc-generate-btn', 'generate');
  }

  function completeGenerateProgress(success, message, detailMessage) {
    stopSessionProgressPolling();
    if (success) {
      setGenerateStatus('', '');
      setButtonState('cc-generate-btn', { label: message || 'Cover Letter Ready', progress: 100, kind: 'success', disabled: false });
      window.setTimeout(function() {
        resetActionButton('cc-generate-btn');
      }, 1800);
      return;
    }
    setGenerateStatus('error', detailedFailureMessage(detailMessage || message, 'Cover letter generation failed.'));
    flashButtonState('cc-generate-btn', message || 'Generation Failed', 'error', 2400);
  }

  function completeManualProgress(success, message, detailMessage) {
    if (success) {
      showElement('cc-manual-status', false);
      setButtonState('cc-manual-save-btn', { label: message || 'Manual Letter Ready', progress: 100, kind: 'success', disabled: false });
      window.setTimeout(function() {
        resetActionButton('cc-manual-save-btn');
      }, 1600);
      return;
    }
    setManualStatus('error', detailedFailureMessage(detailMessage || message, 'Manual cover letter save failed.'));
    flashButtonState('cc-manual-save-btn', message || 'Save Failed', 'error', 2200);
  }

  function startAskProgress() {
    refreshModelHealth();
    setAskStatus('', '');
    resetActionButton('cc-ask-btn');
    setButtonState('cc-ask-btn', { label: 'Step 1 · Loading Context', progress: 20, kind: 'loading', disabled: true });
    startSessionProgressPolling('cc-ask-btn', 'ask');
  }

  function completeAskProgress(success, message, detailMessage) {
    stopSessionProgressPolling();
    if (success) {
      setAskStatus('ok', 'Answer ready. Review the reply and copy it if you want to refine it elsewhere.');
      setButtonState('cc-ask-btn', { label: message || 'Answer Ready', progress: 100, kind: 'success', disabled: false });
      window.setTimeout(function() {
        resetActionButton('cc-ask-btn');
      }, 1600);
      return;
    }
    setAskStatus('error', detailedFailureMessage(detailMessage || message, 'Answer generation failed.'));
    flashButtonState('cc-ask-btn', message || 'Answer Failed', 'error', 2200);
  }

  function startResumeProgress() {
    refreshModelHealth();
    resetActionButton('cc-resume-btn');
    hideResumeDraft();
    setResumeStatus('loading', 'Preparing resume context for this job…');
    setButtonState('cc-resume-btn', { label: 'Step 1 · Loading Context', progress: 18, kind: 'loading', disabled: true });
    startSessionProgressPolling('cc-resume-btn', 'resume');
  }

  function completeResumeProgress(success, message) {
    stopSessionProgressPolling();
    if (success) {
      setButtonState('cc-resume-btn', { label: message || 'LaTeX Ready', progress: 100, kind: 'success', disabled: false });
      window.setTimeout(function() {
        resetActionButton('cc-resume-btn');
      }, 1800);
      return;
    }
    flashButtonState('cc-resume-btn', message || 'Resume Failed', 'error', 2400);
  }

  function fitTextarea(id, minHeight, maxHeight) {
    var el = $id(id);
    if (!el) return;
    var min = minHeight || 110;
    var max = maxHeight || 360;
    el.style.height = 'auto';
    var next = Math.max(min, Math.min(el.scrollHeight, max));
    el.style.height = next + 'px';
  }

  function renderFooterProfile() {
    var avatar = $id('cc-foot-profile-avatar');
    if (!avatar) return;
    avatar.innerHTML = '';
    if (currentCloud && currentCloud.signedIn && currentCloud.user) {
      if (currentCloud.user.photoURL) {
        var img = document.createElement('img');
        img.src = currentCloud.user.photoURL;
        img.alt = currentCloud.user.displayName || currentCloud.user.email || 'User';
        avatar.appendChild(img);
        return;
      }
      avatar.textContent = Core.ownerSnapshot({ name: currentCloud.user.displayName || currentCloud.user.email }).name
        ? String((currentCloud.user.displayName || currentCloud.user.email || 'U').trim()).charAt(0).toUpperCase()
        : 'U';
      return;
    }
    avatar.textContent = 'G';
  }

  function setResumeStatus(kind, message) {
    var el = $id('cc-resume-status');
    if (!el) return;
    showElement('cc-resume-status', !!(kind && message));
    el.className = 'cc-inline-status' + (kind ? ' ' + kind : '');
    el.textContent = message || '';
    resumeViewState.kind = kind || '';
    resumeViewState.message = el.textContent;
  }

  function formatResumeCompletionStatus(artifact) {
    var changes = artifact && artifact.modifications || {};
    var titles = Array.isArray(changes.modifiedExperienceTitles) ? changes.modifiedExperienceTitles.filter(Boolean) : [];
    var bulletCount = Number(changes.modifiedBulletCount) || 0;
    var skillsCount = Number(changes.finalSkillsCount || changes.skillsCount) || 0;
	    var addedSkillsCount = Array.isArray(changes.addedSkills) ? changes.addedSkills.length : 0;
	    var issueCount = Number(changes.qualityIssueCount) || 0;
	    var commentCount = Array.isArray(changes.bulletComments) ? changes.bulletComments.length : 0;
	    var auditText = ' Audit comments: ' + commentCount + (issueCount ? ', quality flags: ' + issueCount : '') + '.';
	    if (!bulletCount) {
	      return 'Resume LaTeX ready. No experience bullets needed changes. Skills included: ' + skillsCount + ', skills added: ' + addedSkillsCount + '.' + auditText + ' Copy it or download the file for Overleaf.';
	    }
	    return 'Resume LaTeX ready. Modified ' + bulletCount + ' bullet' + (bulletCount === 1 ? '' : 's') + ' across ' + titles.join(', ') + '. Skills included: ' + skillsCount + ', skills added: ' + addedSkillsCount + '.' + auditText + ' Copy it or download the file for Overleaf.';
	  }

  function skillCountFromPortfolio(portfolio) {
    if (!portfolio) return 0;
    var normalized = Core.normalizePortfolio(portfolio || {}).normalized || {};
    return String(normalized.skills || '')
      .split(',')
      .map(function(item) { return item.trim(); })
      .filter(Boolean).length;
  }

  function renderResumeSummary() {
    var normalized = currentPortfolio ? (Core.normalizePortfolio(currentPortfolio).normalized || {}) : {};
    var ownerName = currentCloud && currentCloud.signedIn && currentCloud.user
      ? (currentCloud.user.displayName || currentCloud.user.email || '')
      : (normalized.name || currentOwner && currentOwner.name || 'Guest');
    var profileLabel = ownerName || 'Guest';
    var sourceLabel = currentPortfolioSource || (currentCloud && currentCloud.signedIn ? 'cloud_sync' : 'local_file');
    var experienceCount = Array.isArray(normalized.experiences) ? normalized.experiences.length : 0;
    var job = currentSession && currentSession.job || {};

    if ($id('cc-resume-profile')) $id('cc-resume-profile').textContent = profileLabel;
    if ($id('cc-resume-source')) $id('cc-resume-source').textContent = sourceLabel.replace(/_/g, ' ');
    if ($id('cc-resume-experiences')) $id('cc-resume-experiences').textContent = String(experienceCount);
    if ($id('cc-resume-skills')) $id('cc-resume-skills').textContent = String(skillCountFromPortfolio(normalized));
    if ($id('cc-resume-job-title')) $id('cc-resume-job-title').textContent = job.jobTitle || 'Not loaded';
    if ($id('cc-resume-company')) $id('cc-resume-company').textContent = job.companyName || 'Not loaded';
  }

  function revealResumeDraft(text) {
    var value = String(text || '').trim();
    if ($id('cc-resume-output')) $id('cc-resume-output').value = value;
    fitTextarea('cc-resume-output', 150, 340);
    var artifact = getCurrentResumeArtifact();
    if ($id('cc-copy-resume-latex-btn')) $id('cc-copy-resume-latex-btn').disabled = !(artifact && artifact.latexSource);
    if ($id('cc-resume-tex-btn')) $id('cc-resume-tex-btn').disabled = !(artifact && artifact.latexSource);
    showElement('cc-resume-output-wrap', !!value);
    resumeViewState.text = value;
    window.requestAnimationFrame(function() {
      placeExpandedPanel(true);
    });
  }

  function hideResumeDraft() {
    if ($id('cc-resume-output')) $id('cc-resume-output').value = '';
    if ($id('cc-copy-resume-latex-btn')) $id('cc-copy-resume-latex-btn').disabled = true;
    if ($id('cc-resume-tex-btn')) $id('cc-resume-tex-btn').disabled = true;
    showElement('cc-resume-output-wrap', false);
    resumeViewState.text = '';
  }

  function loadPortfolioSnapshot() {
    safeMsg({ type: 'GET_ACTIVE_PORTFOLIO' }, function(response) {
      if (!response || response.error) return;
      currentPortfolio = response.portfolio || null;
      currentPortfolioSource = response.source || 'local_file';
      renderResumeSummary();
    });
  }

  function progressStateForSession(session, mode) {
    var pipeline = session && session.pipeline || {};
    var flow = pipeline.kind || pipeline.flow || '';
    var stage = pipeline.stage || '';
    if (!flow) return null;
    if (mode === 'generate' && flow !== 'generate' && flow !== 'refresh') return null;
    if (mode === 'ask' && flow !== 'ask' && flow !== 'refresh') return null;
    if (mode === 'resume' && flow !== 'resume' && flow !== 'refresh') return null;
    if (pipeline.status === 'success' || stage === 'complete') return null;
    if (stage === 'error') return {
      label: pipeline.label || pipeline.message || 'Request Failed',
      progress: 0,
      kind: 'error'
    };
    if (pipeline.label) return {
      label: pipeline.label,
      progress: typeof pipeline.progress === 'number' ? pipeline.progress : (mode === 'ask' ? 44 : 52),
      kind: pipeline.status === 'error' ? 'error' : 'loading'
    };
    if (stage === 'extract') return {
      label: mode === 'ask' ? 'Step 1 · Loading Context' : 'Step 1 · Job Details',
      progress: 26,
      kind: 'loading'
    };
    if (stage === 'research') return {
      label: 'Step 2 · Researching',
      progress: mode === 'ask' ? 42 : (mode === 'resume' ? 54 : 58),
      kind: 'loading'
    };
    if (stage === 'waiting_ai') return {
      label: mode === 'resume' ? 'Step 3 · Waiting For AI' : (mode === 'ask' ? 'Step 3 · Waiting For AI' : 'Step 3 · Waiting For AI'),
      progress: mode === 'resume' ? 84 : 88,
      kind: 'loading'
    };
    return {
      label: pipeline.label || pipeline.message || (mode === 'ask' ? 'Answering Question' : (mode === 'resume' ? 'Tailoring Resume' : 'Generating Cover Letter')),
      progress: mode === 'resume' ? 32 : 36,
      kind: 'loading'
    };
  }

  function stopSessionProgressPolling() {
    if (sessionProgressPollTimer) {
      clearInterval(sessionProgressPollTimer);
      sessionProgressPollTimer = null;
    }
  }

  function startSessionProgressPolling(buttonId, mode) {
    stopSessionProgressPolling();
    sessionProgressPollTimer = window.setInterval(function() {
      safeMsg({
        type: 'GET_PAGE_SESSION',
        payload: { pageUrl: window.location.href }
      }, function(response) {
        if (!response || response.error || !response.session) return;
        currentSession = response.session;
        if (response.session.pipeline && (response.session.pipeline.status === 'error' || response.session.pipeline.stage === 'error')) {
          var detail = detailedFailureMessage(response.session.pipeline.error || response.session.pipeline.label, 'Request failed.');
          if (mode === 'generate') setGenerateStatus('error', detail);
          if (mode === 'ask') setAskStatus('error', detail);
          if (mode === 'resume') setResumeStatus('error', detail);
        }
        var next = progressStateForSession(response.session, mode);
        if (!next) return;
        setButtonState(buttonId, {
          label: next.label,
          progress: next.progress,
          kind: next.kind,
          disabled: true
        });
      });
    }, 700);
  }

  function switchView(view) {
    var isManual = view === 'manual';
    if (!isManual) lastAiView = view || lastAiView || 'generate';
    shadow.querySelectorAll('.cc-primary-mode').forEach(function(button) {
      button.classList.toggle('active', button.getAttribute('data-primary-mode') === (isManual ? 'manual' : 'ai'));
    });
    var aiTabs = shadow.querySelector('.cc-ai-tabs');
    if (aiTabs) aiTabs.classList.toggle('cc-hidden', isManual);
    shadow.querySelectorAll('.cc-mode').forEach(function(button) {
      button.classList.toggle('active', button.getAttribute('data-view') === view);
    });
    shadow.querySelectorAll('.cc-view').forEach(function(section) {
      section.classList.toggle('active', section.id === 'cc-view-' + view);
    });
    if (view === 'resume') {
      renderResumeSummary();
    }
    persistPanelState({ activeView: view });
  }

  function getCurrentOutputArtifact() {
    if (!currentSession || !currentSession.artifacts || !currentSession.artifacts.length) return null;
    return currentSession.artifacts[0];
  }

  function getCurrentResumeArtifact() {
    if (!currentSession || !currentSession.resumes || !currentSession.resumes.length) return null;
    return currentSession.resumes[0];
  }

  function hydrateSession(session) {
    currentSession = session || null;
    if (!session) return;

    if ($id('cc-title-hint')) $id('cc-title-hint').value = session.job && session.job.jobTitle || '';
    if ($id('cc-company-hint')) $id('cc-company-hint').value = session.job && session.job.companyName || '';
    resetHintDirtyState();
    if ($id('cc-output')) $id('cc-output').value = session.latestArtifact && session.latestArtifact.text || '';
    if ($id('cc-manual-text') && session.latestArtifact && session.latestArtifact.source === 'manual') $id('cc-manual-text').value = session.latestArtifact.text || '';
    if ($id('cc-question')) $id('cc-question').value = '';
    if ($id('cc-answer')) $id('cc-answer').value = session.chat && session.chat[0] ? session.chat[0].answer : '';
    if ($id('cc-raw-text')) $id('cc-raw-text').value = session.scrape && session.scrape.preview ? session.scrape.preview : '';
    if (session.latestArtifact && session.latestArtifact.owner) currentOwner = session.latestArtifact.owner;
    renderResumeSummary();

    var generateRunning = session.pipeline && (session.pipeline.kind === 'generate' || session.pipeline.kind === 'refresh') &&
      session.pipeline.status !== 'success' && session.pipeline.stage !== 'complete';
    if (!generateRunning && session.latestArtifact && session.latestArtifact.text) {
      revealOutput(session.latestArtifact.text);
    } else {
      hideOutput();
    }
    refreshManualActions();
    if (session.chat && session.chat[0] && session.chat[0].answer) {
      revealAnswer(session.chat[0].answer);
    } else {
      hideAnswer();
    }
    if (session.latestResume && session.latestResume.latexSource) revealResumeDraft(session.latestResume.latexSource);
    else if (!resumeViewState.text) hideResumeDraft();
    switchView(session.panel && session.panel.activeView || 'generate');
  }

  function hydrateFreshOpenSession(session) {
    currentSession = session || null;
    if (!session) {
      ensureScrape();
      resetHintDirtyState();
      hideOutput();
      hideAnswer();
      setGenerateStatus('', '');
      setManualStatus('', '');
      setAskStatus('', '');
      switchView('generate');
      return;
    }

    if ($id('cc-title-hint')) $id('cc-title-hint').value = session.job && session.job.jobTitle || '';
    if ($id('cc-company-hint')) $id('cc-company-hint').value = session.job && session.job.companyName || '';
    resetHintDirtyState();
    if ($id('cc-question')) $id('cc-question').value = '';
    if ($id('cc-answer')) $id('cc-answer').value = '';
    if ($id('cc-raw-text')) $id('cc-raw-text').value = session.scrape && session.scrape.preview ? session.scrape.preview : '';
    if (session.latestArtifact && session.latestArtifact.owner) currentOwner = session.latestArtifact.owner;
    hideOutput();
    hideAnswer();
    hideResumeDraft();
    setGenerateStatus('', '');
    setManualStatus('', '');
    setAskStatus('', '');
    setResumeStatus('', '');
    renderResumeSummary();
    switchView('generate');
  }

  function minimizedDockPosition() {
    var visiblePeek = 36;
    return {
      right: -(58 - visiblePeek),
      bottom: 18
    };
  }

  function expandedDockPosition() {
    return {
      right: 18,
      bottom: 18
    };
  }

  function applyPosition(position) {
    if (!host) return;
    if (typeof position.left === 'number') {
      host.style.left = position.left + 'px';
      host.style.right = 'auto';
    } else {
      host.style.left = 'auto';
      host.style.right = position.right + 'px';
    }
    host.style.bottom = position.bottom + 'px';
  }

  function keepExpandedVisible(forceBottomDock) {
    if (!host || host.classList.contains('cc-minimized')) return;
    applyPosition(expandedDockPosition());
  }

  function placeExpandedPanel(forceBottomDock) {
    if (!host || host.classList.contains('cc-minimized')) return;
    var next = expandedDockPosition();
    applyPosition(next);
    keepExpandedVisible(forceBottomDock !== false);
  }

  function placeMinimizedPanel() {
    if (!host || !host.classList.contains('cc-minimized')) return;
    applyPosition(minimizedDockPosition());
  }

  function showElement(id, show) {
    var el = $id(id);
    if (!el) return;
    el.classList.toggle('cc-hidden', !show);
  }

  function revealOutput(text) {
    if ($id('cc-output')) $id('cc-output').value = text || '';
    fitTextarea('cc-output', 160, 360);
    if ($id('cc-copy-btn')) $id('cc-copy-btn').disabled = !text;
    if ($id('cc-pdf-btn')) $id('cc-pdf-btn').disabled = !text;
    if (text) showElement('cc-generate-status', false);
    showElement('cc-output-wrap', !!text);
    window.requestAnimationFrame(function() {
      placeExpandedPanel(true);
    });
  }

  function refreshOutputActions() {
    var text = ($id('cc-output') && $id('cc-output').value || '').trim();
    if ($id('cc-copy-btn')) $id('cc-copy-btn').disabled = !text;
    if ($id('cc-pdf-btn')) $id('cc-pdf-btn').disabled = !text;
    fitTextarea('cc-output', 160, 360);
    if (text) showElement('cc-generate-status', false);
  }

  function refreshManualActions() {
    var text = ($id('cc-manual-text') && $id('cc-manual-text').value || '').trim();
    fitTextarea('cc-manual-text', 220, 360);
    if (text) {
      showElement('cc-manual-status', false);
    } else {
      showElement('cc-manual-status', false);
    }
  }

  function hideOutput() {
    if ($id('cc-output')) $id('cc-output').value = '';
    if ($id('cc-copy-btn')) $id('cc-copy-btn').disabled = true;
    if ($id('cc-pdf-btn')) $id('cc-pdf-btn').disabled = true;
    showElement('cc-output-wrap', false);
    showElement('cc-generate-status', false);
  }

  function revealAnswer(text) {
    if ($id('cc-answer')) $id('cc-answer').value = text || '';
    fitTextarea('cc-answer', 150, 340);
    if ($id('cc-copy-answer-btn')) $id('cc-copy-answer-btn').disabled = !text;
    showElement('cc-answer-wrap', !!text);
    window.requestAnimationFrame(function() {
      placeExpandedPanel(true);
    });
  }

  function hideAnswer() {
    if ($id('cc-answer')) $id('cc-answer').value = '';
    if ($id('cc-copy-answer-btn')) $id('cc-copy-answer-btn').disabled = true;
    showElement('cc-answer-wrap', false);
  }

  function persistPanelState(extra) {
    if (!currentSession && !window.location.href) return;
    var panel = {
      open: true,
      minimized: !!(host && host.classList.contains('cc-minimized')),
      activeView: shadow && shadow.querySelector('.cc-mode.active') ? shadow.querySelector('.cc-mode.active').getAttribute('data-view') : 'generate'
    };
    Object.keys(extra || {}).forEach(function(key) {
      panel[key] = extra[key];
    });
    safeMsg({
      type: 'UPSERT_PANEL_STATE',
      payload: {
        sessionId: currentSession && currentSession.id,
        pageUrl: window.location.href,
        panel: panel
      }
    });
  }

  function ensureScrape() {
    var rawText = scrapePage();
    var rawEl = $id('cc-raw-text');
    if (rawEl) rawEl.value = rawText;
    return rawText;
  }

	  function saveDisplaySettings() {
	    renderModelHealth();
	    syncSet({
	      model: $id('cc-model-select').value,
	      coverLetterType: $id('cc-style-select').value,
	      resumeFormat: ($id('cc-resume-format') && $id('cc-resume-format').value) || 'auto'
	    });
	  }

  function refreshContext(callback, feedbackButtonId, includeResearch, forceNewSession) {
    var rawText = ensureScrape();
    var inferred = inferIdentityHints();
    var manualHints = currentManualHints();
    var feedbackId = feedbackButtonId || 'cc-scrape-btn';
    var feedbackButton = $id(feedbackId);
    if (!rawText) {
      if (feedbackId === 'cc-scrape-btn') flashSmallButton(feedbackId, 'No Job Text', 2200);
      else flashButtonState(feedbackId, 'No Job Text', 'error', 2200);
      return;
    }
    if (feedbackButton) {
      if (feedbackId === 'cc-scrape-btn') {
        feedbackButton.disabled = true;
        feedbackButton.setAttribute('data-state', 'loading');
        feedbackButton.textContent = 'Refreshing…';
      } else {
        setButtonState(feedbackId, { label: 'Refreshing Context', progress: 18, kind: 'loading', disabled: true });
      }
    }
    safeMsg({
      type: 'REFRESH_SESSION_CONTEXT',
      payload: {
        pageUrl: window.location.href,
        rawPageText: rawText,
        pageTitle: inferred.pageTitle,
        titleHint: manualHints.titleHint,
        companyHint: manualHints.companyHint,
        coverLetterType: $id('cc-style-select').value,
        model: $id('cc-model-select').value,
        includeResearch: !!includeResearch,
        forceNewSession: !!forceNewSession,
        refreshNonce: forceNewSession ? String(Date.now()) : ''
      }
    }, function(response) {
      if (feedbackButton && $id(feedbackId)) {
        if (feedbackId === 'cc-scrape-btn') {
          feedbackButton.disabled = false;
          feedbackButton.removeAttribute('data-state');
          feedbackButton.textContent = 'Scrape';
        }
      }
      if (!ctxOk() || chrome.runtime.lastError) {
        if (feedbackId === 'cc-scrape-btn') flashSmallButton(feedbackId, 'Connection Failed', 2200);
        else flashButtonState(feedbackId, 'Connection Failed', 'error', 2400);
        return;
      }
      if (!response || response.error) {
        var refreshLabel = shortFailureLabel(response && response.error, 'Refresh Failed');
        if (feedbackId === 'cc-scrape-btn') flashSmallButton(feedbackId, refreshLabel, 2200);
        else flashButtonState(feedbackId, refreshLabel, 'error', 2400);
        return;
      }
      hydrateSession(response.session);
      if (forceNewSession) {
        hideOutput();
        hideAnswer();
        hideResumeDraft();
      }
      if (typeof callback === 'function') callback(response.session);
    });
  }

  function autoPopulateJobIdentity() {
    var needsIdentity = !currentSession || !currentSession.job || !currentSession.job.jobTitle || !currentSession.job.companyName;
    if (!needsIdentity) return;
    refreshContext(function(responseSession) {
      if (responseSession) hydrateSession(responseSession);
    }, 'cc-scrape-btn');
  }

  function runGenerate() {
    var rawText = ensureScrape();
    var inferred = inferIdentityHints();
    var manualHints = currentManualHints();
    if (!rawText) {
      completeGenerateProgress(false, 'No Job Text', 'CoverCraft could not find usable job text on this page. Open a job posting, wait for it to finish loading, then click Scrape and try again.');
      return;
    }

    function sendPipeline() {
      safeMsg({
        type: 'RUN_PIPELINE',
        payload: {
          pageUrl: window.location.href,
          rawPageText: rawText,
          pageTitle: inferred.pageTitle,
          titleHint: manualHints.titleHint,
          companyHint: manualHints.companyHint,
          coverLetterType: $id('cc-style-select').value,
          model: $id('cc-model-select').value,
          sessionId: currentSession && currentSession.id || ''
        }
      }, function(response) {
        if (!ctxOk() || chrome.runtime.lastError) {
          completeGenerateProgress(false, 'Connection Failed');
          return;
        }
        if (!response || response.error) {
          refreshModelHealth();
          completeGenerateProgress(false, shortFailureLabel(response && response.error, 'Generation Failed'), response && response.error);
          return;
        }
        currentOwner = response.owner || currentOwner;
        hydrateSession(response.session);
        revealOutput(response.coverLetter || '');
        refreshModelHealth();
        completeGenerateProgress(true, 'Cover Letter Ready');
      });
    }

    function hasJobIdentity() {
      return !!(($id('cc-title-hint').value || '').trim() && ($id('cc-company-hint').value || '').trim());
    }

    withRuntimeValidation('generate', setGenerateStatus, 'cc-generate-btn', function() {
      saveDisplaySettings();
      startGenerateProgress();
      if (hasJobIdentity()) {
        sendPipeline();
        return;
      }

      safeMsg({
        type: 'REFRESH_SESSION_CONTEXT',
        payload: {
          pageUrl: window.location.href,
          rawPageText: rawText,
          pageTitle: inferred.pageTitle,
          titleHint: manualHints.titleHint,
          companyHint: manualHints.companyHint,
          coverLetterType: $id('cc-style-select').value,
          model: $id('cc-model-select').value,
          sessionId: currentSession && currentSession.id || ''
        }
      }, function(response) {
        if (!ctxOk() || chrome.runtime.lastError) {
          completeGenerateProgress(false, 'Connection Failed');
          return;
        }
        if (!response || response.error) {
          refreshModelHealth();
          completeGenerateProgress(false, shortFailureLabel(response && response.error, 'Refresh Failed'), response && response.error);
          return;
        }
        hydrateSession(response.session);
        if (!hasJobIdentity()) {
          completeGenerateProgress(false, 'Need Job Details', 'Add or correct the job title and company fields, then try again.');
          return;
        }
        sendPipeline();
      });
    });
  }

  function runManualCoverLetter() {
    var text = ($id('cc-manual-text') && $id('cc-manual-text').value || '').trim();
    var rawText = ensureScrape();
    var inferred = inferIdentityHints();
    if (!text) {
      completeManualProgress(false, 'Paste Letter Text', 'Paste or write the full cover letter before creating the manual artifact.');
      return;
    }
    if (text.split(/\s+/).filter(Boolean).length < 40) {
      completeManualProgress(false, 'Too Short', 'Manual cover letter looks too short. Paste the full letter text before saving.');
      return;
    }

    var titleHint = ($id('cc-title-hint').value || '').trim() || inferred.titleHint;
    var companyHint = ($id('cc-company-hint').value || '').trim() || inferred.companyHint;
    resetActionButton('cc-manual-save-btn');
    setManualStatus('loading', 'Saving manual cover letter to this session. No AI request is being made.');
    setButtonState('cc-manual-save-btn', { label: 'Saving Manual Letter', progress: 45, kind: 'loading', disabled: true });

    safeMsg({
      type: 'SAVE_MANUAL_COVER_LETTER',
      payload: {
        pageUrl: window.location.href,
        rawPageText: rawText,
        pageTitle: inferred.pageTitle,
        titleHint: titleHint,
        companyHint: companyHint,
        coverLetterText: text
      }
    }, function(response) {
      if (!ctxOk() || chrome.runtime.lastError) {
        completeManualProgress(false, 'Connection Failed');
        return;
      }
      if (!response || response.error) {
        completeManualProgress(false, shortFailureLabel(response && response.error, 'Save Failed'), response && response.error);
        return;
      }
      currentOwner = response.owner || currentOwner;
      hydrateSession(response.session);
      if ($id('cc-manual-text')) $id('cc-manual-text').value = response.coverLetter || text;
      refreshManualActions();
      completeManualProgress(true, 'Manual Letter Ready');
      var artifact = response.artifact || getCurrentOutputArtifact();
      var payload = CoverCraftPdf.buildCoverLetterPdfDownload({
        text: response.coverLetter || text,
        jobTitle: ($id('cc-title-hint').value || (artifact && artifact.jobTitle) || 'Cover Letter'),
        company: ($id('cc-company-hint').value || (artifact && artifact.company) || ''),
        owner: currentOwner || (artifact && artifact.owner) || {}
      });
      if (!payload) return;
      safeMsg({
        type: 'DOWNLOAD_PDF_DATA_URL',
        payload: {
          dataUrl: payload.dataUrl,
          fileName: payload.fileName
        }
      });
    });
  }

  function runAsk() {
    var question = ($id('cc-question').value || '').trim();
    if (!question) {
      setAskStatus('error', 'Enter a question before asking CoverCraft to answer.');
      flashButtonState('cc-ask-btn', 'Enter A Question', 'error', 2000);
      return;
    }

    function sendQuestion() {
      startAskProgress();
      safeMsg({
        type: 'ASK_SESSION_QUESTION',
        payload: {
          sessionId: currentSession && currentSession.id,
          question: question,
          model: $id('cc-model-select').value
        }
      }, function(response) {
        if (!ctxOk() || chrome.runtime.lastError) {
          completeAskProgress(false, 'Connection Failed');
          return;
        }
        if (!response || response.error) {
          refreshModelHealth();
          completeAskProgress(false, shortFailureLabel(response && response.error, 'Answer Failed'), response && response.error);
          return;
        }
        hydrateSession(response.session);
        revealAnswer(response.answer || '');
        refreshModelHealth();
        switchView('ask');
        completeAskProgress(true, 'Answer Ready');
      });
    }

    withRuntimeValidation('ask', setAskStatus, 'cc-ask-btn', function() {
      if (!currentSession || !currentSession.id) {
        refreshContext(function() {
          sendQuestion();
        }, 'cc-ask-btn');
        return;
      }
      sendQuestion();
    });
  }

  function runResume() {
    var rawText = ensureScrape();
    var inferred = inferIdentityHints();
    var manualHints = currentManualHints();
    if (!rawText) {
      setResumeStatus('error', 'CoverCraft could not find usable job text on this page yet.');
      completeResumeProgress(false, 'No Job Text');
      return;
    }
    if (!currentPortfolio || !Core.normalizePortfolio(currentPortfolio).normalized.name) {
      setResumeStatus('error', 'Add or import your active profile first, then return to Resume mode.');
      completeResumeProgress(false, 'Need Profile');
      return;
    }

    function sendResumeRequest() {
      setButtonState('cc-resume-btn', { label: 'Step 2 · Waiting For Pipeline', progress: 54, kind: 'loading', disabled: true });
      safeMsg({
        type: 'RUN_RESUME_PIPELINE',
        payload: {
          pageUrl: window.location.href,
          rawPageText: rawText,
          pageTitle: inferred.pageTitle,
	          titleHint: manualHints.titleHint,
	          companyHint: manualHints.companyHint,
	          model: $id('cc-model-select').value,
	          resumeFormat: ($id('cc-resume-format') && $id('cc-resume-format').value) || 'auto'
	        }
      }, function(response) {
        if (!ctxOk() || chrome.runtime.lastError) {
          setResumeStatus('error', 'Could not reach the resume pipeline.');
          completeResumeProgress(false, 'Connection Failed');
          return;
        }
        if (!response) {
          setResumeStatus('error', 'Resume mode is ready in the panel, but the tailoring backend is not connected yet. Use Dashboard → Settings → Resume Import for now.');
          completeResumeProgress(false, 'Resume Unavailable');
          return;
        }
        if (response.error) {
          refreshModelHealth();
          setResumeStatus('error', response.error);
          completeResumeProgress(false, shortFailureLabel(response.error, 'Resume Failed'));
          return;
        }
        if (response.session) hydrateSession(response.session);
        var artifact = response.resume || null;
        var latexText = (artifact && artifact.latexSource) ||
          response.resumeLatex ||
          response.latexSource || '';
        if (latexText) {
          revealResumeDraft(latexText);
          refreshModelHealth();
          setResumeStatus('ok', formatResumeCompletionStatus(artifact));
          completeResumeProgress(true, 'LaTeX Ready');
          switchView('resume');
          return;
        }
        setResumeStatus('error', 'The resume pipeline returned no usable LaTeX.');
        completeResumeProgress(false, 'No LaTeX');
      });
    }

    withRuntimeValidation('resume', setResumeStatus, 'cc-resume-btn', function() {
      saveDisplaySettings();
      startResumeProgress();
      if (($id('cc-title-hint').value || '').trim() && ($id('cc-company-hint').value || '').trim()) {
        sendResumeRequest();
        return;
      }
      refreshContext(function() {
        sendResumeRequest();
      }, 'cc-resume-btn');
    });
  }

  function bindEvents() {
    bindShadow('cc-close-btn', 'click', function() {
      stopSessionProgressPolling();
      safeMsg({
        type: 'UPSERT_PANEL_STATE',
        payload: {
          sessionId: currentSession && currentSession.id,
          pageUrl: window.location.href,
          panel: { open: false }
        }
      });
      if (host) host.remove();
      host = null;
      shadow = null;
      injected = false;
    });

    bindShadow('cc-min-btn', 'click', function() {
      if (!host) return;
      var minimized = host.classList.contains('cc-minimized');
      if (minimized) {
        host.classList.remove('cc-minimized');
        setMinimizedControls(false);
        window.requestAnimationFrame(function() {
          placeExpandedPanel(true);
        });
        persistPanelState({ minimized: false });
        return;
      }

      host.classList.add('cc-minimized');
      setMinimizedControls(true);
      window.requestAnimationFrame(placeMinimizedPanel);
      persistPanelState({ minimized: true });
    });

    bindShadow('cc-header', 'click', function(event) {
      if (!host || !host.classList.contains('cc-minimized')) return;
      if (event.target && event.target.closest('button')) return;
      var button = $id('cc-min-btn');
      if (button) button.click();
    });

    shadow.querySelectorAll('.cc-mode').forEach(function(button) {
      button.addEventListener('click', function() {
        switchView(button.getAttribute('data-view'));
      });
    });

    shadow.querySelectorAll('.cc-primary-mode').forEach(function(button) {
      button.addEventListener('click', function() {
        var mode = button.getAttribute('data-primary-mode');
        switchView(mode === 'manual' ? 'manual' : (lastAiView || 'generate'));
      });
    });

    bindShadow('cc-scrape-btn', 'click', function() {
      refreshModelHealth();
      refreshContext(null, 'cc-scrape-btn', false, true);
    });
    bindShadow('cc-settings-btn', 'click', function() { safeMsg({ type: 'OPEN_SETTINGS' }); });
    bindShadow('cc-model-health-refresh-btn', 'click', refreshModelHealthFromHeader);
    bindShadow('cc-generate-btn', 'click', runGenerate);
    bindShadow('cc-manual-save-btn', 'click', runManualCoverLetter);
    bindShadow('cc-ask-btn', 'click', runAsk);
    bindShadow('cc-resume-btn', 'click', runResume);
	  bindShadow('cc-model-select', 'change', saveDisplaySettings);
	  bindShadow('cc-style-select', 'change', saveDisplaySettings);
	  bindShadow('cc-resume-format', 'change', saveDisplaySettings);
    bindShadow('cc-title-hint', 'input', function() { titleHintDirty = true; });
    bindShadow('cc-company-hint', 'input', function() { companyHintDirty = true; });
    bindShadow('cc-output', 'input', refreshOutputActions);
    bindShadow('cc-manual-text', 'input', refreshManualActions);

    bindShadow('cc-copy-btn', 'click', function() {
      var text = ($id('cc-output').value || '').trim();
      if (!text) return;
      navigator.clipboard.writeText(text).then(function() {
        var button = $id('cc-copy-btn');
        var original = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(function() {
          if ($id('cc-copy-btn') === button) button.textContent = original;
        }, 1400);
      });
    });

    bindShadow('cc-copy-answer-btn', 'click', function() {
      var text = ($id('cc-answer').value || '').trim();
      if (!text) return;
      navigator.clipboard.writeText(text).then(function() {
        var button = $id('cc-copy-answer-btn');
        var original = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(function() {
          if ($id('cc-copy-answer-btn') === button) button.textContent = original;
        }, 1400);
      });
    });

    bindShadow('cc-copy-resume-latex-btn', 'click', function() {
      var artifact = getCurrentResumeArtifact();
      var button = $id('cc-copy-resume-latex-btn');
      if (!artifact || !artifact.latexSource) {
        if (button) button.textContent = 'LaTeX Missing';
        window.setTimeout(function() {
          if ($id('cc-copy-resume-latex-btn') === button) button.textContent = '⎘ Copy LaTeX';
        }, 1800);
        return;
      }
      navigator.clipboard.writeText(artifact.latexSource).then(function() {
        if (!button) return;
        var original = button.textContent;
        button.textContent = 'Copied';
        window.setTimeout(function() {
          if ($id('cc-copy-resume-latex-btn') === button) button.textContent = original;
        }, 1500);
      });
    });

    bindShadow('cc-resume-tex-btn', 'click', function() {
      var artifact = getCurrentResumeArtifact();
      var button = $id('cc-resume-tex-btn');
      if (!artifact || !artifact.latexSource) {
        if (button) button.textContent = 'LaTeX Missing';
        window.setTimeout(function() {
          if ($id('cc-resume-tex-btn') === button) button.textContent = '⬇ Download LaTeX';
        }, 1800);
        return;
      }
      var fileName = ((artifact.jobTitle || ($id('cc-title-hint').value || 'Resume')) + ((artifact.company || ($id('cc-company-hint').value || '')) ? '_' + (artifact.company || ($id('cc-company-hint').value || '')) : '') + '_Resume.tex')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .replace(/_+/g, '_');
      safeMsg({
        type: 'DOWNLOAD_TEXT_FILE',
        payload: {
          text: artifact.latexSource,
          fileName: fileName,
          mimeType: 'text/x-tex'
        }
      }, function(response) {
        if (!button) return;
        if (!response || response.error) {
          var previous = button.textContent;
          button.textContent = 'Download Failed';
          window.setTimeout(function() {
            if ($id('cc-resume-tex-btn') === button) button.textContent = previous;
          }, 2600);
          return;
        }
        var original = button.textContent;
        button.textContent = 'Downloaded';
        window.setTimeout(function() {
          if ($id('cc-resume-tex-btn') === button) button.textContent = original;
        }, 1600);
      });
    });

    bindShadow('cc-pdf-btn', 'click', function() {
      var artifact = getCurrentOutputArtifact();
      var text = ($id('cc-output').value || '').trim();
      var payload = CoverCraftPdf.buildCoverLetterPdfDownload({
        text: text,
        jobTitle: ($id('cc-title-hint').value || (artifact && artifact.jobTitle) || 'Cover Letter'),
        company: ($id('cc-company-hint').value || ''),
        owner: currentOwner || (artifact && artifact.owner) || {}
      });
      var button = $id('cc-pdf-btn');
      if (!payload) {
        if (button) button.textContent = 'PDF Error';
        window.setTimeout(function() {
          if ($id('cc-pdf-btn') === button) button.textContent = '⬇ Download PDF';
        }, 1800);
        return;
      }
      safeMsg({
        type: 'DOWNLOAD_PDF_DATA_URL',
        payload: {
          dataUrl: payload.dataUrl,
          fileName: payload.fileName
        }
      }, function(response) {
        if (!button) return;
        if (!response || response.error) {
          var previous = button.textContent;
          button.textContent = response && response.error ? 'PDF Error' : 'Download Failed';
          window.setTimeout(function() {
            if ($id('cc-pdf-btn') === button) button.textContent = previous;
          }, 2200);
          return;
        }
        var original = button.textContent;
        button.textContent = 'Downloaded';
        window.setTimeout(function() {
          if ($id('cc-pdf-btn') === button) button.textContent = original;
        }, 1600);
      });
    });

    bindShadow('cc-foot-dash', 'click', function() {
      safeMsg({ type: 'OPEN_DASHBOARD' });
    });

    bindShadow('cc-foot-profile', 'click', function() {
      safeMsg({ type: 'OPEN_PROFILE' });
    });
  }

  function injectPanel(restoredSession, freshOpen) {
    if (injected) return;
    injected = true;

    host = document.createElement('div');
    host.id = 'covercraft-root';
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647';
    document.body.appendChild(host);

    shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(buildStyles());
    var wrapper = document.createElement('div');
    wrapper.innerHTML = getPanelHTML();
    shadow.appendChild(wrapper.firstChild);

    bindEvents();
    window.addEventListener('resize', function() {
      if (!host) return;
      if (host.classList.contains('cc-minimized')) {
        placeMinimizedPanel();
        return;
      }
      placeExpandedPanel(true);
    });

    safeMsg({ type: 'GET_SETTINGS' }, function(response) {
      currentSettings = response && response.settings || null;
      currentOwner = response && response.portfolio && response.portfolio.owner || currentOwner;
      currentCloud = response && response.cloud || null;
      currentModelHealth = response && response.modelHealth || {};
	      if ($id('cc-model-select') && currentSettings && currentSettings.model) $id('cc-model-select').value = currentSettings.model;
	      if ($id('cc-style-select') && currentSettings && currentSettings.coverLetterType) $id('cc-style-select').value = currentSettings.coverLetterType;
	      if ($id('cc-resume-format') && currentSettings && currentSettings.resumeFormat) $id('cc-resume-format').value = currentSettings.resumeFormat;
      renderModelHealth();
      renderFooterProfile();
      renderResumeSummary();
    });
    loadPortfolioSnapshot();

    if (freshOpen) {
      if (host) host.classList.remove('cc-minimized');
      setMinimizedControls(false);
      hydrateFreshOpenSession(restoredSession);
      window.requestAnimationFrame(function() {
        placeExpandedPanel(true);
      });
      persistPanelState({ minimized: false, activeView: 'generate', open: true });
    } else if (restoredSession) {
      hydrateSession(restoredSession);
      if (restoredSession.panel && restoredSession.panel.minimized) {
        if (host) host.classList.add('cc-minimized');
        setMinimizedControls(true);
        window.requestAnimationFrame(placeMinimizedPanel);
      } else {
        window.requestAnimationFrame(function() {
          placeExpandedPanel(true);
        });
      }
    } else {
      ensureScrape();
      hideOutput();
      hideAnswer();
      window.requestAnimationFrame(function() {
        placeExpandedPanel(true);
      });
    }

    window.setTimeout(function() {
      autoPopulateJobIdentity();
    }, 120);

    persistPanelState();
  }

  function maybeAutoInject() {
    safeMsg({
      type: 'GET_PAGE_SESSION',
      payload: { pageUrl: window.location.href }
    }, function(response) {
      if (!ctxOk() || chrome.runtime.lastError) return;
      var restoredSession = response && response.session || null;
      syncGet(['triggerMode'], function(syncData) {
        var triggerMode = syncData.triggerMode || 'manual';
        if (restoredSession && restoredSession.panel && restoredSession.panel.open) {
          injectPanel(restoredSession);
          return;
        }
        if (detectNorthstarDemoPage()) {
          injectPanel(restoredSession);
          return;
        }
        if (triggerMode !== 'auto_simplify') return;
        if (detectSimplify()) {
          injectPanel(restoredSession);
          return;
        }
        triggerObserver = new MutationObserver(function() {
          if (detectSimplify()) {
            triggerObserver.disconnect();
            triggerObserver = null;
            injectPanel(restoredSession);
          }
        });
        if (document.body) {
          triggerObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['id', 'class'] });
        }
      });
    });
  }

  document.addEventListener('covercraft:open', function() {
    if (injected) return;
    safeMsg({
      type: 'GET_PAGE_SESSION',
      payload: { pageUrl: window.location.href }
    }, function(response) {
      injectPanel(response && response.session || null, true);
    });
  });

  try {
    chrome.runtime.onMessage.addListener(function(message) {
      if (!message || message.type !== 'MODEL_HEALTH_UPDATE') return;
      currentModelHealth = message.modelHealth || {};
      renderModelHealth();
    });
  } catch (_) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoInject);
  } else {
    maybeAutoInject();
  }
})();
