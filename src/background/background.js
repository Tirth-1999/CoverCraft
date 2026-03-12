// CoverCraft Background Service Worker v2
// Clean rebuild — no dead code

// ─── Default keys & model (overridden by settings) ───────────────────────────
var DEFAULTS = {
  openrouterKey: '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',
  tavilyKey:     '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',
  model:         'openrouter/free'
};

// Runtime config — loaded from chrome.storage.sync
var CFG = {
  openrouterKey: DEFAULTS.openrouterKey,
  tavilyKey:     DEFAULTS.tavilyKey,
  model:         DEFAULTS.model
};

function loadConfig() {
  return new Promise(function(resolve) {
    chrome.storage.sync.get(['openrouterKey','tavilyKey','model','customModel'], function(d) {
      CFG.openrouterKey = d.openrouterKey || DEFAULTS.openrouterKey;
      CFG.tavilyKey     = d.tavilyKey     || DEFAULTS.tavilyKey;
      if (d.model) {
        CFG.model = (d.model === 'custom' && d.customModel) ? d.customModel : d.model;
      } else {
        CFG.model = DEFAULTS.model;
      }
      resolve();
    });
  });
}

// Load on startup
loadConfig();

// ─── Portfolio ────────────────────────────────────────────────────────────────
var PORTFOLIO = {
  name: 'Tirth Shah', phone: '979-635-2045', website: 'Tirthcshah.com', email: 'tirthdhara108@gmail.com',
  education: 'MS Management Information Systems, Texas A&M University (May 2026), GPA 9.86/10. B.E. Computer Engineering, SVIT/GTU, GPA 9.5/10.',
  achievements: [
    'Co-Founded BlackTieCars: built full-stack platform solo generating $10K+ revenue and 3x business growth in 3 months',
    'Reduced manual reporting 95% via Python ETL at Texas A&M, saving 300+ hrs/year',
    'Migrated 7 data aggregators to GCP data-fabric, increasing hit ratio 45% and reducing lookup time 93%',
    'Built AI chat assistant with Google Gemini 2.5 Flash + ChromaDB: under 3s response time, 90%+ accuracy on BI queries',
    'Won TAMU Datathon 2025 with AI-Powered Regulatory Document Classifier',
    'MS-MIS Scholarship Recipient, Texas A&M University',
    'Employee of the Month (x2), Texas A&M University'
  ],
  experiences: [
    { company: 'HCLTech', role: 'Global Engagement Management Intern', duration: 'Feb 2026 - Present',
      highlights: ['Building knowledge of global client engagement governance and cross-functional operations at large-scale IT services org'] },
    { company: 'Mays Business School, Texas A&M University', role: 'Graduate Student Assistant', duration: 'Nov 2025 - Feb 2026',
      highlights: [
        'Architected Python ETL platform processing 2,400+ admissions records from 7 programs, eliminating 95% manual reporting, saving 300+ hrs/year',
        'Engineered ML forecasting engine (Prophet, ARIMA, scikit-learn) achieving under 15% MAPE for enrollment predictions 8 months ahead',
        'Built production AI chat assistant with Google Gemini 2.5 Flash + ChromaDB: under 3s response time, 90%+ accuracy on BI questions',
        'Designed Streamlit dashboard with Google OAuth 2.0, RBAC, 6 modules analyzing $500K+ annual marketing spend'
      ]},
    { company: 'Texas A&M University - Utilities and Energy Services', role: 'Data Engineer Student Worker', duration: 'Feb 2025 - Nov 2025',
      highlights: [
        'Orchestrated Python ETL for 50,000+ daily sensor feeds from 15 sources into SQL, automating Power BI reporting, cutting manual work 95%',
        'Built week-ahead forecast integrating ERCOT market price, weather, solar data - increasing forecast accuracy 30%',
        'Digitized billing with OCR pipeline achieving 97% accuracy, cutting processing from 2 hrs to 6 minutes'
      ]},
    { company: 'Black Tie Concierge, Inc.', role: 'AI and Data Intern - Digital Product Strategy', duration: 'May 2025 - Aug 2025',
      highlights: [
        'Solely built complete digital platform with Next.js, TypeScript, Supabase generating $10K+ revenue and 3x growth in 3 months',
        'Engineered serverless architecture cutting manual processes 70%',
        'Integrated Stripe, Google Maps API, CI/CD via Vercel achieving 99.9% uptime'
      ]},
    { company: 'Tata Consultancy Services', role: 'Data Engineer', duration: 'Jan 2024 - Aug 2024',
      highlights: [
        'Modernized 60+ legacy SAS scripts to Python, cutting runtime 80%, compute cost 50%, tripling peak-hour throughput',
        'Replaced 15+ Excel reports with interactive dashboards, reducing errors 90%',
        'Implemented QA automation compressing test cycles from 3 days to 2 hours'
      ]},
    { company: 'Tata Consultancy Services', role: 'Data Migration Analyst', duration: 'Aug 2021 - Jan 2024',
      highlights: [
        'Migrated on-prem workflows to GCP data-fabric unifying 7 data aggregators, increasing hit ratio 45% and reducing lookup time 93%',
        'Standardized heterogeneous client files via GCP ETL into canonical schemas enabling reliable matching at scale'
      ]},
    { company: 'Alphaa AI', role: 'Data Science Intern', duration: 'Nov 2020 - Feb 2021',
      highlights: [
        'Engineered revenue-forecasting dashboards with time-series + 10,000+ Monte Carlo simulations delivering +40% YoY revenue improvement',
        'Built sentiment-tagged sales analytics dashboard increasing user conversion rate 30%'
      ]}
  ],
  skills: 'Python, SQL, Power BI, Tableau, Azure, GCP, AWS, dbt, Airflow, Docker, Kubernetes, LangChain, Next.js, TypeScript, FastAPI, TensorFlow, PyTorch, Scikit-learn, Pandas, NumPy, Supabase, Stripe, Google Gemini, ChromaDB, Streamlit, SAS, OCR. Domains: Machine Learning, NLP, ETL, Data Pipelines, Data Modeling, MLOps, Business Intelligence, Cloud Architecture, Full-Stack Development, Product Management, AI Automation.',
  certifications: [
    'Professional Scrum Master I (PSM I) - Scrum.org, Sep 2024',
    'Microsoft Certified: Azure Data Fundamentals, May 2022',
    'Microsoft Certified: Azure AI Fundamentals, May 2022',
    'Microsoft Certified: Azure Fundamentals, Jun 2021'
  ]
};

// ─── Unified log storage ──────────────────────────────────────────────────────
// All activity is stored in a single 'covercraft_logs' array.
// Each entry has a 'kind': 'pipeline' | 'extract' | 'scrape'
// This guarantees nothing is lost even if the logs page is never opened.

var STORAGE_KEY = 'covercraft_logs';
var MAX_LOGS = 100;

function appendLog(entry) {
  // Fire-and-forget with a keep-alive alarm to prevent SW from sleeping mid-write
  chrome.storage.local.get([STORAGE_KEY], function(r) {
    var logs = Array.isArray(r[STORAGE_KEY]) ? r[STORAGE_KEY] : [];
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs = logs.slice(0, MAX_LOGS);
    var obj = {};
    obj[STORAGE_KEY] = logs;
    chrome.storage.local.set(obj);
  });
}

function clearLogs(cb) {
  var obj = {};
  obj[STORAGE_KEY] = [];
  chrome.storage.local.set(obj, cb);
}

function getLogs(cb) {
  chrome.storage.local.get([STORAGE_KEY], function(r) {
    cb(Array.isArray(r[STORAGE_KEY]) ? r[STORAGE_KEY] : []);
  });
}

// ─── Install ──────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(function() {
  var obj = {};
  obj[STORAGE_KEY] = [];
  chrome.storage.local.set(obj);
  console.log('[CoverCraft v2] Installed');
});

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {

  if (msg.type === 'SIMPLIFY_DETECTED') {
    if (sender.tab && sender.tab.id) {
      chrome.action.setBadgeText({ text: '✦', tabId: sender.tab.id });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId: sender.tab.id });
    }
    return false;
  }

  if (msg.type === 'EXTRACT_JOB_INFO') {
    handleExtract(msg.payload, sendResponse);
    return true;
  }

  if (msg.type === 'RUN_PIPELINE') {
    runPipeline(msg.payload, sendResponse);
    return true;
  }

  if (msg.type === 'GET_LOGS') {
    getLogs(function(logs) { sendResponse({ logs: logs }); });
    return true;
  }

  if (msg.type === 'CLEAR_LOGS') {
    clearLogs(function() { sendResponse({ ok: true }); });
    return true;
  }

  if (msg.type === 'RELOAD_CONFIG') {
    loadConfig().then(function() { sendResponse({ ok: true, model: CFG.model }); });
    return true;
  }

  if (msg.type === 'GET_CONFIG') {
    loadConfig().then(function() { sendResponse({ model: CFG.model }); });
    return true;
  }

  if (msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
    return false;
  }

  if (msg.type === 'OPEN_SETTINGS') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/options/options.html') });
    return false;
  }

  return false;
});

// ─── JSON repair helper ───────────────────────────────────────────────────────
function repairJSON(str) {
  var s = str.trim();
  s = s.replace(/,\s*([}\]])/g, '$1');
  if ((s.match(/"/g) || []).length % 2 !== 0) s += '"';
  var opens = 0, braces = 0;
  for (var i = 0; i < s.length; i++) {
    if (s[i] === '[') opens++;
    else if (s[i] === ']') opens--;
    else if (s[i] === '{') braces++;
    else if (s[i] === '}') braces--;
  }
  s = s.replace(/,\s*$/, '');
  while (opens > 0)  { s += ']'; opens--;  }
  while (braces > 0) { s += '}'; braces--; }
  return s;
}

// ─── OpenRouter helper ────────────────────────────────────────────────────────
async function aiChat(systemMsg, userMsg, temperature, maxTokens) {
  var resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + CFG.openrouterKey,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://covercraft.extension',
      'X-Title': 'CoverCraft'
    },
    body: JSON.stringify({
      model: CFG.model,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user',   content: userMsg }
      ],
      temperature: temperature,
      max_tokens:  maxTokens
    })
  });
  if (!resp.ok) {
    var e = await resp.json().catch(function() { return {}; });
    throw new Error((e.error && e.error.message) || ('OpenRouter HTTP ' + resp.status));
  }
  var d = await resp.json();
  return {
    content: (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '',
    model:   d.model || CFG.model
  };
}

// ─── EXTRACT_JOB_INFO — quick title+company auto-fill ────────────────────────
async function handleExtract(payload, sendResponse) {
  await loadConfig();
  var rawText = (payload.rawPageText || '').slice(0, 3000);
  var ts = new Date().toISOString();

  var logEntry = {
    id:         Date.now(),
    kind:       'extract',
    timestamp:  ts,
    url:        payload.pageUrl || '',
    model:      CFG.model,
    inputChars: rawText.length,
    inputWords: rawText.trim().split(/\s+/).length,
    scrapePreview: rawText.slice(0, 400),
    systemPrompt: 'You are a job posting parser. Respond ONLY with JSON: {"jobTitle":"...","companyName":"..."}. No markdown, no explanation.',
    userPrompt:   'What is the job title and company name?\n\n' + rawText,
    rawResponse:  '',
    result:       null,
    error:        null
  };

  if (!rawText) {
    logEntry.error = 'Empty page text';
    appendLog(logEntry);
    sendResponse({ jobTitle: '', companyName: '' });
    return;
  }

  try {
    var r = await aiChat(logEntry.systemPrompt, logEntry.userPrompt, 0.0, 300);
    logEntry.rawResponse = r.content;
    logEntry.model = r.model;
    var clean = r.content.replace(/```json|```/g, '').trim();
    var parsed;
    try { parsed = JSON.parse(clean); }
    catch(_) { parsed = JSON.parse(repairJSON(clean)); }
    logEntry.result = { jobTitle: parsed.jobTitle || '', companyName: parsed.companyName || '' };
  } catch(e) {
    logEntry.error = e.message;
    logEntry.result = { jobTitle: '', companyName: '' };
  }

  appendLog(logEntry);
  sendResponse(logEntry.error ? { jobTitle: '', companyName: '', error: logEntry.error } : logEntry.result);
}

// ─── RUN_PIPELINE — full extract → tavily → generate ─────────────────────────
async function runPipeline(payload, sendResponse) {
  await loadConfig();

  var pipelineId = Date.now();
  var ts = new Date().toISOString();

  // ── Build the log entry upfront so we can mutate it as steps complete ───────
  var log = {
    id:        pipelineId,
    kind:      'pipeline',
    timestamp: ts,
    url:       payload.pageUrl || '',
    style:     payload.coverLetterType || 'formal',
    model:     CFG.model,

    // Step 1 — scrape metadata (scraping happens in content.js, we just record it)
    step1: {
      timestamp:     ts,
      wordCount:     payload.rawPageText ? payload.rawPageText.trim().split(/\s+/).length : 0,
      charCount:     (payload.rawPageText || '').length,
      fullText:      payload.rawPageText || '',
      preview:       (payload.rawPageText || '').slice(0, 500),
      titleHint:     payload.titleHint    || '',
      companyHint:   payload.companyHint  || '',
      status:        'ok'
    },

    // Steps 2-4 filled in below
    step2: null,
    step3: null,
    step4: null,

    output: null,
    error:  null
  };

  try {
    // ── STEP 2: AI extraction ─────────────────────────────────────────────────
    var sysExtract = [
      'You are a job posting parser. Return ONLY a single valid JSON object — no markdown, no explanation.',
      'RULES: keywords max 10 items each under 20 chars. responsibilities/requirements max 5 items each under 80 chars.',
      'jobId must be a string — use "" if not found, never null.'
    ].join('\n');
    var usrExtract = [
      'Extract from this job posting. Return ONLY this JSON:',
      '{"jobTitle":"","companyName":"","location":"","jobId":"","seniorityLevel":"","keywords":[],"responsibilities":[],"requirements":[]}',
      '',
      'JOB POSTING:',
      (payload.rawPageText || '').slice(0, 5000)
    ].join('\n');

    var extResp = await aiChat(sysExtract, usrExtract, 0.1, 1200);
    var extRaw  = extResp.content.replace(/```json|```/g, '').trim();

    var extracted = {};
    var parseNote = '';
    try {
      extracted = JSON.parse(extRaw);
      parseNote = 'direct';
    } catch(_) {
      try {
        extracted = JSON.parse(repairJSON(extRaw));
        parseNote = 'repaired';
      } catch(_2) {
        // Fallback: minimal re-ask
        var fbResp = await aiChat(
          'Return ONLY a JSON object, no other text.',
          'Extract job title, company, location, seniority from:\n\n' + (payload.rawPageText||'').slice(0,2000) +
          '\n\nReturn ONLY: {"jobTitle":"","companyName":"","location":"","jobId":"","seniorityLevel":"","keywords":[],"responsibilities":[],"requirements":[]}',
          0.0, 600
        );
        var fbRaw = fbResp.content.replace(/```json|```/g, '').trim();
        try {
          extracted = JSON.parse(repairJSON(fbRaw));
          parseNote = 'fallback';
          extRaw = extRaw + '\n\n--- FALLBACK RAW ---\n' + fbRaw;
        } catch(_3) {
          extracted = { parseError: extRaw.slice(0, 600), jobTitle: '', companyName: '', keywords: [], responsibilities: [], requirements: [] };
          parseNote = 'failed';
        }
      }
    }

    // Sanitize
    if (!extracted.parseError) {
      if (!extracted.jobId || extracted.jobId === null) extracted.jobId = '';
      extracted.keywords        = (Array.isArray(extracted.keywords)        ? extracted.keywords        : []).slice(0,12).map(function(x){return String(x).slice(0,40);});
      extracted.responsibilities = (Array.isArray(extracted.responsibilities) ? extracted.responsibilities : []).slice(0,6).map(function(x){return String(x).slice(0,120);});
      extracted.requirements     = (Array.isArray(extracted.requirements)     ? extracted.requirements     : []).slice(0,6).map(function(x){return String(x).slice(0,120);});
    }

    // User hints override
    if (payload.titleHint)   extracted.jobTitle    = payload.titleHint;
    if (payload.companyHint) extracted.companyName = payload.companyHint;

    log.step2 = {
      timestamp:    new Date().toISOString(),
      systemPrompt: sysExtract,
      userPrompt:   usrExtract,
      rawResponse:  extResp.content,
      parsed:       extracted,
      parseNote:    parseNote,
      model:        extResp.model,
      status:       extracted.parseError ? 'parse_error' : 'ok'
    };

    var jobTitle    = extracted.jobTitle    || 'the role';
    var companyName = extracted.companyName || 'the company';

    // ── STEP 3: Tavily research ───────────────────────────────────────────────
    var tvResult = {
      timestamp: new Date().toISOString(),
      query1:    companyName + ' company mission values culture ' + jobTitle,
      query2:    companyName + ' product technology engineering team ' + jobTitle,
      summary:   '',
      sources:   [],
      error:     null,
      skipped:   false,
      skipReason: ''
    };

    if (!companyName || companyName === 'the company') {
      tvResult.skipped    = true;
      tvResult.skipReason = 'Company name not extracted';
    } else {
      // Query 1: culture/mission
      try {
        var tv1 = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ api_key: CFG.tavilyKey, query: tvResult.query1, search_depth: 'advanced', max_results: 5, include_answer: true, include_raw_content: false })
        });
        if (!tv1.ok) throw new Error('Tavily HTTP ' + tv1.status);
        var td1 = await tv1.json();
        tvResult.summary = td1.answer || '';
        tvResult.sources = (td1.results || []).map(function(r) {
          return { title: r.title, url: r.url, snippet: (r.content||'').slice(0,600), queryTag: 'culture' };
        });
      } catch(e) {
        tvResult.error = e.message;
      }

      // Query 2: product/tech (optional, ignore errors)
      try {
        var tv2 = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ api_key: CFG.tavilyKey, query: tvResult.query2, search_depth: 'basic', max_results: 3, include_answer: true, include_raw_content: false })
        });
        if (tv2.ok) {
          var td2 = await tv2.json();
          var extra = td2.answer || '';
          if (extra) tvResult.summary = (tvResult.summary ? tvResult.summary + '\n\n' : '') + extra;
          (td2.results || []).forEach(function(r) {
            tvResult.sources.push({ title: r.title, url: r.url, snippet: (r.content||'').slice(0,400), queryTag: 'product' });
          });
        }
      } catch(_) {}

      if (!tvResult.summary && tvResult.sources.length > 0) {
        tvResult.summary = tvResult.sources.map(function(s){return s.snippet;}).join('\n\n').slice(0,1200);
      }
    }

    log.step3 = tvResult;

    // ── STEP 4: Cover letter generation ──────────────────────────────────────
    var sysGen = buildSystemPrompt(payload.coverLetterType || 'formal');
    var usrGen = buildUserPrompt({ extracted: extracted, rawPageText: payload.rawPageText, companyResearch: tvResult.summary, style: payload.coverLetterType || 'formal' });

    var genResp    = await aiChat(sysGen, usrGen, 0.72, 1400);
    var coverLetter = genResp.content.trim();

    log.step4 = {
      timestamp:    new Date().toISOString(),
      systemPrompt: sysGen,
      userPrompt:   usrGen,
      rawResponse:  coverLetter,
      model:        genResp.model,
      inputChars:   sysGen.length + usrGen.length,
      outputChars:  coverLetter.length,
      outputWords:  coverLetter.trim().split(/\s+/).length,
      status:       'ok'
    };

    log.output = coverLetter;

  } catch(e) {
    log.error = e.message;
    appendLog(log);
    sendResponse({ error: e.message });
    return;
  }

  appendLog(log);
  sendResponse({
    coverLetter: log.output,
    extracted:   log.step2 && log.step2.parsed
  });
}

// ─── Cover letter prompts ─────────────────────────────────────────────────────
function buildSystemPrompt(style) {
  var styles = {
    formal:       'STYLE: FORMAL AND POLISHED.\nStructure: Date → "Hiring Manager / [Company] / [City]" → "Dear Hiring Manager," → Para 1 (delighted to apply + MS-MIS + 2 skills) → Para 2 (Data Engineer role + tools + 2 metrics) → Para 3 (second experience + different tools + outcomes) → Para 4 (soft skills) → Para 5 (company admiration using research) → Para 6 (forward-looking close) → Sincerely sign-off.',
    storytelling: 'STYLE: STORY-DRIVEN. Open with a defining moment. Arc: passion origin → challenge → solution → impact → why this company. Same formal envelope.',
    achievement:  'STYLE: ACHIEVEMENT-LED. Para 1 opens with 2 quantified wins. Every paragraph has a metric. Format: assertion → proof metric → business impact.',
    concise:      'STYLE: CONCISE. Max 250 words body. 4 paragraphs. One metric per paragraph. No filler.',
    startup:      'STYLE: STARTUP ENERGY. Energetic voice. Reference BlackTieCars as founder-level proof. Emphasize speed, autonomy, 0-to-1 execution.'
  };
  return [
    'You are writing a professional cover letter AS Tirth Shah in first person.',
    'PORTFOLIO: ' + JSON.stringify(PORTFOLIO),
    '',
    styles[style] || styles.formal,
    '',
    'RULES:',
    '- Output ONLY the letter. No labels, markdown, or commentary.',
    '- Never invent metrics. Only use numbers from the portfolio.',
    '- Always open: "I am delighted to apply for..."',
    '- Always close: Sincerely,\nTirth Shah\n979-635-2045\nTirthcshah.com'
  ].join('\n');
}

function buildUserPrompt(p) {
  var today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  var ex = p.extracted || {};
  var lines = [
    'Write a cover letter for Tirth Shah.',
    'TODAY: ' + today,
    '',
    'JOB DETAILS:',
    '- Title: '           + (ex.jobTitle       || 'infer from text'),
    '- Company: '         + (ex.companyName     || 'infer from text'),
    '- Location: '        + (ex.location        || 'not specified'),
    '- Seniority: '       + (ex.seniorityLevel  || 'not specified'),
    '- Keywords: '        + ((ex.keywords||[]).join(', ')           || 'see text'),
    '- Responsibilities: '+ ((ex.responsibilities||[]).join(' | ')  || 'see text'),
    '- Requirements: '    + ((ex.requirements||[]).join(' | ')      || 'see text')
  ];
  if (p.companyResearch) {
    lines.push('');
    lines.push('COMPANY RESEARCH (use for admiration paragraph):');
    lines.push(p.companyResearch.slice(0, 1500));
  }
  lines.push('');
  lines.push('FULL JOB POSTING:');
  lines.push('---');
  lines.push((p.rawPageText || '').slice(0, 3500));
  lines.push('---');
  lines.push('Write the complete cover letter now.');
  return lines.join('\n');
}
