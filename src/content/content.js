// CoverCraft Content Script v2
(function () {
  'use strict';

  var injected = false;

  // ─── Simplify detection ─────────────────────────────────────────────────────
  var SIMPLIFY_SELECTORS = [
    '#simplify-app', '.simplify-app', '[data-simplify]', 'simplify-app',
    '#simplify-extension-root', '.simplify-sidebar', '[class*="simplify-"]',
    'iframe[src*="simplify"]'
  ];

  function detectSimplify() {
    for (var i = 0; i < SIMPLIFY_SELECTORS.length; i++) {
      if (document.querySelector(SIMPLIFY_SELECTORS[i])) return true;
    }
    var all = document.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (el.tagName && el.tagName.toLowerCase().includes('simplify')) return true;
      if (el.shadowRoot) {
        for (var k = 0; k < SIMPLIFY_SELECTORS.length; k++) {
          if (el.shadowRoot.querySelector(SIMPLIFY_SELECTORS[k])) return true;
        }
      }
    }
    return false;
  }

  // ─── Page scraping ──────────────────────────────────────────────────────────
  function scrapePage() {
    var clone = document.body.cloneNode(true);

    // Remove noisy elements
    ['script','style','noscript','nav','footer','header','aside','iframe','form'].forEach(function(tag) {
      clone.querySelectorAll(tag).forEach(function(el) { el.remove(); });
    });
    clone.querySelectorAll('[aria-hidden="true"],[hidden]').forEach(function(el) { el.remove(); });

    var text = (clone.innerText || clone.textContent || '')
      .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();

    // Cut at application form start
    var formStarts = [
      /\n(first name|last name|full name|legal name)\s*[\n*:]/i,
      /\n(email address|email\s*[*:\n]|phone number|phone\s*[*:\n])/i,
      /\n(upload resume|attach resume|upload cv|drop.*resume|drag.*resume)/i,
      /\n(linkedin url|linkedin profile|portfolio url)\s*[\n*:]/i,
      /\nstep\s*1\s*(of|\/)\s*\d/i,
      /\n(submit application|submit your application)\s*\n/i,
      /\napplication form\s*\n/i
    ];
    var cut = text.length;
    formStarts.forEach(function(p) {
      var m = text.search(p);
      if (m !== -1 && m < cut) cut = m;
    });
    text = text.slice(0, cut);

    // Strip EEO / compliance noise from anywhere in remaining text
    var eeoPatterns = [
      /\n(voluntary self.?identification|self.?identification of disability)/i,
      /\n(equal employment opportunity|equal opportunity employer|eeo statement)/i,
      /\n(disability status|are you a protected veteran)/i,
      /\n(we are committed to|our commitment to) (diversity|equal|inclusion)/i,
      /\npowered by (lever|greenhouse|ashby|workday|icims|taleo)/i,
      /\n(privacy policy|cookie policy|terms of service)\s*[\n|]/i,
      /\n(share this job|refer a friend|set up job alert)/i,
      /\n(similar jobs|related jobs|you might also like)/i
    ];
    eeoPatterns.forEach(function(p) {
      var m = text.search(p);
      if (m !== -1) text = text.slice(0, m);
    });

    return text.trim().slice(0, 12000);
  }

  // ─── Panel HTML ─────────────────────────────────────────────────────────────
  function getPanelHTML() {
    return [
      '<div id="cc-panel">',

        '<div id="cc-header">',
          '<div id="cc-title"><span class="cc-star">✦</span> CoverCraft <span class="cc-sub">your cover letter AI</span></div>',
          '<div id="cc-header-btns">',
            '<button id="cc-min-btn" title="Minimize">−</button>',
            '<button id="cc-close-btn" title="Close">✕</button>',
          '</div>',
        '</div>',

        '<div id="cc-body">',

          // Hidden scrape store
          '<textarea id="cc-raw-text" style="display:none"></textarea>',

          // Scrape bar
          '<div class="cc-scrape-bar">',
            '<span id="cc-scrape-info" class="cc-scrape-info">Scanning page...</span>',
            '<button id="cc-rescrape-btn" class="cc-sm-btn">↺ Rescrape</button>',
          '</div>',

          // Title + company hints
          '<div class="cc-row2">',
            '<div class="cc-field">',
              '<label class="cc-lbl">Job Title</label>',
              '<input type="text" id="cc-title-hint" class="cc-input" placeholder="Auto-detecting..." />',
            '</div>',
            '<div class="cc-field">',
              '<label class="cc-lbl">Company</label>',
              '<input type="text" id="cc-company-hint" class="cc-input" placeholder="Auto-detecting..." />',
            '</div>',
          '</div>',

          // Output section (shown after generation)
          '<div id="cc-output-wrap" style="display:none">',
            '<label class="cc-lbl">Your Cover Letter</label>',
            '<textarea id="cc-output" class="cc-output" rows="12" readonly></textarea>',
            '<div class="cc-action-row">',
            '<button id="cc-copy-btn" class="cc-sm-btn cc-copy-btn">⎘ Copy</button>',
            '<button id="cc-pdf-btn" class="cc-sm-btn" style="flex:1;text-align:center;background:rgba(16,185,129,0.1);border-color:rgba(16,185,129,0.2);color:#34d399">⬇ Download PDF</button>',
          '</div>',
          '</div>',

          // Model + style always visible above generate button
          '<div class="cc-field">',
            '<label class="cc-lbl">AI Model</label>',
            '<select id="cc-model-select" class="cc-select">',
              '<option value="openrouter/free">Free (Gemini Flash / DeepSeek — no cost)</option>',
              '<option value="arcee-ai/trinity-large-preview:free" selected>Arcee Trinity Large (free — fast, great writing)</option>',
              '<option value="openrouter/auto">Auto (best model — may cost)</option>',
              '<option value="google/gemini-2.0-flash-001">Gemini 2.0 Flash (free)</option>',
              '<option value="deepseek/deepseek-r1:free">DeepSeek R1 (free)</option>',
              '<option value="anthropic/claude-3-haiku">Claude 3 Haiku (paid)</option>',
            '</select>',
          '</div>',

          '<div class="cc-field">',
            '<label class="cc-lbl">Cover Letter Style</label>',
            '<select id="cc-style-select" class="cc-select">',
              '<option value="formal">Formal & Polished</option>',
              '<option value="storytelling">Story-Driven</option>',
              '<option value="achievement">Achievement-Led</option>',
              '<option value="concise">Concise & Punchy</option>',
              '<option value="startup">Startup Energy</option>',
            '</select>',
          '</div>',

          // Status + generate button
          '<div id="cc-status" class="cc-status"></div>',
          '<button id="cc-generate-btn" class="cc-btn-primary" disabled>Generate Cover Letter</button>',

        '<div id="cc-footer">',
          '<button class="cc-foot-btn" id="cc-foot-dash">📊 Dashboard</button>',
          '<button class="cc-foot-btn" id="cc-foot-settings">⚙ Settings</button>',
        '</div>',

      '</div>'
    ].join('');
  }

  // ─── Panel styles ───────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('cc-styles')) return;
    var s = document.createElement('style');
    s.id = 'cc-styles';
    s.textContent = [
      '#covercraft-root{position:fixed;bottom:20px;right:20px;z-index:2147483647;font-family:"Segoe UI",system-ui,sans-serif;font-size:13px}',
      '#cc-panel{width:380px;background:#0d0d18;border:1px solid #2a2a42;border-radius:14px;box-shadow:0 8px 40px rgba(0,0,0,0.6);overflow:hidden;display:flex;flex-direction:column}',
      '#cc-header{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;background:#11111e;border-bottom:1px solid #1e1e30}',
      '#cc-title{display:flex;align-items:center;gap:6px;font-weight:700;font-size:14px;color:#fff}',
      '.cc-star{color:#818cf8}.cc-sub{color:#475569;font-size:11px;font-weight:400}',
      '#cc-header-btns{display:flex;gap:5px}',
      '#cc-header-btns button{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:5px;color:#94a3b8;width:22px;height:22px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;padding:0;line-height:1}',
      '#cc-header-btns button:hover{background:rgba(255,255,255,0.12);color:#e2e8f0}',
      '#cc-body{padding:14px;display:flex;flex-direction:column;gap:10px;max-height:75vh;overflow-y:auto;overflow-x:hidden;scrollbar-width:none}',
      '#cc-body::-webkit-scrollbar{display:none}',
      '.cc-scrape-bar{display:flex;align-items:center;justify-content:space-between;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.15);border-radius:7px;padding:6px 10px}',
      '.cc-scrape-info{font-size:11px;color:#818cf8;font-weight:600}',
      '.cc-sm-btn{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:5px;color:#94a3b8;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap}',
      '.cc-sm-btn:hover{background:rgba(255,255,255,0.1);color:#e2e8f0}',
      '.cc-copy-btn,.cc-pdf-btn-inner{flex:1;text-align:center}',
      '.cc-row2{display:flex;flex-direction:column;gap:8px;width:100%}',
      '.cc-field{display:flex;flex-direction:column;gap:4px;min-width:0;overflow:hidden}',
      '.cc-lbl{font-size:10.5px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.05em}',
      '.cc-input,.cc-select{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:7px;color:#e2e8f0;padding:7px 10px;font-size:12px;font-family:inherit;outline:none;width:100%;max-width:100%;box-sizing:border-box;min-width:0;transition:border-color .15s}',
      '.cc-input:focus,.cc-select:focus{border-color:rgba(99,102,241,0.5)}',
      '.cc-select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'10\' viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'%236366f1\' stroke-width=\'2.5\'%3E%3Cpath d=\'m6 9 6 6 6-6\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:28px;cursor:pointer}',
      '.cc-select option{background:#0d0d18}',
      '.cc-status{font-size:12px;min-height:16px;color:#64748b;padding:2px 0}',
      '.cc-status.loading{color:#818cf8}.cc-status.error{color:#f87171}.cc-status.success{color:#34d399}',
      '.cc-btn-primary{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;border:none;border-radius:8px;padding:10px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s;width:100%}',
      '.cc-btn-primary:hover:not(:disabled){box-shadow:0 4px 20px rgba(99,102,241,0.4);transform:translateY(-1px)}',
      '.cc-btn-primary:disabled{opacity:0.45;cursor:not-allowed}',
      '#cc-output-wrap{display:flex;flex-direction:column;gap:6px}',
      '.cc-action-row{display:flex;gap:6px}',
      '.cc-output{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:7px;color:#cbd5e1;padding:10px;font-size:12px;font-family:inherit;resize:vertical;line-height:1.6;width:100%;max-width:100%;box-sizing:border-box}',
      '#cc-footer{display:flex;gap:6px;padding:10px 14px;border-top:1px solid #1e1e30;background:#11111e}',
      '.cc-foot-btn{flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:6px;color:#475569;font-size:10px;font-weight:600;cursor:pointer;padding:6px 4px;font-family:inherit;text-align:center;transition:all .13s}',
      '.cc-foot-btn:hover{background:rgba(99,102,241,0.1);border-color:rgba(99,102,241,0.2);color:#818cf8}'
    ].join('\n');
    document.head.appendChild(s);
  }

  // ─── Status helper ──────────────────────────────────────────────────────────
  function setStatus(msg, type) {
    var el = document.getElementById('cc-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'cc-status' + (type ? ' ' + type : '');
    if (type === 'success') setTimeout(function() { el.textContent = ''; el.className = 'cc-status'; }, 3500);
  }

  // ─── Panel injection ─────────────────────────────────────────────────────────
  function injectPanel() {
    if (injected) return;
    injected = true;

    injectStyles();

    var root = document.createElement('div');
    root.id = 'covercraft-root';
    root.innerHTML = getPanelHTML();
    document.body.appendChild(root);

    chrome.runtime.sendMessage({ type: 'SIMPLIFY_DETECTED' });

    // Load saved model preference
    chrome.storage.sync.get(['model','coverLetterType'], function(d) {
      var modelSel = document.getElementById('cc-model-select');
      var styleSel = document.getElementById('cc-style-select');
      if (modelSel && d.model) modelSel.value = d.model;
      if (styleSel && d.coverLetterType) styleSel.value = d.coverLetterType;
    });

    // Bind all events immediately so Generate button always works
    bindEvents();

    // Then scrape + auto-extract in background
    setTimeout(function() { doScrapeAndExtract(); }, 700);
  }

  function doScrapeAndExtract() {
    var rawText = scrapePage();
    var rawEl   = document.getElementById('cc-raw-text');
    if (rawEl) rawEl.value = rawText;

    var words = rawText.trim().split(/\s+/).length;
    setInfo(words + ' words scraped');

    // Enable generate button now that we have text
    var genBtn = document.getElementById('cc-generate-btn');
    if (genBtn) genBtn.disabled = false;

    if (!rawText) {
      setStatus('No page text found — enter hints manually.', '');
      return;
    }

    setStatus('Detecting job title & company...', 'loading');
    chrome.runtime.sendMessage(
      { type: 'EXTRACT_JOB_INFO', payload: { rawPageText: rawText, pageUrl: window.location.href } },
      function(resp) {
        if (chrome.runtime.lastError) {
          setStatus('Ready — enter hints manually.', '');
          return;
        }
        resp = resp || {};
        var titleEl   = document.getElementById('cc-title-hint');
        var companyEl = document.getElementById('cc-company-hint');
        if (titleEl   && resp.jobTitle)    titleEl.value   = resp.jobTitle;
        if (companyEl && resp.companyName) companyEl.value = resp.companyName;

        var label = (resp.jobTitle && resp.companyName)
          ? resp.jobTitle + ' @ ' + resp.companyName + ' · ' + words + ' words'
          : words + ' words scraped';
        setInfo(label);
        setStatus('Ready! Edit hints if needed, then generate.', 'success');
      }
    );
  }

  function setInfo(text) {
    var el = document.getElementById('cc-scrape-info');
    if (el) el.textContent = text;
  }

  // ─── Event bindings ─────────────────────────────────────────────────────────
  function bindEvents() {

    // Close
    document.getElementById('cc-close-btn').addEventListener('click', function() {
      var root = document.getElementById('covercraft-root');
      if (root) { root.remove(); injected = false; }
    });

    // Minimize
    document.getElementById('cc-min-btn').addEventListener('click', function() {
      var body = document.getElementById('cc-body');
      var btn  = document.getElementById('cc-min-btn');
      if (!body) return;
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      btn.textContent = hidden ? '−' : '+';
    });

    // Rescrape
    document.getElementById('cc-rescrape-btn').addEventListener('click', function() {
      var rawText = scrapePage();
      var rawEl = document.getElementById('cc-raw-text');
      if (rawEl) rawEl.value = rawText;
      var words = rawText.trim().split(/\s+/).length;
      setInfo(words + ' words scraped');
      var genBtn = document.getElementById('cc-generate-btn');
      if (genBtn) genBtn.disabled = !rawText;
      setStatus('Re-scraped. Detecting details...', 'loading');
      chrome.runtime.sendMessage(
        { type: 'EXTRACT_JOB_INFO', payload: { rawPageText: rawText, pageUrl: window.location.href } },
        function(resp) {
          if (chrome.runtime.lastError || !resp) { setStatus('Re-scraped.', ''); return; }
          var titleEl   = document.getElementById('cc-title-hint');
          var companyEl = document.getElementById('cc-company-hint');
          if (titleEl   && resp.jobTitle)    titleEl.value   = resp.jobTitle;
          if (companyEl && resp.companyName) companyEl.value = resp.companyName;
          setInfo((resp.jobTitle||'') + (resp.companyName ? ' @ '+resp.companyName : '') + ' · ' + words + ' words');
          setStatus('Re-scraped and extracted.', 'success');
        }
      );
    });

    // Model change — save to sync storage immediately
    document.getElementById('cc-model-select').addEventListener('change', function() {
      var model = this.value;
      chrome.storage.sync.set({ model: model });
      chrome.runtime.sendMessage({ type: 'RELOAD_CONFIG' });
    });

    // Generate
    document.getElementById('cc-generate-btn').addEventListener('click', function() {
      var rawText = (document.getElementById('cc-raw-text') || {}).value || '';
      if (!rawText) { setStatus('No page text — click Rescrape first.', 'error'); return; }

      var btn         = document.getElementById('cc-generate-btn');
      var style       = document.getElementById('cc-style-select').value;
      var model       = document.getElementById('cc-model-select').value;
      var titleHint   = (document.getElementById('cc-title-hint').value || '').trim();
      var companyHint = (document.getElementById('cc-company-hint').value || '').trim();

      btn.disabled = true;
      setStatus('Step 1/3: Extracting job details...', 'loading');

      // Save model preference, then send pipeline directly with model in payload.
      // (background.js uses payload.model immediately — no race with RELOAD_CONFIG)
      chrome.storage.sync.set({ model: model }, function() {
        // Progress status updates
        var t1 = setTimeout(function() { setStatus('Step 2/3: Researching company...', 'loading'); }, 2500);
        var t2 = setTimeout(function() { setStatus('Step 3/3: Writing cover letter...', 'loading'); }, 6000);

        chrome.runtime.sendMessage({
          type: 'RUN_PIPELINE',
          payload: { rawPageText: rawText, coverLetterType: style, model: model, titleHint: titleHint, companyHint: companyHint, pageUrl: window.location.href }
        }, function(resp) {
          clearTimeout(t1); clearTimeout(t2);
          btn.disabled = false;

          if (chrome.runtime.lastError) { setStatus('Connection error — try again.', 'error'); return; }
          if (!resp)                    { setStatus('No response from background.', 'error'); return; }
          if (resp.error)               { setStatus('Error: ' + resp.error, 'error'); return; }

          var outputWrap = document.getElementById('cc-output-wrap');
          var outputEl   = document.getElementById('cc-output');
          if (outputEl) outputEl.value = resp.coverLetter || '';
          if (outputWrap) outputWrap.style.display = 'flex';

          // Update hints from extracted data
          if (resp.extracted) {
            var te = document.getElementById('cc-title-hint');
            var ce = document.getElementById('cc-company-hint');
            if (te && resp.extracted.jobTitle)    te.value = resp.extracted.jobTitle;
            if (ce && resp.extracted.companyName) ce.value = resp.extracted.companyName;
            if (resp.extracted.jobTitle && resp.extracted.companyName) {
              setInfo(resp.extracted.jobTitle + ' @ ' + resp.extracted.companyName);
            }
          }

          setStatus('Done! Cover letter ready.', 'success');
          setTimeout(function() {
            var wrap = document.getElementById('cc-output-wrap');
            if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 100);
        });
      });
    });

    // Copy
    document.getElementById('cc-copy-btn').addEventListener('click', function() {
      var text = (document.getElementById('cc-output') || {}).value;
      if (text) {
        navigator.clipboard.writeText(text).then(function() {
          setStatus('Copied to clipboard!', 'success');
        });
      }
    });

    // Download PDF
    document.getElementById('cc-pdf-btn').addEventListener('click', function() {
      var text = (document.getElementById('cc-output') || {}).value;
      if (!text) { setStatus('Generate a cover letter first.', 'error'); return; }
      var titleHint   = (document.getElementById('cc-title-hint')   || {}).value || 'Cover Letter';
      var companyHint = (document.getElementById('cc-company-hint') || {}).value || '';
      downloadCoverLetterPDF(text, titleHint, companyHint);
    });

    // Footer: Dashboard
    document.getElementById('cc-foot-dash').addEventListener('click', function() {
      chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    });

    // Footer: Settings
    document.getElementById('cc-foot-settings').addEventListener('click', function() {
      chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
    });
  }

  // ─── Direct PDF blob download (no new tab, no print dialog) ─────────────────
  function downloadCoverLetterPDF(text, jobTitle, company) {
    var W = 612, H = 792, mL = 54, mR = 54;
    var textW = W - mL - mR;    // 504pt usable width
    var bodyFS = 12, bodyLH = 19;
    var smallFS = 9;
    var nameFS  = 20;

    // Escape PDF string special chars; strip non-ASCII
    function pe(s) {
      return String(s || '')
        .replace(/\u2014/g, ',').replace(/\u2013/g, '-')
        .replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'")
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    }

    // Times-Roman character advance widths from Adobe AFM (units: 1/1000 em)
    // Most common characters mapped explicitly; everything else falls back.
    var AFM = {
      ' ':250, '!':333, '"':408, '#':500, '$':500, '%':833, '&':778, "'":333,
      '(':333, ')':333, '*':500, '+':564, ',':250, '-':333, '.':250, '/':278,
      '0':500, '1':500, '2':500, '3':500, '4':500, '5':500, '6':500, '7':500,
      '8':500, '9':500, ':':278, ';':278, '<':564, '=':564, '>':564, '?':444,
      '@':921, 'A':722, 'B':667, 'C':667, 'D':722, 'E':611, 'F':556, 'G':722,
      'H':722, 'I':333, 'J':389, 'K':722, 'L':611, 'M':889, 'N':722, 'O':722,
      'P':556, 'Q':722, 'R':667, 'S':556, 'T':611, 'U':722, 'V':722, 'W':944,
      'X':722, 'Y':722, 'Z':611,
      'a':444, 'b':500, 'c':444, 'd':500, 'e':444, 'f':333, 'g':500, 'h':500,
      'i':278, 'j':278, 'k':500, 'l':278, 'm':778, 'n':500, 'o':500, 'p':500,
      'q':500, 'r':333, 's':389, 't':278, 'u':500, 'v':500, 'w':722, 'x':500,
      'y':500, 'z':444
    };
    function charW(c, sz) {
      var u = AFM[c];
      return (u !== undefined ? u : 500) * sz / 1000;
    }
    function tw(s, sz) {
      var w = 0;
      for (var i = 0; i < s.length; i++) w += charW(s[i], sz);
      return w;
    }

    // Word-wrap: 98% safety margin (AFM widths are exact so we only need tiny buffer)
    function wrap(seg, maxW, size) {
      var safeW = maxW * 0.98;
      var words = (seg || '').trim().split(/\s+/), lines = [], cur = '';
      words.forEach(function(w) {
        if (!cur) { cur = w; return; }
        var test = cur + ' ' + w;
        if (tw(test, size) <= safeW) { cur = test; }
        else { lines.push(cur); cur = w; }
      });
      if (cur) lines.push(cur);
      return lines.length ? lines : [''];
    }

    var ops = [], y = H - 50;  // y=742 top of content

    // ── TWO-COLUMN HEADER ────────────────────────────────────────────────────
    // Pull identity from PORTFOLIO so this works for any white-label user
    var ownerName = (typeof PORTFOLIO !== 'undefined' && PORTFOLIO.name) ? PORTFOLIO.name : 'Your Name';
    // Left: name in large bold font
    ops.push('BT /F2 ' + nameFS + ' Tf 1 0 0 1 ' + mL + ' ' + y + ' Tm (' + pe(ownerName) + ') Tj ET');

    // Right: contact info smaller, right-aligned on the same baseline
    var phone = (typeof PORTFOLIO !== 'undefined' && PORTFOLIO.phone)   ? PORTFOLIO.phone   : '';
    var email = (typeof PORTFOLIO !== 'undefined' && PORTFOLIO.email)   ? PORTFOLIO.email   : '';
    var web   = (typeof PORTFOLIO !== 'undefined' && PORTFOLIO.website) ? PORTFOLIO.website : '';
    var sep      = '   |   ';   // wide separator between phone and email
    var sepLast  = '   |';      // no trailing space before the blue website link
    var contactFull = phone + sep + email + sepLast + web;
    var contactBeforeWeb = phone + sep + email + sepLast;
    var fullW  = tw(contactFull, smallFS);
    var preW   = tw(contactBeforeWeb, smallFS);
    var webStrW = tw(web, smallFS);
    var contactStartX = W - mR - fullW;
    // Snap to exact AFM boundary so no sub-pixel drift before the blue segment
    var webStartX = contactStartX + preW;

    // Draw phone + email + separator (black), then website (blue) as one visual line
    ops.push('BT /F1 ' + smallFS + ' Tf 1 0 0 1 ' + contactStartX.toFixed(2) + ' ' + y + ' Tm (' + pe(contactBeforeWeb) + ') Tj ET');
    // Draw website in blue — starts exactly where the black text ended
    ops.push('0 0.35 0.75 rg');
    ops.push('BT /F1 ' + smallFS + ' Tf 1 0 0 1 ' + webStartX.toFixed(2) + ' ' + y + ' Tm (' + pe(web) + ') Tj ET');
    ops.push('0 g');

    // ── Horizontal rule ──────────────────────────────────────────────────────
    var ruleY = y - 12;
    ops.push('0.5 w ' + mL + ' ' + ruleY + ' m ' + (W - mR) + ' ' + ruleY + ' l S');

    // ── Date line ────────────────────────────────────────────────────────────
    var dateY = ruleY - 15;
    var date  = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    ops.push('BT /F1 ' + smallFS + ' Tf 1 0 0 1 ' + mL + ' ' + dateY + ' Tm (' + pe(date) + ') Tj ET');

    // ── Body paragraphs — fully justified ───────────────────────────────────
    y = dateY - (bodyLH + 8);
    text.split(/\n\n+/).map(function(p) { return p.trim(); }).filter(Boolean).forEach(function(para) {
      if (y < 54) return;
      // Honour hard \n within a block (handles sign-off "Sincerely,\n[Name]")
      var segments = para.split('\n');
      var allLines = [];
      // Track whether each line is the last of its segment (never justify last lines)
      var isLastFlags = [];
      segments.forEach(function(seg) {
        if (!seg.trim()) { allLines.push(''); isLastFlags.push(true); return; }
        var wrapped = wrap(seg, textW, bodyFS);
        wrapped.forEach(function(wl, wi) {
          allLines.push(wl);
          isLastFlags.push(wi === wrapped.length - 1);
        });
      });
      ops.push('BT /F1 ' + bodyFS + ' Tf 1 0 0 1 ' + mL + ' ' + y + ' Tm');
      allLines.forEach(function(line, i) {
        if (i > 0) ops.push('0 -' + bodyLH + ' Td');

        var isLast     = isLastFlags[i];
        var spaceCount = (line.match(/ /g) || []).length;
        var charCount  = line.length;
        var lineW      = tw(line, bodyFS);
        var extra      = textW - lineW;

        // Full justification using Tc (character spacing) + Tw (word spacing) combined.
        // Tw = 2 × Tc so word boundaries carry more weight than inter-letter spacing.
        // Formula: Tc × charCount + Tw × spaceCount = extra
        //       => Tc × (charCount + 2 × spaceCount) = extra
        // This guarantees every non-last line reaches the right margin regardless of
        // how many spaces it contains — no fallback, no clamp.
        if (!isLast && spaceCount > 0 && extra > 0) {
          var Tc = extra / (charCount + 2 * spaceCount);
          var Tw = 2 * Tc;
          ops.push(Tc.toFixed(4) + ' Tc ' + Tw.toFixed(4) + ' Tw');
        } else {
          ops.push('0 Tc 0 Tw');
        }

        ops.push('(' + pe(line) + ') Tj');
        y -= bodyLH;
      });
      ops.push('0 Tc 0 Tw ET');  // always reset both spacing operators after each block
      y -= 10;  // inter-paragraph gap
    });

    var stream = ops.join('\n');

    // Hyperlink annotation for the website (positioned at header right side)
    var headerY = H - 50;  // same baseline used for the header
    var annot = '<< /Type /Annot /Subtype /Link'
      + ' /Rect [' + Math.floor(webStartX - 1) + ' ' + (headerY - 2) + ' ' + Math.ceil(webStartX + webStrW + 2) + ' ' + (headerY + smallFS + 1) + ']'
      + ' /Border [0 0 0]'
      + ' /A << /Type /Action /S /URI /URI (https://' + pe(web) + ') >> >>';

    // ── Build PDF objects ────────────────────────────────────────────────────
    var pdf = '%PDF-1.4\n', off = {};
    function obj(id, body) { off[id] = pdf.length; pdf += id + ' 0 obj\n' + body + '\nendobj\n'; }

    obj(1, '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
    obj(2, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman  /Encoding /WinAnsiEncoding >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold   /Encoding /WinAnsiEncoding >>');
    obj(4, annot);
    obj(5, '<< /Type /Page /Parent 6 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Contents 1 0 R /Annots [4 0 R] /Resources << /Font << /F1 2 0 R /F2 3 0 R >> >> >>');
    obj(6, '<< /Type /Pages /Kids [5 0 R] /Count 1 >>');
    obj(7, '<< /Type /Catalog /Pages 6 0 R >>');

    var xrefPos = pdf.length;
    pdf += 'xref\n0 8\n0000000000 65535 f \n';
    [1, 2, 3, 4, 5, 6, 7].forEach(function(id) {
      pdf += String(off[id]).padStart(10, '0') + ' 00000 n \n';
    });
    pdf += 'trailer\n<< /Size 8 /Root 7 0 R >>\nstartxref\n' + xrefPos + '\n%%EOF';

    var blob = new Blob([pdf], { type: 'application/pdf' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    var fname = ((jobTitle || 'Cover_Letter') + (company ? '_' + company : '') + '.pdf')
      .replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/_+/g, '_');
    a.download = fname;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(a.href); }, 10000);
    setStatus('PDF downloaded!', 'success');
  }

  // ─── Observer ────────────────────────────────────────────────────────────────
  if (detectSimplify()) {
    setTimeout(injectPanel, 600);
  } else {
    var obs = new MutationObserver(function() {
      if (detectSimplify()) { obs.disconnect(); setTimeout(injectPanel, 800); }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['id','class'] });
  }

  // Popup can trigger panel manually
  document.addEventListener('covercraft:open', function() { if (!injected) injectPanel(); });

})();
