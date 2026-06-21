(function(global) {
  'use strict';

	  var KNOWN_MODELS = [
	    'openrouter/free',
	    'google/gemma-3-12b-it:free',
	    'meta-llama/llama-3.3-70b-instruct:free',
	    'nvidia/nemotron-3-super-120b-a12b:free',
	    'minimax/minimax-m2.5:free',
	    'openai/gpt-5.3-codex',
	    'openai/gpt-5.2',
	    'openai/gpt-5.2-pro',
	    'openai/gpt-5.1',
	    'openai/gpt-5',
	    'openai/gpt-5-mini',
	    'openai/gpt-5-nano',
	    'openai/gpt-5-pro',
	    'openai/o3-pro',
	    'openai/o3',
	    'openai/gpt-4.1',
	    'openai/gpt-4.1-mini',
	    'openai/gpt-4o-mini',
	    'groq/llama-3.1-8b-instant',
    'groq/llama-3.3-70b-versatile',
    'groq/openai/gpt-oss-120b',
    'groq/openai/gpt-oss-20b',
    'groq/meta-llama/llama-4-scout-17b-16e-instruct',
    'groq/qwen/qwen3-32b',
    'groq/compound-mini',
    'groq/compound'
  ];
	  var GROQ_BASE_LIMITS = {
    'groq/llama-3.1-8b-instant': { tpm: '6K', rpd: '14.4K' },
    'groq/llama-3.3-70b-versatile': { tpm: '12K', rpd: '1K' },
    'groq/openai/gpt-oss-120b': { tpm: '8K', rpd: '1K' },
    'groq/openai/gpt-oss-20b': { tpm: '8K', rpd: '1K' },
    'groq/meta-llama/llama-4-scout-17b-16e-instruct': { tpm: '30K', rpd: '1K' },
    'groq/qwen/qwen3-32b': { tpm: '6K', rpd: '1K' },
    'groq/compound-mini': { tpm: '70K', rpd: '250' },
    'groq/compound': { tpm: '70K', rpd: '250' }
	  };

	  function providerForModel(model) {
	    var value = String(model || '').trim();
	    if (/^groq\//i.test(value)) return 'groq';
	    if (/^openai\//i.test(value)) return 'openai';
	    return 'openrouter';
	  }

	  function apiModelForProvider(model) {
	    var value = String(model || '').trim();
	    var provider = providerForModel(value);
	    if (provider === 'groq') {
	      if (value === 'groq/compound' || value === 'groq/compound-mini') return value;
	      return value.replace(/^groq\//i, '');
	    }
	    if (provider === 'openai') return value.replace(/^openai\//i, '');
	    return value;
	  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function shortHash(input) {
    var str = String(input || '');
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & 0xffffffff;
    }
    return (hash >>> 0).toString(36);
  }

  function normalizeUrl(input) {
    if (!input) return '';
    try {
      var url = new URL(input);
      url.hash = '';
      var kept = [];
      url.searchParams.forEach(function(value, key) {
        if (!/^utm_/i.test(key) && key !== 'fbclid' && key !== 'gclid') {
          kept.push([key, value]);
        }
      });
      url.search = '';
      kept.sort(function(a, b) { return a[0].localeCompare(b[0]); });
      kept.forEach(function(entry) {
        url.searchParams.append(entry[0], entry[1]);
      });
      return url.toString();
    } catch (_) {
      return String(input || '').split('#')[0];
    }
  }

  function wordCount(text) {
    var clean = String(text || '').trim();
    return clean ? clean.split(/\s+/).length : 0;
  }

  function ownerSnapshot(portfolio) {
    portfolio = normalizePortfolio(portfolio).normalized || {};
    return {
      name: String(portfolio.name || ''),
      phone: String(portfolio.phone || ''),
      email: String(portfolio.email || ''),
      website: String(portfolio.website || '')
    };
  }

  function asArray(value) {
    return Array.isArray(value) ? value.filter(Boolean).map(function(item) {
      return String(item).trim();
    }).filter(Boolean) : [];
  }

  function normalizeExperience(entry) {
    entry = entry || {};
    return {
      company: String(entry.company || '').trim(),
      role: String(entry.role || entry.position || entry.title || '').trim(),
      duration: String(entry.duration || '').trim(),
      highlights: (function() {
        var direct = asArray(entry.highlights);
        if (direct.length) return direct;
        var fallback = Array.isArray(entry.responsibilities) ? entry.responsibilities : entry.achievements;
        return asArray(fallback);
      })()
    };
  }

  function firstText(values) {
    for (var i = 0; i < values.length; i++) {
      var value = String(values[i] || '').trim();
      if (value) return value;
    }
    return '';
  }

  function uniqueStrings(values) {
    var seen = {};
    return asArray(values).filter(function(item) {
      var key = item.toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function normalizeEducationValue(value) {
    if (typeof value === 'string') return value.trim();
    if (!Array.isArray(value)) return '';
    return value.map(function(entry) {
      if (!entry || typeof entry !== 'object') return '';
      return [
        String(entry.degree || '').trim(),
        String(entry.field || '').trim(),
        String(entry.institution || '').trim(),
        String(entry.duration || '').trim()
      ].filter(Boolean).join(', ');
    }).filter(Boolean).join(' | ');
  }

  function normalizeSkillsValue(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return uniqueStrings(value).join(', ');
    if (!value || typeof value !== 'object') return '';

    var merged = [];
    merged = merged.concat(asArray(value.technical));
    merged = merged.concat(asArray(value.soft));
    if (Array.isArray(value.categories)) {
      value.categories.forEach(function(category) {
        if (category && typeof category === 'object') merged = merged.concat(asArray(category.skills));
      });
    }
    return uniqueStrings(merged).join(', ');
  }

  function normalizePortfolio(input) {
    var raw = input || {};
    var personal = raw.personalInfo || {};
    var social = personal.social || {};
    var achievements = asArray(raw.achievements);
    if (!achievements.length && raw.about && Array.isArray(raw.about.keyAchievements)) achievements = asArray(raw.about.keyAchievements);

    var normalized = {
      name: firstText([raw.name, personal.name]),
      title: firstText([raw.title, personal.title]),
      tagline: firstText([raw.tagline, personal.tagline]),
      location: firstText([raw.location, personal.location]),
      phone: firstText([raw.phone, personal.phone]),
      email: firstText([raw.email, personal.email]),
      website: firstText([raw.website, personal.website, social.portfolio, social.linkedin, social.github]),
      education: normalizeEducationValue(raw.education),
      achievements: achievements,
      experiences: Array.isArray(raw.experiences) ? raw.experiences.map(normalizeExperience).filter(function(entry) {
        return entry.company || entry.role || entry.duration || entry.highlights.length;
      }) : [],
      skills: normalizeSkillsValue(raw.skills),
      certifications: asArray(raw.certifications),
      awards: asArray(raw.awards),
      summary: raw.about && Array.isArray(raw.about.bio) ? asArray(raw.about.bio).join(' ') : firstText([raw.summary, raw.bio]),
      interests: asArray(raw.interests),
      currentFocus: asArray(raw.currentFocus),
      links: social && typeof social === 'object' ? clone(social) : {}
    };

    var errors = [];
    var warnings = [];

    if (!normalized.name) errors.push('Full name is required.');
    if (!normalized.email) warnings.push('Email is missing.');
    if (!normalized.education) warnings.push('Education is missing.');
    if (!normalized.skills) warnings.push('Skills are missing.');
    if (!normalized.experiences.length) warnings.push('At least one work experience is recommended.');

    normalized.experiences.forEach(function(entry, index) {
      if (!entry.company && !entry.role) {
        warnings.push('Experience #' + (index + 1) + ' is missing company and role.');
      }
      if (!entry.highlights.length) {
        warnings.push('Experience #' + (index + 1) + ' has no highlights.');
      }
    });

    return {
      ok: !errors.length,
      errors: errors,
      warnings: warnings,
      normalized: normalized
    };
  }

  function portfolioFingerprint(portfolio) {
    return shortHash(JSON.stringify(normalizePortfolio(portfolio).normalized));
  }

  function buildSessionId(normalizedUrl, scrapeHash, portfolioVersion) {
    return 'sess_' + shortHash([normalizedUrl, scrapeHash, portfolioVersion].join('|'));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function numericHeaderValue(value) {
    var text = String(value || '').trim();
    if (!text) return 0;
    var multiplier = 1;
    if (/k$/i.test(text)) multiplier = 1000;
    if (/m$/i.test(text)) multiplier = 1000000;
    var parsed = Number(text.replace(/[^\d.]/g, ''));
    return Number.isFinite(parsed) ? parsed * multiplier : 0;
  }

  function clampPercent(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function modelAvailability(health, now) {
    now = now || Date.now();
    if (!health) {
      return {
        status: 'unknown',
        tone: 'unknown',
        label: 'Unknown',
        dot: '⚪',
        percent: null,
        source: ''
      };
    }

    var rate = health.rateLimit || {};
    var tokenLimit = numericHeaderValue(rate.limitTokens);
    var tokenRemaining = numericHeaderValue(rate.remainingTokens);
    var requestLimit = numericHeaderValue(rate.limitRequests);
    var requestRemaining = numericHeaderValue(rate.remainingRequests);
    var percent = null;
    var source = '';
    if (tokenLimit > 0 && rate.remainingTokens !== '') {
      percent = clampPercent((tokenRemaining / tokenLimit) * 100);
      source = 'tokens';
    } else if (requestLimit > 0 && rate.remainingRequests !== '') {
      percent = clampPercent((requestRemaining / requestLimit) * 100);
      source = 'requests';
    }

    var limitKind = String(health.limitKind || '').toLowerCase();
    var hardLimit = limitKind === 'daily_tokens' || limitKind === 'daily_requests';
    var hardLimitActive = hardLimit && (!health.blockedUntil || health.blockedUntil > now);
    var wasRateLimited = health.status === 429 || health.status === 413 || !!limitKind;
    var resetElapsed = !!(health.blockedUntil && health.blockedUntil <= now && health.status === 429 && !hardLimit);
    if (hardLimit && health.blockedUntil && health.blockedUntil <= now) resetElapsed = true;
    if (resetElapsed && (percent == null || percent === 0)) {
      percent = 100;
      source = source || 'capacity';
    }

    var waiting = !!(health.blockedUntil && health.blockedUntil > now && wasRateLimited);
    var unavailable = hardLimitActive || waiting || (!health.ok && !resetElapsed) || percent === 0;
    var tone = 'ok';
    var label = 'Ready';
    var dot = '🟢';
    if (unavailable) {
      tone = hardLimitActive ? 'error' : (waiting || health.status === 429 || health.status === 413 ? 'wait' : 'error');
      label = hardLimitActive ? 'Unavailable' : (waiting ? 'Wait' : 'Unavailable');
      dot = '🔴';
      percent = 0;
    } else if (percent != null && percent <= 50) {
      tone = 'warn';
      label = 'Low';
      dot = '🟡';
    }

    return {
      status: unavailable ? 'unavailable' : (tone === 'warn' ? 'limited' : 'available'),
      tone: tone,
      label: label,
      dot: dot,
      percent: percent,
      source: source
    };
  }

  function modelAliases(model) {
    var raw = String(model || '').trim();
    if (!raw) return [];
    var stripped = raw.replace(/^groq\//, '');
    var values = [raw, stripped, stripped ? 'groq/' + stripped : ''];
    var seen = {};
    return values.filter(function(value) {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }

  function lookupModelHealth(modelHealth, model) {
    var map = modelHealth || {};
    var aliases = modelAliases(model);
    for (var i = 0; i < aliases.length; i++) {
      if (map[aliases[i]]) return map[aliases[i]];
    }
    var wanted = {};
    aliases.forEach(function(alias) {
      wanted[alias] = true;
    });
    var keys = Object.keys(map);
    for (var j = 0; j < keys.length; j++) {
      var item = map[keys[j]];
      if (!item) continue;
      var itemAliases = modelAliases(item.model).concat(modelAliases(item.apiModel));
      for (var k = 0; k < itemAliases.length; k++) {
        if (wanted[itemAliases[k]]) return item;
      }
    }
    return null;
  }

  function sessionTitle(session) {
    var job = session && session.job ? session.job : {};
    var title = job.jobTitle || 'Untitled Role';
    var company = job.companyName || 'Unknown Company';
    return title + ' — ' + company;
  }

  function createEmptySession() {
    return {
      id: '',
      createdAt: nowIso(),
      updatedAt: nowIso(),
      page: {
        url: '',
        normalizedUrl: '',
        hostname: '',
        lastSeenAt: nowIso()
      },
      scrape: {
        hash: '',
        rawText: '',
        preview: '',
        wordCount: 0,
        charCount: 0
      },
      job: {
        jobTitle: '',
        companyName: '',
        location: '',
        jobId: '',
        seniorityLevel: '',
        keywords: [],
        responsibilities: [],
        requirements: []
      },
      research: {
        summary: '',
        sources: [],
        query1: '',
        query2: '',
        fetchedAt: '',
        error: null
      },
      artifacts: [],
      resumes: [],
      chat: [],
      activities: [],
      pipeline: {
        kind: '',
        status: 'idle',
        stage: '',
        label: '',
        progress: 0,
        error: '',
        updatedAt: ''
      },
      panel: {
        open: false,
        minimized: false,
        activeView: 'generate'
      },
      latestStyle: 'formal',
      latestModel: '',
      portfolioVersion: ''
    };
  }

  global.CoverCraftCore = {
    clone: clone,
    shortHash: shortHash,
    normalizeUrl: normalizeUrl,
    wordCount: wordCount,
    ownerSnapshot: ownerSnapshot,
    normalizePortfolio: normalizePortfolio,
    portfolioFingerprint: portfolioFingerprint,
    buildSessionId: buildSessionId,
    nowIso: nowIso,
    numericHeaderValue: numericHeaderValue,
    providerForModel: providerForModel,
    apiModelForProvider: apiModelForProvider,
    modelAvailability: modelAvailability,
    modelAliases: modelAliases,
    lookupModelHealth: lookupModelHealth,
    sessionTitle: sessionTitle,
    createEmptySession: createEmptySession,
    KNOWN_MODELS: KNOWN_MODELS.slice(),
    GROQ_BASE_LIMITS: clone(GROQ_BASE_LIMITS),
    STORAGE_KEYS: {
      sessions: 'covercraft_sessions_v3',
      sessionOrder: 'covercraft_session_order_v3',
      panelPosition: 'covercraft_panel_position_v3',
      activePortfolio: 'covercraft_active_portfolio_v3',
      activePortfolioSource: 'covercraft_active_portfolio_source_v3',
      portfolioDraft: 'covercraft_portfolio_draft_v3',
      migration: 'covercraft_migration_v3',
      legacyLogs: 'covercraft_logs'
    }
  };
})(typeof self !== 'undefined' ? self : window);
