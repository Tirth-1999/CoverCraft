// CoverCraft Background Service Worker v2
// Clean rebuild — no dead code

// Load local API keys (src/config.js is gitignored; copy from src/config.example.js)
importScripts('../config.js');

// Load personal portfolio (src/portfolio.js is gitignored; copy from src/portfolio.example.js)
importScripts('../portfolio.js');

// ─── Default keys & model (overridden by settings) ───────────────────────────
var DEFAULTS = {
  openrouterKey: COVERCRAFT_CONFIG.openrouterKey,
  tavilyKey:     COVERCRAFT_CONFIG.tavilyKey,
  model:         'arcee-ai/trinity-large-preview:free'
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
  var d = await resp.json().catch(function() { throw new Error('Empty or invalid response from OpenRouter'); });
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
  // Use model from payload immediately (avoids first-run race with RELOAD_CONFIG)
  if (payload.model) CFG.model = payload.model;

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

    // Retry up to 3 times if model returns an empty response (common with free-tier models)
    var genResp, coverLetter, genAttempts = 0;
    do {
      genAttempts++;
      genResp    = await aiChat(sysGen, usrGen, 0.72, 2200);
      coverLetter = stripFormatting(genResp.content.trim());
      if (!coverLetter && genAttempts < 3) {
        await new Promise(function(r) { setTimeout(r, 1500); });
      }
    } while (!coverLetter && genAttempts < 3);

    if (!coverLetter) {
      throw new Error('AI returned an empty response after ' + genAttempts + ' attempts. Try a different model or click Generate again.');
    }

    log.step4 = {
      timestamp:    new Date().toISOString(),
      systemPrompt: sysGen,
      userPrompt:   usrGen,
      rawResponse:  coverLetter,
      model:        genResp.model,
      inputChars:   sysGen.length + usrGen.length,
      outputChars:  coverLetter.length,
      outputWords:  coverLetter.trim().split(/\s+/).length,
      genAttempts:  genAttempts,
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

// ─── Markdown / formatting stripper ──────────────────────────────────────────
function stripFormatting(text) {
  var s = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')  // remove bold
    .replace(/\*([^*]+)\*/g, '$1')       // remove italic
    .replace(/^#{1,6}\s+/gm, '')         // remove markdown headers
    .replace(/^[-*•]\s+/gm, '')          // remove bullet lists
    .replace(/\u2014/g, ',')             // em-dash → comma
    .replace(/\u2013/g, '-')             // en-dash → hyphen
    .replace(/[\u201C\u201D]/g, '"')     // smart double quotes → straight
    .replace(/[\u2018\u2019]/g, "'")     // smart single quotes → straight
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Strip any preamble block before "Dear" (AI sometimes adds address/date header)
  var dearIdx = s.search(/\bDear\b/i);
  if (dearIdx > 0) s = s.slice(dearIdx).trim();

  // Strip any contact info or extra content after the name in the sign-off
  var ownerName = (typeof PORTFOLIO !== 'undefined' && PORTFOLIO.name) ? PORTFOLIO.name : '';
  if (ownerName) {
    var nameEsc = ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp('(Sincerely[,.]?\\s*\\n\\s*' + nameEsc + ')[\\s\\S]*', 'i'), '$1');
  }

  return s.trim();
}

// ─── Cover letter prompts ─────────────────────────────────────────────────────
function buildSystemPrompt(style) {
  var COMMON = [
    'You are writing a professional cover letter for a job applicant. Write entirely in FIRST PERSON.',
    '',
    'APPLICANT PORTFOLIO (use ONLY these facts — never invent or embellish numbers, dates, or achievements):',
    JSON.stringify(PORTFOLIO),
    '',
    '━━━ NON-NEGOTIABLE RULES ━━━',
    '• Output ONLY the letter text. Zero markdown, asterisks (*/**), bold, bullets, headers, or commentary.',
    '• First line must be exactly "Dear Hiring Manager," — NO date line, NO address block, NO recipient block before it.',
    '• Write in first person (I / my / me) throughout. Never write the applicant name in the body.',
    '• Prose paragraphs only — no bullet lists, no dash lists, no colon-introduced lists.',
    '• HARD MINIMUM: 450 words in the letter body (sign-off excluded). HARD MAXIMUM: 560 words. Count your words before finishing. If you are under 450 words, you MUST expand each paragraph with more context, specifics, and reasoning until you reach 450. Do not stop early.',
    '• Every paragraph must be substantive — no filler, no repetition, no hollow praise.',
    '',
    '━━━ EXPERIENCE INTEGRITY ━━━',
    '• The PORTFOLIO has distinct experience entries, each with a unique "company" name and its own "highlights" array.',
    '• CRITICAL RULE — ONE SENTENCE = ONE SOURCE. Every factual claim must trace back to exactly one PORTFOLIO experience entry. If you cannot trace a sentence to a single specific entry, cut it.',
    '• NEVER combine, blend, or transplant highlights across entries. Do NOT mix metrics from two different companies in the same sentence or clause. Do NOT imply that work done at Company A was done at or during Company B.',
    '• Before writing each paragraph, decide which single PORTFOLIO entry it covers. Every sentence in that paragraph must use only the highlights from THAT entry. If you need a second experience, start a new paragraph.',
    '• If an experience is irrelevant to the role, skip it entirely. Do not force relevance by merging it with another entry. Pick the next most-relevant entry instead.',
    '• Quote metrics verbatim from the portfolio: exact numbers, exact percentages, exact timeframes. Never round up, extrapolate, or rephrase a number.',
    '',
    '━━━ HUMAN VOICE — BANNED WORDS & PATTERNS ━━━',
    '• NEVER use any of these words or phrases: orchestrated, leveraged (as buzzword), spearheaded, facilitated (when meaning "helped"), utilized (say "used"), paramount, multifaceted, synergy, holistic, transformative, seamlessly, best-in-class, cutting-edge (as filler), passionate about, fast-paced environment, detail-oriented, team player, game-changer, stakeholders (say "the team" or be specific), robust (as filler), honed, garnered, adept at, versed in, proven track record, results-driven, self-motivated, dynamic (as empty adjective), innovative (as empty filler), I am excited to, I am thrilled to, I am eager to, deep dive, value-add, impactful, mission-driven (unless quoting the company), touch base, hard-working.',
    '• NEVER use em-dashes (—) or en-dashes (–). Use a comma, period, or semicolon instead.',
    '• NEVER use Oxford-comma lists of four or more items in a row.',
    '• Do NOT start every sentence with "I". Vary openers: lead with the action, the number, or the outcome.',
    '• Contractions are welcome ("I\'ve built", "it\'s been", "they don\'t") — they sound natural and human.',
    '• One or two short punchy sentences per paragraph (under 12 words) are encouraged — they add rhythm and confidence.',
    '• Write like a confident engineer or analyst talking casually but precisely to a smart colleague. No corporate-speak, no template phrases, no hollow adjectives.',
    '• Do NOT sound like a large-language model, a recruiting AI, or a resume template service.',
    '',
    '━━━ SIGN-OFF ━━━',
    '• The final sign-off must be EXACTLY these two lines, nothing more:\n  Sincerely,\n  ' + (PORTFOLIO.name || 'Your Name'),
    '• After the name there must be NOTHING — no phone number, no email, no website, no extra lines, no "P.S.".',
    '• Do NOT include any address block, date, or header block before "Dear". The letter starts immediately with "Dear Hiring Manager,".',
    ''
  ].join('\n');

  var structures = {
    formal: [
      '━━━ STRUCTURE (FORMAL & POLISHED) ━━━',
      'Para 1 (MIN 90 words): Open "I am applying for the [ROLE] at [COMPANY]." State your educational background and the most relevant top-line strength. Tie it directly to 2 things in the job description.',
      'Para 2 (MIN 110 words): Most relevant experience entry. Use 2-3 hard metrics from THAT SAME entry. Describe the problem, what you built, and what changed. Connect explicitly to 1-2 listed responsibilities.',
      'Para 3 (MIN 100 words): A second distinct experience entry — different domain or toolset. Minimum 2 metrics from THAT entry only. Show depth not covered by Para 2.',
      'Para 4 (MIN 75 words): A third proof point or a skill/project that fills a specific gap in the job requirements. Can be from education, a side project, or a certification if no third experience applies.',
      'Para 5 (MIN 60 words): Use company research to show genuine, specific interest in their mission, product, or team. One concrete detail, not generic praise.',
      'Para 6 (MIN 40 words): Thank the reader. Express that you want a conversation. No hollow phrases like "I look forward to hearing from you."'
    ].join('\n'),

    storytelling: [
      '━━━ STRUCTURE (STORY-DRIVEN) ━━━',
      'Para 1 (MIN 90 words): Open with a real, specific moment or problem from the portfolio. Make it vivid. Pivot naturally to why this role is the next chapter.',
      'Para 2 (MIN 110 words): The main story arc — what the challenge was, what you built or changed, the specific outcome in numbers. From a single PORTFOLIO entry.',
      'Para 3 (MIN 100 words): Second story beat from a completely different experience entry. Different stakes, different tools, same standard of evidence.',
      'Para 4 (MIN 75 words): Third concrete example or skill that closes a remaining gap in the job requirements.',
      'Para 5 (MIN 60 words): Why THIS company, at this moment. Use research. One or two sentences that could only be written about this specific company.',
      'Para 6 (MIN 40 words): Energetic, human close that sounds like an invitation to talk.'
    ].join('\n'),

    achievement: [
      '━━━ STRUCTURE (ACHIEVEMENT-LED) ━━━',
      'Para 1 (MIN 80 words): Open with 2 quantified wins from different PORTFOLIO entries. State the role you\'re applying for.',
      'Para 2 (MIN 110 words): Primary experience. Every sentence must have a metric. Pattern: action → number → business impact. All from one entry.',
      'Para 3 (MIN 100 words): Second experience. Different domain, same evidence standard. Minimum 2 metrics from that entry.',
      'Para 4 (MIN 75 words): Third proof point, certifications, or academic project directly tied to a specific job requirement.',
      'Para 5 (MIN 60 words): Company fit paragraph — specific and research-backed.',
      'Para 6 (MIN 40 words): Confident, direct close.'
    ].join('\n'),

    concise: [
      '━━━ STRUCTURE (CONCISE & PUNCHY) ━━━',
      'Exactly 5 paragraphs. Total body 450-500 words.',
      'Para 1 (MIN 70 words): One strong opener, credential, direct fit statement.',
      'Para 2 (MIN 100 words): Best experience. Every sentence has a metric. One entry only.',
      'Para 3 (MIN 90 words): Second experience. One entry only. Minimum 2 metrics.',
      'Para 4 (MIN 70 words): Third proof or skill that closes a specific job requirement gap.',
      'Para 5 (MIN 60 words): Company admiration (specific) + close in one tight paragraph.'
    ].join('\n'),

    startup: [
      '━━━ STRUCTURE (STARTUP ENERGY) ━━━',
      'Para 1 (MIN 90 words): Lead with your most impressive portfolio achievement — solo project, business result, or quantified impact. Pivot to the role.',
      'Para 2 (MIN 110 words): Most relevant experience. Direct language: "built", "shipped", "cut X by Y%". At least 2 metrics from that same entry.',
      'Para 3 (MIN 100 words): Second proof point from a completely different entry. Show breadth and speed of execution.',
      'Para 4 (MIN 70 words): Third angle — a specific technical skill or project that matches something in the job requirements.',
      'Para 5 (MIN 60 words): Why this company, at this stage. Reference their actual product or problem. No generic praise.',
      'Para 6 (MIN 40 words): Short, decisive close.'
    ].join('\n')
  };

  return COMMON + (structures[style] || structures.formal);
}

function buildUserPrompt(p) {
  var ex = p.extracted || {};
  var lines = [
    'Write the cover letter now.',
    '',
    'JOB DETAILS:',
    '- Role: '             + (ex.jobTitle        || 'infer from posting'),
    '- Company: '          + (ex.companyName      || 'infer from posting'),
    '- Location: '         + (ex.location         || 'not specified'),
    '- Seniority: '        + (ex.seniorityLevel   || 'not specified'),
    '- Keywords: '         + ((ex.keywords         || []).join(', ') || 'see posting'),
    '- Responsibilities: ' + ((ex.responsibilities || []).join(' | ') || 'see posting'),
    '- Requirements: '     + ((ex.requirements     || []).join(' | ') || 'see posting')
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
  lines.push('');
  lines.push('Begin immediately with "Dear Hiring Manager," — no date, no address block, no preamble.');
  return lines.join('\n');
}
