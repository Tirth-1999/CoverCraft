(function(global) {
  'use strict';

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
    sessionTitle: sessionTitle,
    createEmptySession: createEmptySession,
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
