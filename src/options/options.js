var Core = window.CoverCraftCore;
var currentDraftSource = 'manual_editor';
var MAX_IMPORTED_RESUME_TEXT = 16000;
var MAX_IMPORT_PDF_BYTES = 5 * 1024 * 1024;
var MAX_IMPORT_IMAGE_BYTES = 8 * 1024 * 1024;
var MAX_IMAGE_DATA_URL_CHARS = Math.floor(1.8 * 1024 * 1024);
var currentModelHealth = {};
var modelHealthTickTimer = null;
var KNOWN_MODELS = Core.KNOWN_MODELS;
var GROQ_BASE_LIMITS = Core.GROQ_BASE_LIMITS;

function setStatus(id, type, message) {
  var el = document.getElementById(id);
  el.className = 'status' + (type ? ' ' + type : '');
  el.textContent = message || '';
}

function prettyPortfolio(portfolio) {
  return JSON.stringify(portfolio || {}, null, 2);
}

function limitResumeText(text, maxChars) {
  var cleaned = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  var limit = maxChars || MAX_IMPORTED_RESUME_TEXT;
  if (cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, limit).replace(/\s+\S*$/, '').trim() + '\n\n[truncated for import]';
}

function readFileAsText(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(String(reader.result || '')); };
    reader.onerror = function() { reject(new Error('Could not read file.')); };
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(String(reader.result || '')); };
    reader.onerror = function() { reject(new Error('Could not read image file.')); };
    reader.readAsDataURL(file);
  });
}

function validateImportFile(file, kind) {
  if (!file) throw new Error('No file selected.');
  if (kind === 'pdf' && file.size > MAX_IMPORT_PDF_BYTES) {
    throw new Error('This PDF is too large for the in-browser importer. Use a text-based PDF under 5 MB, or convert the resume into a JPG scan first.');
  }
  if (kind === 'image' && file.size > MAX_IMPORT_IMAGE_BYTES) {
    throw new Error('This image is too large for the in-browser importer. Use a clearer crop or a file under 8 MB.');
  }
}

function loadImageElement(dataUrl) {
  return new Promise(function(resolve, reject) {
    var image = new Image();
    image.onload = function() { resolve(image); };
    image.onerror = function() { reject(new Error('Could not decode the resume image.')); };
    image.src = dataUrl;
  });
}

async function optimizeImageDataUrl(file) {
  validateImportFile(file, 'image');
  var original = await readFileAsDataUrl(file);
  var image = await loadImageElement(original);
  var maxSide = 1600;
  var width = image.naturalWidth || image.width || 0;
  var height = image.naturalHeight || image.height || 0;
  if (!width || !height) throw new Error('Could not measure the resume image.');

  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return original;
  var quality = 0.86;
  var dataUrl = original;

  while (true) {
    var scale = Math.min(1, maxSide / Math.max(width, height));
    var targetWidth = Math.max(1, Math.round(width * scale));
    var targetHeight = Math.max(1, Math.round(height * scale));
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    dataUrl = canvas.toDataURL('image/jpeg', quality);
    if (dataUrl.length <= MAX_IMAGE_DATA_URL_CHARS || (maxSide <= 900 && quality <= 0.58)) break;
    if (quality > 0.62) quality -= 0.08;
    else maxSide = Math.max(900, maxSide - 220);
  }

  if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
    throw new Error('This image is still too large after compression. Crop the resume tighter or upload a simpler JPG scan.');
  }
  return dataUrl;
}

function readFileAsArrayBuffer(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(reader.result); };
    reader.onerror = function() { reject(new Error('Could not read PDF file.')); };
    reader.readAsArrayBuffer(file);
  });
}

function bytesToBinaryString(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function isWhiteSpaceCode(code) {
  return code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function isDelimiterChar(ch) {
  return ch === '(' || ch === ')' || ch === '<' || ch === '>' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === '/' || ch === '%';
}

function normalizePdfText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodePdfBytes(bytes, littleEndian) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 2) {
    var first = bytes[i] || 0;
    var second = bytes[i + 1] || 0;
    var code = littleEndian ? (second << 8) | first : (first << 8) | second;
    out += String.fromCharCode(code);
  }
  return out;
}

function decodeHexText(hex) {
  var clean = String(hex || '').replace(/\s+/g, '');
  if (!clean) return '';
  if (clean.length % 2) clean += '0';
  var bytes = [];
  for (var i = 0; i < clean.length; i += 2) {
    var pair = clean.slice(i, i + 2);
    var value = parseInt(pair, 16);
    if (isNaN(value)) return '';
    bytes.push(value);
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return decodePdfBytes(bytes.slice(2), false);
  }
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return decodePdfBytes(bytes.slice(2), true);
  }
  var out = '';
  for (var j = 0; j < bytes.length; j++) out += String.fromCharCode(bytes[j]);
  return out;
}

function parsePdfLiteralString(source, startIndex) {
  var out = '';
  var depth = 1;
  var i = startIndex + 1;
  while (i < source.length) {
    var ch = source.charAt(i++);
    if (ch === '\\') {
      if (i >= source.length) break;
      var next = source.charAt(i++);
      if (next === '\r') {
        if (source.charAt(i) === '\n') i++;
        continue;
      }
      if (next === '\n') continue;
      if (next === 'n') { out += '\n'; continue; }
      if (next === 'r') { out += '\r'; continue; }
      if (next === 't') { out += '\t'; continue; }
      if (next === 'b') { out += '\b'; continue; }
      if (next === 'f') { out += '\f'; continue; }
      if (next === '(' || next === ')' || next === '\\') { out += next; continue; }
      if (next >= '0' && next <= '7') {
        var oct = next;
        while (oct.length < 3 && i < source.length) {
          var peek = source.charAt(i);
          if (peek >= '0' && peek <= '7') {
            oct += peek;
            i++;
          } else {
            break;
          }
        }
        out += String.fromCharCode(parseInt(oct, 8));
        continue;
      }
      out += next;
      continue;
    }
    if (ch === '(') {
      depth++;
      out += ch;
      continue;
    }
    if (ch === ')') {
      depth--;
      if (depth === 0) break;
      out += ch;
      continue;
    }
    out += ch;
  }
  return { text: out, index: i };
}

function parsePdfHexString(source, startIndex) {
  var i = startIndex + 1;
  var hex = '';
  while (i < source.length) {
    var ch = source.charAt(i++);
    if (ch === '>') break;
    if (!isWhiteSpaceCode(ch.charCodeAt(0))) hex += ch;
  }
  return { text: decodeHexText(hex), index: i };
}

function parsePdfArray(source, startIndex) {
  var i = startIndex + 1;
  var items = [];
  while (i < source.length) {
    while (i < source.length) {
      var code = source.charCodeAt(i);
      if (isWhiteSpaceCode(code)) { i++; continue; }
      if (source.charAt(i) === '%') {
        while (i < source.length && source.charAt(i) !== '\n' && source.charAt(i) !== '\r') i++;
        continue;
      }
      break;
    }
    if (i >= source.length) break;
    var ch = source.charAt(i);
    if (ch === ']') {
      i++;
      break;
    }
    var token = parsePdfToken(source, i);
    if (!token) break;
    items.push(token);
    i = token.index;
  }
  return { items: items, index: i };
}

function parsePdfWord(source, startIndex) {
  var i = startIndex;
  var word = '';
  while (i < source.length) {
    var ch = source.charAt(i);
    if (isWhiteSpaceCode(ch.charCodeAt(0)) || isDelimiterChar(ch)) break;
    word += ch;
    i++;
  }
  var tokenType = /^[+\-]?(?:\d+\.?\d*|\.\d+)$/.test(word) ? 'number' : (/^[A-Za-z*'"]+$/.test(word) ? 'operator' : 'word');
  return { type: tokenType, value: word, index: i };
}

function parsePdfToken(source, startIndex) {
  var i = startIndex;
  while (i < source.length) {
    var code = source.charCodeAt(i);
    if (isWhiteSpaceCode(code)) { i++; continue; }
    if (source.charAt(i) === '%') {
      while (i < source.length && source.charAt(i) !== '\n' && source.charAt(i) !== '\r') i++;
      continue;
    }
    break;
  }
  if (i >= source.length) return null;

  var ch = source.charAt(i);
  if (ch === '(') {
    var literal = parsePdfLiteralString(source, i);
    return { type: 'string', value: literal.text, index: literal.index };
  }
  if (ch === '<' && source.charAt(i + 1) !== '<') {
    var hex = parsePdfHexString(source, i);
    return { type: 'string', value: hex.text, index: hex.index };
  }
  if (ch === '[') {
    var array = parsePdfArray(source, i);
    return { type: 'array', items: array.items, index: array.index };
  }
  if (ch === '/' || ch === '>' || ch === '{' || ch === '}') {
    return { type: 'word', value: ch, index: i + 1 };
  }
  return parsePdfWord(source, i);
}

function extractArrayText(items) {
  var text = '';
  var lastWasText = false;
  items.forEach(function(item) {
    if (item.type === 'string') {
      if (lastWasText && text && !/\s$/.test(text) && text.length && item.value && !/^[,.;:!?)]/.test(item.value)) {
        text += ' ';
      }
      text += item.value;
      lastWasText = true;
      return;
    }
    if (item.type === 'array') {
      var nested = extractArrayText(item.items || []);
      if (nested) {
        if (lastWasText && text && !/\s$/.test(text)) text += ' ';
        text += nested;
        lastWasText = true;
      }
      return;
    }
    if (item.type === 'number') {
      var adjustment = parseFloat(item.value);
      if (!isNaN(adjustment) && adjustment > 80 && text && !/\s$/.test(text)) text += ' ';
    }
  });
  return text;
}

function extractTextFromContentStream(source) {
  var i = 0;
  var operands = [];
  var chunks = [];
  var foundTextOperators = 0;

  while (i < source.length) {
    var token = parsePdfToken(source, i);
    if (!token) break;
    i = token.index;

    if (token.type === 'operator') {
      if (token.value === 'Tj' || token.value === "'" || token.value === '"') {
        var last = operands[operands.length - 1];
        if (last && last.type === 'string' && last.value) {
          chunks.push(last.value);
          foundTextOperators++;
        }
        operands = [];
        continue;
      }
      if (token.value === 'TJ') {
        var arrayOperand = operands[operands.length - 1];
        if (arrayOperand && arrayOperand.type === 'array') {
          var arrayText = extractArrayText(arrayOperand.items || []);
          if (arrayText) {
            chunks.push(arrayText);
            foundTextOperators++;
          }
        }
        operands = [];
        continue;
      }
      operands = token.value === 'ET' ? [] : operands;
      continue;
    }

    if (token.type === 'string' || token.type === 'array' || token.type === 'number' || token.type === 'word') {
      operands.push(token);
    }
  }

  return {
    text: normalizePdfText(chunks.join('\n')),
    textOperatorCount: foundTextOperators
  };
}

function findStreamChunks(raw) {
  var chunks = [];
  var regex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  var match;
  while ((match = regex.exec(raw))) {
    var prefix = raw.slice(Math.max(0, match.index - 300), match.index);
    var filter = /\/FlateDecode/.test(prefix) ? 'flate' : '';
    chunks.push({ content: match[1], filter: filter });
  }
  return chunks;
}

async function maybeDecompressStream(content, filter) {
  if (filter !== 'flate' || typeof DecompressionStream === 'undefined') return content;
  try {
    var bytes = new Uint8Array(content.length);
    for (var i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    var buffer = await new Response(stream).arrayBuffer();
    return bytesToBinaryString(new Uint8Array(buffer));
  } catch (_) {
    return content;
  }
}

function decodePdfText(buffer) {
  var raw = bytesToBinaryString(new Uint8Array(buffer));
  var streams = findStreamChunks(raw);
  var textBlocks = [];
  var textOperatorCount = 0;
  var sawImageMarkers = /\/Subtype\s*\/Image|\/Type\s*\/XObject|\/ImageB|\/ImageC|\/ImageI/.test(raw);

  function addExtracted(decoded) {
    var extracted = extractTextFromContentStream(decoded);
    if (extracted.text) textBlocks.push(extracted.text);
    textOperatorCount += extracted.textOperatorCount;
  }

  var chain = Promise.resolve();
  streams.forEach(function(stream) {
    chain = chain.then(function() {
      return maybeDecompressStream(stream.content, stream.filter).then(function(decoded) {
        addExtracted(decoded);
      });
    });
  });

  return chain.then(function() {
    if (!textBlocks.length) {
      var fallback = extractTextFromContentStream(raw);
      if (fallback.text) textBlocks.push(fallback.text);
      textOperatorCount += fallback.textOperatorCount;
    }

    var text = limitResumeText(textBlocks.join('\n\n'), MAX_IMPORTED_RESUME_TEXT);
    if (text.length >= 80) return text;

    if (sawImageMarkers && !textOperatorCount) {
      throw new Error('This PDF looks like a scanned or image-only file. It does not contain embedded text, so CoverCraft cannot extract the resume automatically. Please upload a text-based PDF or use a JPG/PNG scan instead.');
    }

    if (!textOperatorCount) {
      throw new Error('Could not find embedded text in this PDF. The file may use unsupported encoding or be image-only. Try a text-based PDF or upload a resume image instead.');
    }

    throw new Error('CoverCraft found only a small amount of embedded text in this PDF. The file may be flattened or heavily encoded. Try a different PDF or upload a resume image instead.');
  });
}

function renderValidation(validation, sourceLabel) {
  var sourceText = document.getElementById('portfolio-source-text');
  sourceText.textContent = sourceLabel || 'Local file or imported profile';

  var chips = document.getElementById('portfolio-validation');
  chips.innerHTML = '';
  if (!validation) return;
  if (!validation.errors.length && !validation.warnings.length) {
    chips.appendChild(chip('Profile looks complete', ''));
  }
  validation.errors.forEach(function(item) {
    chips.appendChild(chip(item, 'err'));
  });
  validation.warnings.forEach(function(item) {
    chips.appendChild(chip(item, 'warn'));
  });
}

function chip(text, kind) {
  var el = document.createElement('span');
  el.className = 'chip' + (kind ? ' ' + kind : '');
  el.textContent = text;
  return el;
}

function flashButtonSuccess(button, successText, originalText) {
  if (!button) return;
  var previous = originalText || button.dataset.originalText || button.textContent;
  button.dataset.originalText = previous;
  button.disabled = true;
  button.textContent = successText || '✓ Synced';
  clearTimeout(button._covercraftFlashTimer);
  button._covercraftFlashTimer = setTimeout(function() {
    button.textContent = previous;
    button.disabled = false;
  }, 1600);
}

function bindById(id, eventName, handler) {
  var el = document.getElementById(id);
  if (!el) return null;
  el.addEventListener(eventName, handler);
  return el;
}

function collectRateLimitHeaders(response) {
  return {
    retryAfter: response.headers.get('retry-after') || '',
    limitRequests: response.headers.get('x-ratelimit-limit-requests') || '',
    limitTokens: response.headers.get('x-ratelimit-limit-tokens') || '',
    remainingRequests: response.headers.get('x-ratelimit-remaining-requests') || '',
    remainingTokens: response.headers.get('x-ratelimit-remaining-tokens') || '',
    resetRequests: response.headers.get('x-ratelimit-reset-requests') || '',
    resetTokens: response.headers.get('x-ratelimit-reset-tokens') || ''
  };
}

function formatTimeLeft(ms) {
  if (!ms || ms <= 0) return '';
  var seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return seconds + 's';
  return Math.ceil(seconds / 60) + 'm';
}

function formatHealthTimestamp(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (_) {
    return '';
  }
}

function modelLabel(model) {
  var select = document.getElementById('model-select');
  if (!select) return model;
  var option = Array.prototype.slice.call(select.options).find(function(item) {
    return item.value === model;
  });
  return option ? option.textContent.replace(/^[🟢🟡🔴⚪]\s+/u, '').replace(/\s+\(wait .*?\)$/i, '') : model;
}

function renderModelHealth() {
  var list = document.getElementById('model-health-list');
  if (!list) return;
  scheduleModelHealthTicker();
  var selected = selectedModel();
  list.innerHTML = '';
  var models = KNOWN_MODELS.filter(function(model) {
    return /^groq\//.test(model) || model === selected || Core.lookupModelHealth(currentModelHealth, model);
  });
  if (models.indexOf(selected) === -1) models.unshift(selected);
  models.forEach(function(model) {
    var health = Core.lookupModelHealth(currentModelHealth, model);
    var availability = Core.modelAvailability(health);
    var row = document.createElement('div');
    var badge = document.createElement('div');
    var body = document.createElement('div');
    var title = document.createElement('strong');
    var detail = document.createElement('span');
    var meter = document.createElement('div');
    var meterFill = document.createElement('span');
    var waitMs = health && health.blockedUntil ? health.blockedUntil - Date.now() : 0;
    var rate = health && health.rateLimit || {};
    row.className = 'model-health-row';
    row.classList.add(availability.tone);
    badge.className = 'model-health-badge';
    meter.className = 'model-health-meter';
    meterFill.className = 'model-health-meter-fill';
    if (availability.percent != null) meterFill.style.width = availability.percent + '%';
    meter.appendChild(meterFill);
    title.textContent = modelLabel(model);
    if (!health) {
      badge.textContent = 'Unknown';
      detail.textContent = /^groq\//.test(model)
        ? 'No previous provider status recorded for this model.'
        : 'No previous provider status recorded. OpenRouter availability depends on route.';
    } else if (waitMs > 0 && (health.status === 429 || health.status === 413)) {
      badge.textContent = 'Wait ' + formatTimeLeft(waitMs);
      detail.textContent = [
        availability.percent != null ? availability.percent + '% ' + (availability.source || 'capacity') + ' available' : '',
        formatHealthTimestamp(health.checkedAt) ? 'checked ' + formatHealthTimestamp(health.checkedAt) : '',
        rate.remainingTokens ? rate.remainingTokens + ' TPM left' : '',
        rate.limitTokens ? rate.limitTokens + ' TPM limit' : '',
        rate.resetTokens ? 'reset ' + rate.resetTokens : '',
        health.totalTokens ? 'actual ' + health.totalTokens + ' tokens' : '',
        health.estimatedTokens ? 'last ~' + health.estimatedTokens + ' tokens' : ''
      ].filter(Boolean).join(' · ') || (health.error || 'Provider asked us to wait.');
    } else if (health.ok) {
      badge.textContent = availability.label;
      detail.textContent = [
        availability.percent != null ? availability.percent + '% ' + (availability.source || 'capacity') + ' available' : '',
        formatHealthTimestamp(health.checkedAt) ? 'checked ' + formatHealthTimestamp(health.checkedAt) : '',
        rate.remainingTokens ? rate.remainingTokens + ' TPM left' : '',
        rate.limitTokens ? rate.limitTokens + ' TPM limit' : '',
        rate.remainingRequests ? rate.remainingRequests + ' daily requests left' : '',
        health.totalTokens ? 'actual ' + health.totalTokens + ' tokens' : '',
        health.estimatedTokens ? 'last ~' + health.estimatedTokens + ' tokens' : ''
      ].filter(Boolean).join(' · ') || 'Last request succeeded.';
    } else {
      badge.textContent = health.status === 429 ? 'Limited' : (health.status === 413 ? 'Too large' : 'Error');
      detail.textContent = [
        availability.percent != null ? availability.percent + '% ' + (availability.source || 'capacity') + ' available' : '',
        formatHealthTimestamp(health.checkedAt) ? 'checked ' + formatHealthTimestamp(health.checkedAt) : '',
        rate.remainingTokens ? rate.remainingTokens + ' TPM left' : '',
        rate.limitTokens ? rate.limitTokens + ' TPM limit' : '',
        rate.resetTokens ? 'reset ' + rate.resetTokens : '',
        health.totalTokens ? 'actual ' + health.totalTokens + ' tokens' : '',
        health.error || ''
      ].filter(Boolean).join(' · ') || 'Last request failed.';
    }
    body.appendChild(title);
    body.appendChild(detail);
    body.appendChild(meter);
    row.appendChild(body);
    row.appendChild(badge);
    list.appendChild(row);
  });
  updateModelOptionAvailability();
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
  modelHealthTickTimer = setTimeout(function() {
    modelHealthTickTimer = null;
    loadSettings();
  }, nextModelCooldownDelay());
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
    .replace(/\s+\(wait .*?\)$/i, '');
}

function updateModelOptionAvailability() {
  var select = document.getElementById('model-select');
  if (!select) return;
  Array.prototype.slice.call(select.options).forEach(function(option) {
    option.dataset.baseLabel = cleanModelOptionLabel(option);
    option.disabled = false;
    option.textContent = option.dataset.baseLabel;
    option.title = '';
  });
}

function recordModelHealth(model, provider, apiModel, response, data, estimatedTokens) {
  var rateLimit = collectRateLimitHeaders(response);
  var modelTokenLimit = Core.numericHeaderValue(rateLimit.limitTokens);
  var usageTokens = data && data.usage && data.usage.total_tokens || estimatedTokens || 0;
  var actualOutputTokens = data && data.usage && data.usage.completion_tokens || 0;
  var errorMessage = data && data.error && data.error.message || '';
  chrome.runtime.sendMessage({
    type: 'RECORD_MODEL_HEALTH',
    payload: {
      model: model,
      provider: provider,
      apiModel: apiModel,
      ok: response.ok,
      status: response.status,
      error: errorMessage,
      rateLimit: rateLimit,
      limitKind: providerLimitKind(errorMessage, rateLimit),
      estimatedTokens: estimatedTokens || 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: actualOutputTokens ? 0 : estimatedTokens || 0,
      requestedOutputTokens: estimatedTokens || 0,
      modelUsageTokens: usageTokens,
      modelTokenLimit: modelTokenLimit || null,
      modelUsagePercent: modelTokenLimit ? Math.round((usageTokens / modelTokenLimit) * 1000) / 10 : null,
      usageSource: data && data.usage && data.usage.total_tokens ? 'provider' : 'estimate',
      inputTokens: data && data.usage && data.usage.prompt_tokens || 0,
      outputTokens: data && data.usage && data.usage.completion_tokens || 0,
      totalTokens: data && data.usage && data.usage.total_tokens || 0
    }
  }, function(recorded) {
    if (recorded && recorded.modelHealth) {
      currentModelHealth = recorded.modelHealth;
      renderModelHealth();
    }
  });
}

function providerLimitKind(message, rate) {
  var text = String(message || '').toLowerCase();
  rate = rate || {};
  if (/tokens per day|daily token|tpd/.test(text)) return 'daily_tokens';
  if (/requests per day|daily request|rpd/.test(text)) return 'daily_requests';
  if (/tokens per minute|tpm/.test(text)) return 'minute_tokens';
  if (/requests per minute|rpm/.test(text)) return 'minute_requests';
  if (Core.numericHeaderValue(rate.remainingTokens) === 0 && Core.numericHeaderValue(rate.limitTokens) > 0) return 'minute_tokens';
  if (Core.numericHeaderValue(rate.remainingRequests) === 0 && Core.numericHeaderValue(rate.limitRequests) > 0) return 'minute_requests';
  return '';
}

function selectedModel() {
  var model = document.getElementById('model-select').value;
  if (model === 'custom') {
    return document.getElementById('custom-model-input').value.trim() || 'openrouter/free';
  }
  return model;
}

function isGroqModel(model) {
  return /^groq\//.test(String(model || '').trim());
}

function selectedOpenRouterTestModel() {
  var model = selectedModel();
  return isGroqModel(model) ? 'openrouter/free' : model;
}

function selectedGroqTestModel() {
  var model = selectedModel();
  if (model === 'groq/compound' || model === 'groq/compound-mini') return model;
  return isGroqModel(model) ? model.replace(/^groq\//, '') : 'llama-3.1-8b-instant';
}

function buildGroqTestBody(model) {
  var body = {
    model: model,
    messages: [{ role: 'user', content: 'Reply with exactly OK' }],
    max_completion_tokens: 10,
    top_p: 1,
    stream: false,
    stop: null
  };
  if (model === 'groq/compound' || model === 'groq/compound-mini') {
    body.compound_custom = {
      tools: {
        enabled_tools: ['web_search', 'code_interpreter', 'visit_website']
      }
    };
  }
  return body;
}

function setCloudActionState(cloud) {
  var signInBtn = document.getElementById('cloud-sign-in-btn');
  var syncBtn = document.getElementById('cloud-sync-btn');
  var signOutBtn = document.getElementById('cloud-sign-out-btn');
  var configured = !!(cloud && cloud.configured);
  var signedIn = !!(cloud && cloud.signedIn);
  var syncEnabled = !!(cloud && cloud.enabled);

  if (signInBtn) {
    signInBtn.classList.toggle('hidden', configured && signedIn);
    signInBtn.disabled = !configured || signedIn;
  }
  if (syncBtn) {
    syncBtn.classList.toggle('hidden', !configured || !signedIn);
    syncBtn.disabled = !configured || !signedIn || !syncEnabled;
  }
  if (signOutBtn) {
    signOutBtn.classList.toggle('hidden', !configured || !signedIn);
    signOutBtn.disabled = !configured || !signedIn;
  }
}

function loadSettings() {
  chrome.runtime.sendMessage({ type: 'GET_PRIVATE_SETTINGS' }, function(response) {
    var settings = response && response.settings || {};
    document.getElementById('openrouter-key').value = settings.openrouterKey || '';
    document.getElementById('groq-key').value = settings.groqKey || '';
    document.getElementById('tavily-key').value = settings.tavilyKey || '';
    document.getElementById('default-type').value = settings.coverLetterType || 'formal';
    document.getElementById('trigger-mode').value = settings.triggerMode || 'manual';
    document.getElementById('cloud-sync-enabled').checked = !!settings.cloudSyncEnabled;
    currentModelHealth = response && response.modelHealth || {};
    if (KNOWN_MODELS.indexOf(settings.model) !== -1) {
      document.getElementById('model-select').value = settings.model;
      document.getElementById('custom-model-input').value = '';
    } else {
      document.getElementById('model-select').value = 'custom';
      document.getElementById('custom-model-input').value = settings.model || '';
    }
    renderModelHealth();
    renderCloudStatus(response && response.cloud || null, response && response.storage || null);
  });

  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PORTFOLIO' }, function(response) {
    if (!response) return;
    document.getElementById('portfolio-editor').value = prettyPortfolio(response.portfolio);
    currentDraftSource = response.source || 'local_file';
    renderValidation(response.validation, 'Active source: ' + (response.source || 'local_file'));
    if (response.draft && response.draft.portfolio) {
      document.getElementById('portfolio-editor').value = prettyPortfolio(response.draft.portfolio);
      currentDraftSource = response.draft.source || currentDraftSource;
      renderValidation({
        errors: response.draft.errors || [],
        warnings: response.draft.warnings || []
      }, 'Draft source: ' + currentDraftSource);
    }
  });
}

async function testOpenRouter() {
  var key = document.getElementById('openrouter-key').value.trim();
  if (!key) {
    setStatus('openrouter-status', 'error', 'Enter an API key first.');
    return;
  }
  var testedModel = selectedOpenRouterTestModel();
  setStatus('openrouter-status', 'loading', 'Testing OpenRouter…');
  try {
    var response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://covercraft.extension',
        'X-Title': 'CoverCraft Settings Test'
      },
      body: JSON.stringify({
        model: testedModel,
        messages: [{ role: 'user', content: 'Reply with exactly OK' }],
        max_tokens: 10
      })
    });
    var data = await response.json();
    recordModelHealth(testedModel, 'openrouter', testedModel, response, data, 10);
    if (data.choices && data.choices[0] && data.choices[0].message) setStatus('openrouter-status', 'ok', 'OpenRouter is working for ' + testedModel + '.');
    else throw new Error((data.error && data.error.message) || 'Unexpected response.');
  } catch (err) {
    setStatus('openrouter-status', 'error', err.message);
  }
}

async function testGroq() {
  var key = document.getElementById('groq-key').value.trim();
  if (!key) {
    setStatus('groq-status', 'error', 'Enter a Groq key first.');
    return;
  }
  var testedModel = selectedGroqTestModel();
  setStatus('groq-status', 'loading', 'Testing Groq…');
  try {
    var response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + key,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(buildGroqTestBody(testedModel))
    });
    var data = await response.json();
    recordModelHealth(isGroqModel(selectedModel()) ? selectedModel() : 'groq/' + testedModel, 'groq', testedModel, response, data, 10);
    if (data.choices && data.choices[0] && data.choices[0].message) setStatus('groq-status', 'ok', 'Groq is working for ' + testedModel + '.');
    else throw new Error((data.error && data.error.message) || 'Unexpected response.');
  } catch (err) {
    setStatus('groq-status', 'error', err.message);
  }
}

async function testTavily() {
  var key = document.getElementById('tavily-key').value.trim();
  if (!key) {
    setStatus('tavily-status', 'error', 'Enter a Tavily key first.');
    return;
  }
  setStatus('tavily-status', 'loading', 'Testing Tavily…');
  try {
    var response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ api_key: key, query: 'CoverCraft test', max_results: 1, search_depth: 'basic' })
    });
    if (!response.ok) {
      var err = await response.json().catch(function() { return {}; });
      throw new Error(err.detail || err.message || ('HTTP ' + response.status));
    }
    setStatus('tavily-status', 'ok', 'Tavily is working.');
  } catch (err) {
    setStatus('tavily-status', 'error', err.message);
  }
}

function saveRuntimeSettings() {
  var providerKeys = {
    openrouterKey: document.getElementById('openrouter-key').value.trim(),
    groqKey: document.getElementById('groq-key').value.trim(),
    tavilyKey: document.getElementById('tavily-key').value.trim()
  };
  var runtimeSettings = {
    model: document.getElementById('model-select').value === 'custom' ? 'custom' : document.getElementById('model-select').value,
    customModel: document.getElementById('custom-model-input').value.trim(),
    coverLetterType: document.getElementById('default-type').value,
    triggerMode: document.getElementById('trigger-mode').value,
    cloudSyncEnabled: document.getElementById('cloud-sync-enabled').checked
  };

  chrome.storage.local.set(providerKeys, function() {
    if (chrome.runtime.lastError) {
      setStatus('save-status', 'error', chrome.runtime.lastError.message || 'Could not save provider keys.');
      return;
    }
    chrome.storage.sync.remove(['openrouterKey', 'groqKey', 'tavilyKey'], function() {
      if (chrome.runtime.lastError) {
        setStatus('save-status', 'error', chrome.runtime.lastError.message || 'Could not remove legacy synced keys.');
        return;
      }
      chrome.storage.sync.set(runtimeSettings, function() {
        if (chrome.runtime.lastError) {
          setStatus('save-status', 'error', chrome.runtime.lastError.message || 'Could not save runtime settings.');
          return;
        }
        chrome.runtime.sendMessage({ type: 'RELOAD_CONFIG' }, function() {
          setStatus('save-status', 'ok', 'Runtime settings saved.');
          if (document.getElementById('cloud-sync-enabled').checked) {
            chrome.runtime.sendMessage({ type: 'SYNC_CLOUD_NOW' }, function() {
              loadCloudStatus();
            });
          } else {
            loadCloudStatus();
          }
          setTimeout(function() { setStatus('save-status', '', ''); }, 2200);
        });
      });
    });
  });
}

function loadCurrentPortfolio() {
  chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PORTFOLIO' }, function(response) {
    if (!response) return;
    document.getElementById('portfolio-editor').value = prettyPortfolio(response.portfolio);
    currentDraftSource = response.source || 'local_file';
    renderValidation(response.validation, 'Active source: ' + currentDraftSource);
    setStatus('portfolio-status', 'ok', 'Loaded current portfolio.');
  });
}

function applyPortfolioDraft() {
  var text = document.getElementById('portfolio-editor').value.trim();
  if (!text) {
    setStatus('portfolio-status', 'error', 'There is no draft to apply.');
    return;
  }
  try {
    var parsed = JSON.parse(text);
    chrome.runtime.sendMessage({
      type: 'SAVE_ACTIVE_PORTFOLIO',
      payload: {
        portfolio: parsed,
        source: currentDraftSource || 'manual_editor'
      }
    }, function(response) {
      if (!response || response.error) {
        setStatus('portfolio-status', 'error', response && response.error || 'Could not save portfolio.');
        return;
      }
      renderValidation(response.validation, 'Active source: ' + (currentDraftSource || 'manual_editor'));
      setStatus('portfolio-status', response.validation.ok ? 'ok' : 'error', response.validation.ok ? 'Portfolio applied.' : 'Portfolio saved with errors. Review the warnings above.');
    });
  } catch (_) {
    setStatus('portfolio-status', 'error', 'Draft JSON is invalid.');
  }
}

function handleImportedDraft(response, successLabel) {
  if (!response || response.error) {
    setStatus('portfolio-status', 'error', response && response.error || 'Import failed.');
    return;
  }
  var draft = response.draft;
  document.getElementById('portfolio-editor').value = prettyPortfolio(draft.portfolio);
  currentDraftSource = draft.source || 'imported';
  renderValidation({
    errors: draft.errors || [],
    warnings: draft.warnings || []
  }, 'Draft source: ' + currentDraftSource);
  setStatus('portfolio-status', 'ok', successLabel);
}

function storageStatusSummary(storage) {
  if (!storage) return '';
  var used = storage.usedBytes >= 1024 * 1024 ? (Math.round(storage.usedBytes / 1024 / 102.4) / 10) + ' MB' : Math.round(storage.usedBytes / 1024) + ' KB';
  var quota = storage.quotaBytes ? (storage.quotaBytes >= 1024 * 1024 ? (Math.round(storage.quotaBytes / 1024 / 102.4) / 10) + ' MB' : Math.round(storage.quotaBytes / 1024) + ' KB') : '';
  return 'Local storage ' + storage.state + ': ' + used + (quota ? ' / ' + quota : '') + (storage.percentUsed != null ? ' (' + storage.percentUsed + '%)' : '') + (storage.writable ? '' : ' · write blocked');
}

function renderCloudStatus(cloud, storage) {
  var summary = document.getElementById('cloud-auth-summary');
  var chips = document.getElementById('cloud-auth-chips');
  if (!summary || !chips) return;

  chips.innerHTML = '';
  if (!cloud || !cloud.configured) {
    summary.textContent = 'Account sign-in is not configured yet.';
    chips.appendChild(chip('Firebase config missing', 'err'));
    setCloudActionState(cloud || null);
    return;
  }

  if (cloud.signedIn && cloud.user) {
    summary.textContent = (cloud.user.displayName || 'Signed in') + (cloud.user.email ? ' — ' + cloud.user.email : '');
    chips.appendChild(chip('Google connected', ''));
    if (cloud.enabled) chips.appendChild(chip('Cloud sync enabled', ''));
    if (cloud.lastSyncedAt) chips.appendChild(chip('Last sync saved', ''));
  } else {
    summary.textContent = 'Sign in with Google to sync your sessions and portfolio.';
    chips.appendChild(chip('Signed out', 'warn'));
  }
  if (cloud.lastError) chips.appendChild(chip(cloud.lastError, 'err'));
  if (storage) chips.appendChild(chip(storageStatusSummary(storage), storage.writable && storage.state !== 'full' ? '' : 'err'));
  setCloudActionState(cloud || null);
}

function loadCloudStatus() {
  chrome.runtime.sendMessage({ type: 'GET_CLOUD_STATUS' }, function(response) {
    if (!response || response.error) {
      setStatus('cloud-auth-status', 'error', response && response.error || 'Could not load cloud status.');
      return;
    }
    renderCloudStatus(response.cloud || null, response.storage || null);
  });
}

function signInToCloud() {
  var signInBtn = document.getElementById('cloud-sign-in-btn');
  if (signInBtn) signInBtn.disabled = true;
  setStatus('cloud-auth-status', 'loading', 'Opening Google sign-in...');
  chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN' }, function(response) {
    if (signInBtn) signInBtn.disabled = false;
    if (!response || response.error) {
      setStatus('cloud-auth-status', 'error', response && response.error || 'Google sign-in failed.');
      loadCloudStatus();
      return;
    }
    renderCloudStatus(response.cloud || null, response.storage || null);
    setStatus('cloud-auth-status', response.syncPending ? 'loading' : 'ok', response.syncPending ? 'Signed in. Syncing sessions and profile in the background...' : 'Signed in.');
    loadSettings();
  });
}

function signOutOfCloud() {
  setStatus('cloud-auth-status', 'loading', 'Signing out…');
  chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_OUT' }, function(response) {
    if (!response || response.error) {
      setStatus('cloud-auth-status', 'error', response && response.error || 'Could not sign out.');
      return;
    }
    renderCloudStatus(response.cloud || null, response.storage || null);
    setStatus('cloud-auth-status', 'ok', 'Signed out.');
    loadSettings();
  });
}

function syncCloudNow() {
  var syncBtn = document.getElementById('cloud-sync-btn');
  var original = syncBtn ? syncBtn.textContent : 'Sync Now';
  if (syncBtn) {
    syncBtn.dataset.originalText = original;
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing…';
  }
  setStatus('cloud-auth-status', 'loading', 'Syncing sessions and portfolio…');
  chrome.runtime.sendMessage({ type: 'SYNC_CLOUD_NOW' }, function(response) {
    if (!response || response.error) {
      if (syncBtn) {
        syncBtn.textContent = original;
        syncBtn.disabled = false;
      }
      setStatus('cloud-auth-status', 'error', response && response.error || 'Could not sync cloud state.');
      loadCloudStatus();
      return;
    }
    renderCloudStatus(response.cloud || null, response.storage || null);
    var count = response && response.result && typeof response.result.count === 'number' ? response.result.count : null;
    setStatus('cloud-auth-status', 'ok', count != null ? ('Synced ' + count + ' session' + (count === 1 ? '' : 's') + ' to Firebase.') : 'Synced to Firebase.');
    flashButtonSuccess(syncBtn, '✓ Synced', original);
  });
}

async function handleJsonUpload(event) {
  var input = event && event.target ? event.target : null;
  var file = input && input.files ? input.files[0] : null;
  if (!file) return;
  setStatus('portfolio-status', 'loading', 'Importing portfolio JSON…');
  try {
    var text = await readFileAsText(file);
    chrome.runtime.sendMessage({ type: 'IMPORT_PORTFOLIO_JSON', payload: { text: text } }, function(response) {
      handleImportedDraft(response, 'JSON imported. Review the draft and apply it when ready.');
    });
  } catch (err) {
    setStatus('portfolio-status', 'error', err.message);
  } finally {
    if (input) input.value = '';
  }
}

async function handlePdfUpload(event) {
  var input = event && event.target ? event.target : null;
  var file = input && input.files ? input.files[0] : null;
  if (!file) return;
  try {
    validateImportFile(file, 'pdf');
  } catch (err) {
    setStatus('portfolio-status', 'error', err.message);
    if (input) input.value = '';
    return;
  }
  setStatus('portfolio-status', 'loading', 'Reading PDF and building a draft portfolio…');
  try {
    var buffer = await readFileAsArrayBuffer(file);
    var text = await decodePdfText(buffer);
    chrome.runtime.sendMessage({
      type: 'IMPORT_PORTFOLIO_TEXT',
      payload: {
        text: text,
        source: 'resume_pdf'
      }
    }, function(response) {
      handleImportedDraft(response, 'PDF imported. Review the generated draft before applying it.');
    });
  } catch (err) {
    setStatus('portfolio-status', 'error', err.message);
  } finally {
    if (input) input.value = '';
  }
}

async function handleImageUpload(event) {
  var input = event && event.target ? event.target : null;
  var file = input && input.files ? input.files[0] : null;
  if (!file) return;
  setStatus('portfolio-status', 'loading', 'Uploading image to generate a draft portfolio…');
  try {
    var dataUrl = await optimizeImageDataUrl(file);
    chrome.runtime.sendMessage({
      type: 'IMPORT_PORTFOLIO_IMAGE',
      payload: { dataUrl: dataUrl }
    }, function(response) {
      handleImportedDraft(response, 'Resume image imported. Review the generated draft before applying it.');
    });
  } catch (err) {
    setStatus('portfolio-status', 'error', err.message);
  } finally {
    if (input) input.value = '';
  }
}

document.addEventListener('DOMContentLoaded', function() {
  loadSettings();

  bindById('test-openrouter-btn', 'click', testOpenRouter);
  bindById('test-groq-btn', 'click', testGroq);
  bindById('test-tavily-btn', 'click', testTavily);
  bindById('save-btn', 'click', saveRuntimeSettings);
  bindById('refresh-model-health-btn', 'click', loadSettings);
  bindById('model-select', 'change', renderModelHealth);
  bindById('cloud-sign-in-btn', 'click', signInToCloud);
  bindById('cloud-sync-btn', 'click', syncCloudNow);
  bindById('cloud-sign-out-btn', 'click', signOutOfCloud);
  try {
    chrome.runtime.onMessage.addListener(function(message) {
      if (!message) return;
      if (message.type === 'MODEL_HEALTH_UPDATE') {
        currentModelHealth = message.modelHealth || {};
        renderModelHealth();
        return;
      }
      if (message.type !== 'CLOUD_STATUS_UPDATE') return;
      renderCloudStatus(message.cloud || null, message.storage || null);
      if (message.error) {
        setStatus('cloud-auth-status', 'error', message.error);
        return;
      }
      if (message.syncResult) {
        var count = typeof message.syncResult.count === 'number' ? message.syncResult.count : null;
        setStatus('cloud-auth-status', 'ok', count != null ? ('Signed in. Synced ' + count + ' session' + (count === 1 ? '' : 's') + '.') : 'Signed in. Cloud sync complete.');
      }
    });
  } catch (_) {}
  bindById('apply-portfolio-btn', 'click', applyPortfolioDraft);
  bindById('load-current-btn', 'click', loadCurrentPortfolio);

  bindById('upload-json-btn', 'click', function() {
    var input = document.getElementById('json-input');
    if (input) input.click();
  });
  bindById('upload-pdf-btn', 'click', function() {
    var input = document.getElementById('pdf-input');
    if (input) input.click();
  });
  bindById('upload-image-btn', 'click', function() {
    var input = document.getElementById('image-input');
    if (input) input.click();
  });

  bindById('json-input', 'change', handleJsonUpload);
  bindById('pdf-input', 'change', handlePdfUpload);
  bindById('image-input', 'change', handleImageUpload);
  loadCloudStatus();
});
