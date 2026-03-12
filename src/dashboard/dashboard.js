var allLogs = [];

// ─── Utility ──────────────────────────────────────────────────────────────────
function fmtTime(iso) {
  try {
    var d = new Date(iso);
    return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) +
           ' ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  } catch(_) { return iso||''; }
}

function mkEl(tag, cls, text) {
  var el = document.createElement(tag);
  if (cls)  el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function mkBadge(text, cls) {
  return mkEl('span', 'badge ' + (cls||'b-gray'), text);
}

function mkCode(text) {
  var pre = mkEl('pre', 'code');
  pre.textContent = String(text||'(empty)');
  return pre;
}

function mkKV(rows) {
  var t = mkEl('table','kv');
  rows.forEach(function(r) {
    var tr = mkEl('tr'); var td1 = mkEl('td',null,r[0]); var td2 = mkEl('td',null,String(r[1]==null?'—':r[1]));
    tr.appendChild(td1); tr.appendChild(td2); t.appendChild(tr);
  });
  return t;
}

function mkPills(items) {
  var d = mkEl('div','pills');
  (items||[]).forEach(function(x){ d.appendChild(mkEl('span','pill',x)); });
  return d;
}

function mkCopyBtn(getText) {
  var b = mkEl('button','cp','Copy');
  b.addEventListener('click', function(e) {
    e.stopPropagation();
    navigator.clipboard.writeText(getText()).then(function() {
      b.textContent='Copied!'; b.classList.add('ok');
      setTimeout(function(){b.textContent='Copy';b.classList.remove('ok');},1500);
    });
  });
  return b;
}

function mkSection(label, contentEl, getText) {
  var sec = mkEl('div','sec');
  var lbl = mkEl('div','sec-lbl',label);
  if (getText) lbl.appendChild(mkCopyBtn(getText));
  sec.appendChild(lbl); sec.appendChild(contentEl);
  return sec;
}

function mkErrBox(text) {
  var d = mkEl('div','err-box'); d.textContent = text; return d;
}

function mkSkipBox(text) {
  var d = mkEl('div','skip-box'); d.textContent = text; return d;
}

// ─── Step builder ─────────────────────────────────────────────────────────────
function mkStep(icon, iconCls, label, summary, badgeFn, bodyFn) {
  var step = mkEl('div','step');
  var hdr  = mkEl('div','step-hdr');
  var ic   = mkEl('div','step-icon '+iconCls, icon);
  var info = mkEl('div','step-info');
  var lbl  = mkEl('div','step-lbl', label);
  var sum  = mkEl('div','step-sum', summary);
  var bgs  = mkEl('div','badges');
  badgeFn(bgs);
  info.appendChild(lbl); info.appendChild(sum); info.appendChild(bgs);
  var chev = mkEl('div','schev','▶');
  hdr.appendChild(ic); hdr.appendChild(info); hdr.appendChild(chev);
  var body = mkEl('div','step-body');
  bodyFn(body);
  hdr.addEventListener('click', function() {
    var o = body.classList.toggle('open');
    chev.classList.toggle('open', o);
  });
  step.appendChild(hdr); step.appendChild(body);
  return step;
}

// ─── Pipeline steps ───────────────────────────────────────────────────────────
function buildPipelineStep1(log) {
  var s1 = log.step1 || {};
  return mkStep('🔍','si1','Step 1 — Page Scrape',
    (s1.wordCount||0)+' words · '+(s1.charCount||0)+' chars scraped',
    function(b) {
      b.appendChild(mkBadge((s1.wordCount||0)+' words','b-blue'));
      b.appendChild(mkBadge((s1.charCount||0)+' chars','b-blue'));
      if (s1.titleHint)   b.appendChild(mkBadge('Title: '+s1.titleHint,'b-gray'));
      if (s1.companyHint) b.appendChild(mkBadge('Company: '+s1.companyHint,'b-gray'));
    },
    function(body) {
      body.appendChild(mkSection('Scrape Details', mkKV([
        ['Words',    s1.wordCount||0],
        ['Chars',    s1.charCount||0],
        ['URL',      log.url||'—'],
        ['Title hint',   s1.titleHint||'(none)'],
        ['Company hint', s1.companyHint||'(none)'],
        ['Style',    log.style||'formal'],
        ['Model',    log.model||'—']
      ])));
      if (s1.preview) {
        var t = s1.preview;
        body.appendChild(mkSection('Text Preview (500 chars)', mkCode(t), function(){return s1.fullText||t;}));
      }
    }
  );
}

function buildPipelineStep2(log) {
  var s2 = log.step2 || {};
  var p  = s2.parsed || {};
  var hasErr = !!p.parseError;
  return mkStep('🤖','si2','Step 2 — AI Job Extraction',
    hasErr ? 'Parse error' : ((p.jobTitle||'—')+' at '+(p.companyName||'—')),
    function(b) {
      if (hasErr) { b.appendChild(mkBadge('Parse Error','b-red')); return; }
      if (p.jobTitle)      b.appendChild(mkBadge('📄 '+p.jobTitle,'b-ind'));
      if (p.companyName)   b.appendChild(mkBadge('🏢 '+p.companyName,'b-ind'));
      if (p.location)      b.appendChild(mkBadge('📍 '+p.location,'b-gray'));
      if (p.seniorityLevel) b.appendChild(mkBadge(p.seniorityLevel,'b-gray'));
      if (p.jobId)         b.appendChild(mkBadge('ID: '+p.jobId,'b-gray'));
      if (s2.parseNote)    b.appendChild(mkBadge('parse: '+s2.parseNote,'b-gray'));
      if (p.keywords&&p.keywords.length) b.appendChild(mkBadge(p.keywords.length+' keywords','b-ind'));
    },
    function(body) {
      if (hasErr) {
        body.appendChild(mkSection('Parse Error', mkErrBox('AI response could not be parsed as JSON.\n\n'+p.parseError)));
      } else {
        body.appendChild(mkSection('Extracted Fields', mkKV([
          ['Job Title',  p.jobTitle],
          ['Company',    p.companyName],
          ['Location',   p.location],
          ['Seniority',  p.seniorityLevel],
          ['Job ID',     p.jobId]
        ])));
        if (p.keywords&&p.keywords.length)         body.appendChild(mkSection('Keywords', mkPills(p.keywords)));
        if (p.responsibilities&&p.responsibilities.length) {
          var t = p.responsibilities.map(function(r,i){return (i+1)+'. '+r;}).join('\n');
          body.appendChild(mkSection('Responsibilities', mkCode(t)));
        }
        if (p.requirements&&p.requirements.length) {
          var t2 = p.requirements.map(function(r,i){return (i+1)+'. '+r;}).join('\n');
          body.appendChild(mkSection('Requirements', mkCode(t2)));
        }
      }
      if (s2.systemPrompt) { var sp=s2.systemPrompt; body.appendChild(mkSection('System Prompt', mkCode(sp), function(){return sp;})); }
      if (s2.userPrompt)   { var up=s2.userPrompt;   body.appendChild(mkSection('User Prompt',   mkCode(up), function(){return up;})); }
      if (s2.rawResponse)  { var rr=s2.rawResponse;  body.appendChild(mkSection('Raw AI Response', mkCode(rr), function(){return rr;})); }
    }
  );
}

function buildPipelineStep3(log) {
  var s3 = log.step3 || {};
  var q1src = (s3.sources||[]).filter(function(s){return s.queryTag!=='product';});
  var q2src = (s3.sources||[]).filter(function(s){return s.queryTag==='product';});
  return mkStep('🌐','si3','Step 3 — Tavily Research',
    s3.skipped ? 'Skipped: '+s3.skipReason :
    s3.error   ? 'Error: '+s3.error.slice(0,70) :
                 (s3.sources||[]).length+' sources from 2 queries',
    function(b) {
      if (s3.skipped)  { b.appendChild(mkBadge('Skipped','b-gray')); return; }
      if (s3.error)    { b.appendChild(mkBadge('Error','b-red'));     return; }
      b.appendChild(mkBadge(q1src.length+' culture sources','b-amb'));
      if (q2src.length) b.appendChild(mkBadge(q2src.length+' product sources','b-amb'));
      if (s3.summary)   b.appendChild(mkBadge('Summary ready','b-grn'));
    },
    function(body) {
      if (s3.skipped) { body.appendChild(mkSection('Skipped', mkSkipBox(s3.skipReason))); return; }
      if (s3.error)   body.appendChild(mkSection('Error', mkErrBox(s3.error)));
      if (s3.query1)  { var q=s3.query1; body.appendChild(mkSection('Query 1 — Culture/Mission',  mkCode(q), function(){return q;})); }
      if (s3.query2)  { var q2=s3.query2; body.appendChild(mkSection('Query 2 — Product/Tech',   mkCode(q2),function(){return q2;}));}
      if (s3.summary) { var sm=s3.summary; body.appendChild(mkSection('Combined Summary', mkCode(sm), function(){return sm;})); }
      function mkSrcs(srcs, label) {
        if (!srcs.length) return;
        var w = mkEl('div');
        srcs.forEach(function(src) {
          var c=mkEl('div','src-card');
          c.appendChild(mkEl('div','src-title',src.title||''));
          if(src.url){var u=mkEl('div','src-url');u.textContent=src.url;c.appendChild(u);}
          c.appendChild(mkEl('div','src-snip',src.snippet||''));
          if(src.queryTag){c.appendChild(mkEl('div','src-tag','query: '+src.queryTag));}
          w.appendChild(c);
        });
        body.appendChild(mkSection(label+' ('+srcs.length+')', w));
      }
      mkSrcs(q1src, 'Culture / Mission Sources');
      mkSrcs(q2src, 'Product / Tech Sources');
    }
  );
}

function buildPipelineStep4(log) {
  var s4 = log.step4 || {};
  var failed = log.error && !s4.rawResponse;
  return mkStep('✍️','si4','Step 4 — Cover Letter Generation',
    failed ? 'Failed: '+log.error : 'Generated '+(s4.outputWords||0)+' words · '+(s4.outputChars||0)+' chars',
    function(b) {
      if (failed) { b.appendChild(mkBadge('Failed','b-red')); return; }
      if (s4.outputWords) b.appendChild(mkBadge(s4.outputWords+' words output','b-grn'));
      if (s4.outputChars) b.appendChild(mkBadge(s4.outputChars+' chars','b-grn'));
      if (s4.model)       b.appendChild(mkBadge(s4.model,'b-gray'));
    },
    function(body) {
      if (log.error) body.appendChild(mkSection('Error', mkErrBox(log.error)));
      if (s4.systemPrompt) { var sp=s4.systemPrompt; body.appendChild(mkSection('System Prompt', mkCode(sp), function(){return sp;})); }
      if (s4.userPrompt)   { var up=s4.userPrompt;   body.appendChild(mkSection('User Prompt',   mkCode(up), function(){return up;})); }
      if (s4.rawResponse)  { var out=s4.rawResponse; body.appendChild(mkSection('Generated Cover Letter', mkCode(out), function(){return out;})); }
    }
  );
}

// ─── Extract log card ─────────────────────────────────────────────────────────
function buildExtractCard(log, num) {
  var card = mkEl('div','log-card');
  var hdr  = mkEl('div','log-hdr');
  hdr.appendChild(mkEl('span','log-num','#'+num));
  var meta = mkEl('div','log-meta');
  meta.appendChild(mkEl('div','log-title',(log.result&&log.result.jobTitle ? log.result.jobTitle+' @ '+(log.result.companyName||'?') : 'Auto-extraction')));
  meta.appendChild(mkEl('div','log-url',log.url||''));
  hdr.appendChild(meta);
  var right = mkEl('div','log-right');
  right.appendChild(mkEl('span','kind-pill pill-extract','Extract'));
  right.appendChild(mkEl('span','time-str',fmtTime(log.timestamp)));
  var chev = mkEl('div','chev','▶');
  right.appendChild(chev);
  hdr.appendChild(right);

  var body = mkEl('div','log-body');

  body.appendChild(mkStep('🔍','si1','Scrape Input',
    (log.inputWords||0)+' words · '+(log.inputChars||0)+' chars',
    function(b) {
      b.appendChild(mkBadge((log.inputWords||0)+' words','b-blue'));
      b.appendChild(mkBadge((log.inputChars||0)+' chars','b-blue'));
      if (log.model) b.appendChild(mkBadge(log.model,'b-gray'));
    },
    function(b2) {
      b2.appendChild(mkSection('Details', mkKV([['URL',log.url||'—'],['Model',log.model||'—'],['Input chars',log.inputChars||0]])));
      if (log.scrapePreview) { var t=log.scrapePreview; b2.appendChild(mkSection('Text Preview', mkCode(t), function(){return t;})); }
    }
  ));

  body.appendChild(mkStep('🤖','si2','AI Extraction',
    log.error ? 'Error' : ((log.result&&log.result.jobTitle)||'—')+' @ '+((log.result&&log.result.companyName)||'—'),
    function(b) {
      if (log.error) { b.appendChild(mkBadge('Error','b-red')); return; }
      if (log.result&&log.result.jobTitle)    b.appendChild(mkBadge(log.result.jobTitle,'b-ind'));
      if (log.result&&log.result.companyName) b.appendChild(mkBadge(log.result.companyName,'b-ind'));
    },
    function(b2) {
      if (log.error) b2.appendChild(mkSection('Error', mkErrBox(log.error)));
      if (log.result) b2.appendChild(mkSection('Result', mkKV([['Job Title',log.result.jobTitle],['Company',log.result.companyName]])));
      if (log.systemPrompt) { var sp=log.systemPrompt; b2.appendChild(mkSection('System Prompt',mkCode(sp),function(){return sp;})); }
      if (log.userPrompt)   { var up=log.userPrompt;   b2.appendChild(mkSection('User Prompt',  mkCode(up),function(){return up;})); }
      if (log.rawResponse)  { var rr=log.rawResponse;  b2.appendChild(mkSection('Raw AI Response',mkCode(rr),function(){return rr;})); }
    }
  ));

  hdr.addEventListener('click', function() {
    var o = body.classList.toggle('open');
    chev.classList.toggle('open', o);
  });
  card.appendChild(hdr); card.appendChild(body);
  return card;
}

// ─── Pipeline log card ────────────────────────────────────────────────────────
function buildPipelineCard(log, num) {
  var s2 = log.step2 || {};
  var p  = s2.parsed || {};
  var title   = p.jobTitle    || (log.step1&&log.step1.titleHint)   || 'Unknown Role';
  var company = p.companyName || (log.step1&&log.step1.companyHint) || 'Unknown Company';

  var card = mkEl('div','log-card');
  var hdr  = mkEl('div','log-hdr');
  hdr.appendChild(mkEl('span','log-num','#'+num));
  var meta = mkEl('div','log-meta');
  meta.appendChild(mkEl('div','log-title', title+' — '+company));
  meta.appendChild(mkEl('div','log-url', log.url||''));
  hdr.appendChild(meta);
  var right = mkEl('div','log-right');
  right.appendChild(mkEl('span','kind-pill pill-pipeline','Pipeline'));
  right.appendChild(mkEl('span','style-pill', log.style||'formal'));
  right.appendChild(mkEl('span','time-str', fmtTime(log.timestamp)));
  var chev = mkEl('div','chev','▶');
  right.appendChild(chev);
  hdr.appendChild(right);

  var body = mkEl('div','log-body');
  if (log.step1) body.appendChild(buildPipelineStep1(log));
  if (log.step2) body.appendChild(buildPipelineStep2(log));
  if (log.step3) body.appendChild(buildPipelineStep3(log));
  if (log.step4 || log.error) body.appendChild(buildPipelineStep4(log));

  hdr.addEventListener('click', function() {
    var o = body.classList.toggle('open');
    chev.classList.toggle('open', o);
  });
  card.appendChild(hdr); card.appendChild(body);
  return card;
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function renderStats() {
  var bar = document.getElementById('stats');
  bar.innerHTML = '';
  if (!allLogs.length) return;

  var pipelines = allLogs.filter(function(l){return l.kind==='pipeline';});
  var extracts  = allLogs.filter(function(l){return l.kind==='extract';});
  var companies = {};
  pipelines.forEach(function(l) {
    var co = (l.step2&&l.step2.parsed&&l.step2.parsed.companyName) || '?';
    companies[co] = 1;
  });

  [
    [allLogs.length,              'Total Events'],
    [pipelines.length,            'Pipelines'],
    [extracts.length,             'Extractions'],
    [Object.keys(companies).length,'Companies']
  ].forEach(function(item) {
    var s = mkEl('div','stat');
    s.appendChild(mkEl('div','stat-val',item[0]));
    s.appendChild(mkEl('div','stat-lbl',item[1]));
    bar.appendChild(s);
  });
}

// ─── Render logs ──────────────────────────────────────────────────────────────
function renderPanel(panelId, filterFn) {
  var panel = document.getElementById(panelId);
  panel.innerHTML = '';
  var filtered = allLogs.filter(filterFn);
  if (!filtered.length) {
    panel.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><div class="empty-text">No entries yet</div><div class="empty-sub">Generate a cover letter or open a job page to see logs</div></div>';
    return;
  }
  filtered.forEach(function(log, idx) {
    var num = filtered.length - idx;
    var card = log.kind === 'pipeline' ? buildPipelineCard(log, num) : buildExtractCard(log, num);
    panel.appendChild(card);
  });
}

function render() {
  renderStats();
  renderPanel('tab-all',      function(){ return true; });
  renderPanel('tab-pipeline', function(l){ return l.kind === 'pipeline'; });
  renderPanel('tab-extract',  function(l){ return l.kind === 'extract'; });
}

// ─── Export helpers ───────────────────────────────────────────────────────────
function csvEscape(v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }
function csvRow(arr)  { return arr.map(csvEscape).join(','); }
function csvSheet(name, rows) { return name + '\r\n' + rows.map(csvRow).join('\r\n'); }

function downloadBlob(content, filename, mime) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 5000);
}

// ─── Export: 6-section CSV (Excel opens each section as a named block) ────────
function exportCSV() {
  if (!allLogs.length) { alert('No logs to export.'); return; }

  var today     = new Date().toISOString().slice(0, 10);
  var pipelines = allLogs.filter(function(l) { return l.kind === 'pipeline'; });
  var extracts  = allLogs.filter(function(l) { return l.kind === 'extract';  });
  var sections  = [];

  // ── Section 1: Summary ──────────────────────────────────────────────────────
  var companies = {}, styles = {}, models = {};
  pipelines.forEach(function(l) {
    var co = (l.step2 && l.step2.parsed && l.step2.parsed.companyName) || 'Unknown';
    companies[co] = (companies[co] || 0) + 1;
    styles[l.style || 'formal']    = (styles[l.style || 'formal'] || 0) + 1;
    models[l.model || 'unknown']   = (models[l.model || 'unknown'] || 0) + 1;
  });
  var sumRows = [
    ['CoverCraft Export', today],
    [],
    ['SUMMARY'],
    ['Metric', 'Value'],
    ['Total Events',     allLogs.length],
    ['Pipelines Run',    pipelines.length],
    ['Auto-Extractions', extracts.length],
    ['Unique Companies', Object.keys(companies).length],
    [],
    ['TOP COMPANIES'],
    ['Company', 'Pipelines']
  ];
  Object.keys(companies).sort(function(a, b) { return companies[b] - companies[a]; }).slice(0, 10).forEach(function(co) {
    sumRows.push([co, companies[co]]);
  });
  sumRows.push([], ['STYLES USED'], ['Style', 'Count']);
  Object.keys(styles).forEach(function(s) { sumRows.push([s, styles[s]]); });
  sumRows.push([], ['MODELS USED'], ['Model', 'Count']);
  Object.keys(models).forEach(function(m) { sumRows.push([m, models[m]]); });
  sections.push(csvSheet('SUMMARY', sumRows));

  // ── Section 2: Pipelines ────────────────────────────────────────────────────
  var pHdr = ['#','Timestamp','Job Title','Company','Location','Seniority',
              'Keywords','Responsibilities','Requirements',
              'Style','Model','URL',
              'Scrape Words','Scrape Chars',
              'Extract Parse','Extract Status',
              'Tavily Skipped','Tavily Error','Tavily Sources Count',
              'Output Words','Output Chars','Pipeline Error'];
  var pRows = [pHdr];
  pipelines.forEach(function(l, i) {
    var s1 = l.step1 || {};
    var s2 = l.step2 || {};
    var s3 = l.step3 || {};
    var s4 = l.step4 || {};
    var p  = s2.parsed || {};
    pRows.push([
      pipelines.length - i,
      l.timestamp ? new Date(l.timestamp).toLocaleString() : '',
      p.jobTitle       || '',
      p.companyName    || '',
      p.location       || '',
      p.seniorityLevel || '',
      (p.keywords        || []).join('; '),
      (p.responsibilities || []).join(' | '),
      (p.requirements    || []).join(' | '),
      l.style  || '',
      l.model  || '',
      l.url    || '',
      s1.wordCount || 0,
      s1.charCount || 0,
      s2.parseNote || '',
      s2.status    || '',
      s3.skipped ? 'Yes' : 'No',
      s3.error   || '',
      (s3.sources || []).length,
      s4.outputWords || 0,
      s4.outputChars || 0,
      l.error || ''
    ]);
  });
  sections.push(csvSheet('PIPELINES', pRows));

  // ── Section 3: Tavily research detail ───────────────────────────────────────
  var tvHdr = ['#','Timestamp','Company','Job Title',
               'Query 1 (culture)','Query 2 (product)',
               'Summary (300 chars)','Sources Count',
               'Source Titles','Source URLs',
               'Skipped','Skip Reason','Error'];
  var tvRows = [tvHdr];
  pipelines.forEach(function(l, i) {
    var s2 = l.step2 || {};
    var s3 = l.step3 || {};
    var p  = s2.parsed || {};
    var srcTitles = (s3.sources || []).map(function(s) { return s.title || ''; }).join(' | ');
    var srcURLs   = (s3.sources || []).map(function(s) { return s.url   || ''; }).join(' | ');
    tvRows.push([
      pipelines.length - i,
      l.timestamp ? new Date(l.timestamp).toLocaleString() : '',
      p.companyName || '',
      p.jobTitle    || '',
      s3.query1 || '',
      s3.query2 || '',
      (s3.summary || '').slice(0, 300),
      (s3.sources || []).length,
      srcTitles.slice(0, 400),
      srcURLs.slice(0, 400),
      s3.skipped    ? 'Yes' : 'No',
      s3.skipReason || '',
      s3.error      || ''
    ]);
  });
  sections.push(csvSheet('TAVILY RESEARCH', tvRows));

  // ── Section 4: Cover letters (full text) ────────────────────────────────────
  var clHdr = ['#','Timestamp','Job Title','Company','Style','Model','Output Words','Cover Letter'];
  var clRows = [clHdr];
  pipelines.forEach(function(l, i) {
    var s2 = l.step2 || {};
    var s4 = l.step4 || {};
    var p  = s2.parsed || {};
    clRows.push([
      pipelines.length - i,
      l.timestamp ? new Date(l.timestamp).toLocaleString() : '',
      p.jobTitle    || '',
      p.companyName || '',
      l.style  || '',
      l.model  || '',
      s4.outputWords || 0,
      s4.rawResponse || l.output || ''
    ]);
  });
  sections.push(csvSheet('COVER LETTERS', clRows));

  // ── Section 5: AI prompts (system + user for each pipeline step) ─────────────
  var prHdr = ['#','Timestamp','Job Title','Company','Step','System Prompt (500 chars)','User Prompt (500 chars)','Raw Response (500 chars)'];
  var prRows = [prHdr];
  pipelines.forEach(function(l, i) {
    var idx = pipelines.length - i;
    var s2  = l.step2 || {};
    var s4  = l.step4 || {};
    var p   = s2.parsed || {};
    var ts  = l.timestamp ? new Date(l.timestamp).toLocaleString() : '';
    var title = p.jobTitle || ''; var co = p.companyName || '';
    if (s2.systemPrompt || s2.userPrompt) {
      prRows.push([idx, ts, title, co, 'Extract',
        (s2.systemPrompt || '').slice(0, 500),
        (s2.userPrompt   || '').slice(0, 500),
        (s2.rawResponse  || '').slice(0, 500)]);
    }
    if (s4.systemPrompt || s4.userPrompt) {
      prRows.push([idx, ts, title, co, 'Generate',
        (s4.systemPrompt || '').slice(0, 500),
        (s4.userPrompt   || '').slice(0, 500),
        (s4.rawResponse  || '').slice(0, 500)]);
    }
  });
  sections.push(csvSheet('AI PROMPTS', prRows));

  // ── Section 6: Auto-extractions (quick title+company scrapes) ───────────────
  var exHdr = ['#','Timestamp','URL','Job Title','Company','Input Words','Model','Error'];
  var exRows = [exHdr];
  extracts.forEach(function(l, i) {
    var res = l.result || {};
    exRows.push([
      extracts.length - i,
      l.timestamp ? new Date(l.timestamp).toLocaleString() : '',
      l.url    || '',
      res.jobTitle    || '',
      res.companyName || '',
      l.inputWords || 0,
      l.model  || '',
      l.error  || ''
    ]);
  });
  sections.push(csvSheet('AUTO-EXTRACTIONS', exRows));

  // Join sections with 3 blank lines between them — Excel reads each as a visual block
  var combined = sections.join('\r\n\r\n\r\n');
  downloadBlob(combined, 'CoverCraft_Export_' + today + '.csv', 'text/csv;charset=utf-8;');
}

// ─── Load & init ──────────────────────────────────────────────────────────────
function load() {
  chrome.runtime.sendMessage({ type: 'GET_LOGS' }, function(resp) {
    allLogs = (resp && resp.logs) ? resp.logs : [];
    render();
  });
}

// Tabs
document.querySelectorAll('.tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
    document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
    tab.classList.add('active');
    var panel = document.getElementById('tab-' + tab.dataset.tab);
    if (panel) panel.classList.add('active');
  });
});

document.getElementById('refresh-btn').addEventListener('click', load);
document.getElementById('export-btn').addEventListener('click', exportCSV);
document.getElementById('clear-btn').addEventListener('click', function() {
  if (confirm('Clear all CoverCraft logs?')) {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, function() {
      allLogs = [];
      render();
    });
  }
});

load();
