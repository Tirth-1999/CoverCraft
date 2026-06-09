const reveals = document.querySelectorAll('.reveal');
const faqItems = document.querySelectorAll('[data-faq]');
const hasExtensionRuntime = !!(window.chrome && chrome.runtime && chrome.runtime.id);
let currentCloudState = null;
let currentPortfolioState = null;
let currentOverviewState = null;

function clearCurrentSiteState() {
  currentCloudState = null;
  currentPortfolioState = null;
  currentOverviewState = null;
}

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

revealItems();

function revealItems() {
  reveals.forEach((el, index) => {
    el.style.transitionDelay = `${Math.min(index * 60, 360)}ms`;
    observer.observe(el);
  });
}

faqItems.forEach((item) => {
  item.addEventListener('click', () => {
    const open = item.classList.toggle('is-open');
    item.setAttribute('aria-expanded', String(open));
  });
  item.setAttribute('aria-expanded', 'false');
});

initSectionNavigation();
initHeaderDock();
initMobileMenu();
initShowcaseCarousel();

function byId(id) {
  return document.getElementById(id);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function initialsForName(name, fallback) {
  const text = String(name || '').trim();
  if (!text) return fallback || 'G';
  return text.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('') || (fallback || 'G');
}

function runtimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || null);
    });
  });
}

function initSectionNavigation() {
  const header = document.querySelector('.site-header');
  const links = Array.from(document.querySelectorAll('.nav a[href^="#"]'));
  if (!header || !links.length) return;

  function navOffset() {
    const styles = getComputedStyle(header);
    const stickyTop = parseFloat(styles.top) || 0;
    const headerHeight = header.getBoundingClientRect().height;
    return headerHeight + stickyTop + 12;
  }

  function scrollToSection(hash, updateHistory) {
    if (!hash || hash === '#') return;
    const target = document.querySelector(hash);
    if (!target) return;

    const targetTop = window.scrollY + target.getBoundingClientRect().top - navOffset();
    window.scrollTo({
      top: Math.max(targetTop, 0),
      behavior: 'smooth'
    });

    if (updateHistory) {
      window.history.pushState(null, '', hash);
    }
  }

  links.forEach((link) => {
    link.addEventListener('click', (event) => {
      const hash = link.getAttribute('href');
      if (!hash || hash === '#') return;
      event.preventDefault();
      scrollToSection(hash, true);
    });
  });

  if (window.location.hash) {
    window.requestAnimationFrame(() => {
      scrollToSection(window.location.hash, false);
    });
  }
}

function initHeaderDock() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  let ticking = false;

  function syncDockState() {
    ticking = false;
    header.classList.toggle('is-docked', window.scrollY > 18);
  }

  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(syncDockState);
  }, { passive: true });

  syncDockState();
}

function initMobileMenu() {
  const header = document.querySelector('.site-header');
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.nav');
  if (!header || !toggle || !nav) return;

  function setOpen(open) {
    header.classList.toggle('is-menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
  }

  toggle.addEventListener('click', () => {
    setOpen(!header.classList.contains('is-menu-open'));
  });

  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 720) setOpen(false);
  });
}

function initShowcaseCarousel() {
  const viewport = document.querySelector('[data-showcase-viewport]');
  if (!viewport) return;
  const carousel = viewport.closest('.showcase-carousel');

  const buttons = Array.from(document.querySelectorAll('[data-showcase-target]'));
  const slides = Array.from(viewport.querySelectorAll('[data-showcase-slide]'));
  const prevButton = document.querySelector('[data-showcase-prev]');
  const nextButton = document.querySelector('[data-showcase-next]');
  if (!buttons.length || !slides.length) return;

  let activeId = '';
  let animationFrame = null;

  function syncActiveState(id) {
    if (!id || id === activeId) return;
    activeId = id;
    let activeSlide = null;

    buttons.forEach((button) => {
      const isActive = button.dataset.showcaseTarget === id;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });

    slides.forEach((slide) => {
      const isActive = slide.dataset.showcaseSlide === id;
      slide.classList.toggle('is-active', isActive);
      if (isActive) activeSlide = slide;
    });

    if (carousel && activeSlide) {
      carousel.dataset.activeShowcase = activeSlide.dataset.showcaseSlide || id;
    }
  }

  function slideForId(id) {
    return slides.find((slide) => slide.dataset.showcaseSlide === id) || null;
  }

  function scrollToSlide(slide, behavior) {
    if (!slide) return;
    viewport.scrollTo({
      left: slide.offsetLeft,
      behavior: behavior || 'smooth'
    });
  }

  function keepPagePosition(pageY) {
    window.requestAnimationFrame(() => {
      if (Math.abs(window.scrollY - pageY) > 1) {
        window.scrollTo({
          top: pageY,
          left: window.scrollX,
          behavior: 'auto'
        });
      }
    });
  }

  function syncFromScroll() {
    animationFrame = null;
    const viewportRect = viewport.getBoundingClientRect();
    const viewportCenter = viewportRect.left + (viewportRect.width / 2);
    let closestId = slides[0].dataset.showcaseSlide;
    let closestDistance = Number.POSITIVE_INFINITY;

    slides.forEach((slide) => {
      const rect = slide.getBoundingClientRect();
      const slideCenter = rect.left + (rect.width / 2);
      const distance = Math.abs(slideCenter - viewportCenter);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestId = slide.dataset.showcaseSlide;
      }
    });

    syncActiveState(closestId);
  }

  function queueScrollSync() {
    if (animationFrame != null) return;
    animationFrame = window.requestAnimationFrame(syncFromScroll);
  }

  buttons.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      const pageY = window.scrollY;
      const id = button.dataset.showcaseTarget;
      const slide = slideForId(id);
      if (!slide) return;
      syncActiveState(id);
      scrollToSlide(slide, 'smooth');
      keepPagePosition(pageY);
    });
  });

  function moveBy(direction) {
    const pageY = window.scrollY;
    const currentIndex = Math.max(slides.findIndex((slide) => slide.dataset.showcaseSlide === activeId), 0);
    const nextIndex = (currentIndex + direction + slides.length) % slides.length;
    const nextSlide = slides[nextIndex];
    const nextId = nextSlide.dataset.showcaseSlide;
    syncActiveState(nextId);
    scrollToSlide(nextSlide, 'smooth');
    keepPagePosition(pageY);
  }

  if (prevButton) prevButton.addEventListener('click', (event) => {
    event.preventDefault();
    moveBy(-1);
  });
  if (nextButton) nextButton.addEventListener('click', (event) => {
    event.preventDefault();
    moveBy(1);
  });

  viewport.addEventListener('scroll', queueScrollSync, { passive: true });
  window.addEventListener('resize', queueScrollSync);
  viewport.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    moveBy(event.key === 'ArrowRight' ? 1 : -1);
  });

  const initialHashId = window.location.hash ? window.location.hash.slice(1) : '';
  const initialId = slideForId(initialHashId)
    ? initialHashId
    : (buttons[0].dataset.showcaseTarget || slides[0].dataset.showcaseSlide);
  syncActiveState(initialId);
  const initialSlide = slideForId(initialId);
  if (initialSlide && initialId !== slides[0].dataset.showcaseSlide) {
    window.requestAnimationFrame(() => {
      scrollToSlide(initialSlide, 'auto');
    });
  }
  queueScrollSync();
}

function setSiteStatus(message, kind) {
  const el = byId('site-account-status');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = kind === 'error' ? '#fca5a5' : (kind === 'ok' ? '#86efac' : '#94a3b8');
}

function setProfileStatus(message, kind) {
  const el = byId('site-profile-status');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = kind === 'error' ? '#fca5a5' : (kind === 'ok' ? '#86efac' : '#94a3b8');
}

function flashButtonSuccess(button, successText, originalText) {
  if (!button) return;
  const previous = originalText || button.dataset.originalText || button.textContent;
  button.dataset.originalText = previous;
  button.disabled = true;
  button.textContent = successText || '✓ Synced';
  clearTimeout(button._covercraftFlashTimer);
  button._covercraftFlashTimer = setTimeout(() => {
    button.textContent = previous;
    button.disabled = false;
  }, 1600);
}

function fieldValue(id) {
  const el = byId(id);
  return el ? el.value.trim() : '';
}

function setFieldValue(id, value) {
  const el = byId(id);
  if (el) el.value = value || '';
}

function metricCard(value, label) {
  return '<div class="mini-card"><div class="account-stat-num">' + value + '</div><div class="account-stat-label">' + label + '</div></div>';
}

function statusPill(text, muted) {
  return '<span class="account-status-pill' + (muted ? ' muted' : '') + '">' + text + '</span>';
}

function fillProfileForm(bundle) {
  const portfolio = bundle && bundle.validation && bundle.validation.normalized ? bundle.validation.normalized : {};
  setFieldValue('site-profile-name-input', portfolio.name || '');
  setFieldValue('site-profile-email-input', portfolio.email || '');
  setFieldValue('site-profile-phone-input', portfolio.phone || '');
  setFieldValue('site-profile-website-input', portfolio.website || '');
  setFieldValue('site-profile-title-input', portfolio.title || '');
  setFieldValue('site-profile-location-input', portfolio.location || '');
}

function setProfileDisabled(disabled) {
  [
    'site-profile-name-input',
    'site-profile-email-input',
    'site-profile-phone-input',
    'site-profile-website-input',
    'site-profile-title-input',
    'site-profile-location-input',
    'site-profile-save-btn',
    'site-profile-refresh-btn'
  ].forEach((id) => {
    const el = byId(id);
    if (el) el.disabled = !!disabled;
  });
}

function setProfileEditorGuestState(isGuest, previewOnly) {
  const note = byId('site-profile-guest-note');
  const sections = byId('site-profile-sections');
  if (note) note.classList.toggle('hidden', !isGuest && !previewOnly);
  if (sections) sections.classList.toggle('hidden', !!isGuest || !!previewOnly);
}

function mergeProfileIntoPortfolio(rawPortfolio) {
  const next = clone(rawPortfolio);
  const personalInfo = Object.assign({}, next.personalInfo || {});
  const social = Object.assign({}, personalInfo.social || {});

  const name = fieldValue('site-profile-name-input');
  const email = fieldValue('site-profile-email-input');
  const phone = fieldValue('site-profile-phone-input');
  const website = fieldValue('site-profile-website-input');
  const title = fieldValue('site-profile-title-input');
  const location = fieldValue('site-profile-location-input');

  next.name = name;
  next.email = email;
  next.phone = phone;
  next.website = website;
  next.title = title;
  next.location = location;

  personalInfo.name = name;
  personalInfo.email = email;
  personalInfo.phone = phone;
  personalInfo.website = website;
  personalInfo.title = title;
  personalInfo.location = location;
  social.portfolio = website;
  personalInfo.social = social;
  next.personalInfo = personalInfo;

  return next;
}

function computeOverview(data) {
  const sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
  const uniqueCompanies = {};
  let coverLetters = 0;
  let replies = 0;
  let resumes = 0;
  sessions.forEach((session) => {
    coverLetters += Array.isArray(session.artifacts) ? session.artifacts.length : 0;
    replies += Array.isArray(session.chat) ? session.chat.length : 0;
    resumes += Array.isArray(session.resumes) ? session.resumes.length : 0;
    const company = session && session.job && session.job.companyName ? String(session.job.companyName).trim() : '';
    if (company) uniqueCompanies[company.toLowerCase()] = 1;
  });
  return {
    sessions: sessions.length,
    coverLetters: coverLetters,
    replies: replies,
    resumes: resumes,
    companies: Object.keys(uniqueCompanies).length
  };
}

function accountStatCards(overview, signedIn) {
  var safe = overview || { sessions: 0, coverLetters: 0, replies: 0, resumes: 0, companies: 0 };
  var labels = signedIn
    ? ['Sessions', 'Cover letters', 'Q&A replies', 'Resume drafts', 'Unique companies']
    : ['Local sessions', 'Local letters', 'Local replies', 'Local resumes', 'Local companies'];
  return [
    metricCard(safe.sessions, labels[0]),
    metricCard(safe.coverLetters, labels[1]),
    metricCard(safe.replies, labels[2]),
    metricCard(safe.resumes, labels[3]),
    metricCard(safe.companies, labels[4])
  ].join('');
}

function renderSiteAccount(cloud, portfolioBundle, overview) {
  const avatar = byId('site-account-avatar');
  const name = byId('site-account-name');
  const sub = byId('site-account-sub');
  const badges = byId('site-account-badges');
  const stats = byId('site-account-stats');
  const copy = byId('site-account-copy');
  const profileCopy = byId('site-profile-copy');
  const actionBar = document.querySelector('.sync-action-bar');
  const signInBtn = byId('site-sign-in-btn');
  const syncBtn = byId('site-sync-btn');
  const signOutBtn = byId('site-sign-out-btn');
  const openSettingsBtn = byId('site-open-settings-btn');

  function setActionVisibility(button, visible) {
    if (!button) return;
    button.classList.toggle('hidden', !visible);
  }

  if (!avatar || !name || !sub || !copy) return;
  if (actionBar) {
    actionBar.classList.remove('is-signed-in', 'is-guest');
  }
  if (badges) badges.innerHTML = '';
  if (stats) stats.innerHTML = '';
  avatar.innerHTML = '';

  if (!hasExtensionRuntime) {
    avatar.textContent = 'G';
    name.textContent = 'Extension context only';
    sub.textContent = 'Open this page from the CoverCraft extension to manage sign-in and sync.';
    if (badges) badges.innerHTML = statusPill('Preview mode', false) + statusPill('Extension required', true);
    copy.textContent = 'Account controls are available inside the official CoverCraft extension Dashboard.';
    if (profileCopy) profileCopy.textContent = 'Open this account page from CoverCraft to edit the active profile used in letters, resumes, and exports.';
    if (stats) {
      stats.innerHTML = accountStatCards({ sessions: '—', coverLetters: '—', replies: '—', resumes: '—', companies: '—' }, false);
    }
    fillProfileForm(null);
    setProfileDisabled(true);
    setProfileEditorGuestState(false, true);
    if (signInBtn) signInBtn.disabled = true;
    if (syncBtn) syncBtn.disabled = true;
    if (signOutBtn) signOutBtn.disabled = true;
    if (openSettingsBtn) openSettingsBtn.disabled = true;
    if (actionBar) actionBar.classList.add('is-guest');
    return;
  }

  const source = portfolioBundle && portfolioBundle.source ? portfolioBundle.source : 'local_file';
  const validation = portfolioBundle && portfolioBundle.validation ? portfolioBundle.validation : null;
  const accountOverview = overview || { sessions: 0, coverLetters: 0, replies: 0, resumes: 0, companies: 0 };
  const signedIn = !!(cloud && cloud.signedIn && cloud.user);
  if (signedIn) {
    fillProfileForm(portfolioBundle);
    setProfileDisabled(false);
    setProfileEditorGuestState(false, false);
  } else {
    fillProfileForm(null);
    setProfileDisabled(true);
    setProfileEditorGuestState(true, false);
  }

  if (signedIn) {
    if (cloud.user.photoURL) {
      const img = document.createElement('img');
      img.src = cloud.user.photoURL;
      img.alt = cloud.user.displayName || cloud.user.email || 'User';
      avatar.appendChild(img);
    } else {
      avatar.textContent = initialsForName(cloud.user.displayName || cloud.user.email, 'U');
    }
    name.textContent = cloud.user.displayName || 'Signed in';
    sub.textContent = cloud.user.email || 'Account connected';
    if (badges) {
      badges.innerHTML =
        statusPill('Signed in', false) +
        statusPill(cloud.enabled ? 'Cloud sync on' : 'Cloud sync off', !cloud.enabled) +
        statusPill(cloud.lastSyncedAt ? 'Synced ' + new Date(cloud.lastSyncedAt).toLocaleDateString() : 'Not synced yet', !cloud.lastSyncedAt);
    }
  } else {
    avatar.textContent = 'G';
    name.textContent = 'Guest';
    sub.textContent = 'Not signed in';
    if (badges) {
      badges.innerHTML = statusPill('Guest', false) + statusPill('Local first', true);
    }
  }

  if (stats) {
    stats.innerHTML = accountStatCards(accountOverview, signedIn);
  }

  copy.textContent = signedIn
    ? 'Manage identity, sync, and profile details for letters, resumes, and answers from one place.'
    : 'You are browsing as guest. Sign in when you want your CoverCraft data, resumes, and letters to follow you.';
  if (profileCopy) {
    profileCopy.textContent = signedIn
      ? ('Update the profile used in cover letters, tailored resumes, and exports. Current source: ' + source.replace(/_/g, ' ') + (validation && validation.warnings && validation.warnings.length ? ' with ' + validation.warnings.length + ' warning' + (validation.warnings.length === 1 ? '' : 's') + '.' : '.'))
      : 'Sign in with Google to edit the active identity and keep those changes available across CoverCraft resumes and letters.';
  }
  if (actionBar) actionBar.classList.add(signedIn ? 'is-signed-in' : 'is-guest');
  setActionVisibility(signInBtn, !signedIn);
  setActionVisibility(syncBtn, signedIn);
  setActionVisibility(signOutBtn, signedIn);
  if (signInBtn) signInBtn.disabled = !!signedIn;
  if (syncBtn) syncBtn.disabled = !(signedIn && cloud.enabled);
  if (signOutBtn) signOutBtn.disabled = !signedIn;
  if (openSettingsBtn) openSettingsBtn.disabled = false;
}

async function loadSiteAccount() {
  if (!hasExtensionRuntime) {
    clearCurrentSiteState();
    renderSiteAccount(null, null, null);
    return;
  }

  const responses = await Promise.all([
    runtimeMessage({ type: 'GET_CLOUD_STATUS' }),
    runtimeMessage({ type: 'GET_ACTIVE_PORTFOLIO' }),
    runtimeMessage({ type: 'GET_DASHBOARD_DATA' })
  ]);
  const cloudResponse = responses[0];
  const portfolioResponse = responses[1];
  const dashboardResponse = responses[2];

  if (!cloudResponse || cloudResponse.error) {
    setSiteStatus(cloudResponse && cloudResponse.error ? cloudResponse.error : 'Could not load account status.', 'error');
    return;
  }
  if (!portfolioResponse || portfolioResponse.error) {
    setProfileStatus(portfolioResponse && portfolioResponse.error ? portfolioResponse.error : 'Could not load the active profile.', 'error');
    return;
  }

  currentCloudState = cloudResponse.cloud || null;
  currentPortfolioState = {
    portfolio: portfolioResponse.portfolio || {},
    source: portfolioResponse.source || 'local_file',
    validation: portfolioResponse.validation || null
  };
  currentOverviewState = computeOverview(dashboardResponse || {});
  renderSiteAccount(currentCloudState, currentPortfolioState, currentOverviewState);
}

function bindSiteControls() {
  const signInBtn = byId('site-sign-in-btn');
  const syncBtn = byId('site-sync-btn');
  const signOutBtn = byId('site-sign-out-btn');
  const openSettingsBtn = byId('site-open-settings-btn');
  const profileSaveBtn = byId('site-profile-save-btn');
  const profileRefreshBtn = byId('site-profile-refresh-btn');

  if (signInBtn) {
    signInBtn.addEventListener('click', () => {
      if (!hasExtensionRuntime) return;
      setSiteStatus('Opening Google sign-in…');
      chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_IN' }, (response) => {
        if (!response || response.error) {
          setSiteStatus(response && response.error ? response.error : 'Google sign-in failed.', 'error');
          clearCurrentSiteState();
          loadSiteAccount();
          return;
        }
        setSiteStatus('Signed in and ready to sync.', 'ok');
        clearCurrentSiteState();
        loadSiteAccount();
      });
    });
  }

  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      if (!hasExtensionRuntime) return;
      const original = syncBtn.textContent;
      syncBtn.dataset.originalText = original;
      syncBtn.disabled = true;
      syncBtn.textContent = 'Syncing…';
      setSiteStatus('Syncing sessions and portfolio…');
      chrome.runtime.sendMessage({ type: 'SYNC_CLOUD_NOW' }, (response) => {
        if (!response || response.error) {
          syncBtn.textContent = original;
          syncBtn.disabled = false;
          setSiteStatus(response && response.error ? response.error : 'Cloud sync failed.', 'error');
          clearCurrentSiteState();
          loadSiteAccount();
          return;
        }
        const count = response && response.result && typeof response.result.count === 'number' ? response.result.count : null;
        setSiteStatus(count != null ? ('Synced ' + count + ' session' + (count === 1 ? '' : 's') + ' to Firebase.') : 'Synced to Firebase.', 'ok');
        flashButtonSuccess(syncBtn, '✓ Synced', original);
        clearCurrentSiteState();
        loadSiteAccount();
      });
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', () => {
      if (!hasExtensionRuntime) return;
      setSiteStatus('Signing out…');
      chrome.runtime.sendMessage({ type: 'CLOUD_SIGN_OUT' }, (response) => {
        if (!response || response.error) {
          setSiteStatus(response && response.error ? response.error : 'Could not sign out.', 'error');
          return;
        }
        setSiteStatus('Signed out.', 'ok');
        clearCurrentSiteState();
        loadSiteAccount();
      });
    });
  }

  if (openSettingsBtn) {
    openSettingsBtn.addEventListener('click', () => {
      if (!hasExtensionRuntime) return;
      chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
      setSiteStatus('Opened extension settings.', 'ok');
    });
  }

  if (profileRefreshBtn) {
    profileRefreshBtn.addEventListener('click', () => {
      setProfileStatus('Reloading the active profile…');
      loadSiteAccount().then(() => {
        setProfileStatus('Profile reloaded.', 'ok');
      });
    });
  }

  if (profileSaveBtn) {
    profileSaveBtn.addEventListener('click', () => {
      if (!hasExtensionRuntime) return;
      if (!currentCloudState || !currentCloudState.signedIn) {
        setProfileStatus('Sign in with Google before editing the active profile here.', 'error');
        return;
      }
      if (!currentPortfolioState || !currentPortfolioState.portfolio) {
        setProfileStatus('Could not find the active profile to update.', 'error');
        return;
      }
      setProfileStatus('Saving profile changes…');
      const nextPortfolio = mergeProfileIntoPortfolio(currentPortfolioState.portfolio);
      chrome.runtime.sendMessage({
        type: 'SAVE_ACTIVE_PORTFOLIO',
        payload: {
          portfolio: nextPortfolio,
          source: currentPortfolioState.source || 'site_account'
        }
      }, (response) => {
        if (!response || response.error) {
          setProfileStatus(response && response.error ? response.error : 'Could not save the profile.', 'error');
          return;
        }
        currentPortfolioState = {
          portfolio: nextPortfolio,
          source: currentPortfolioState.source || 'site_account',
          validation: response.validation || null
        };
        renderSiteAccount(currentCloudState, currentPortfolioState, currentOverviewState);
        setProfileStatus(response.validation && response.validation.ok ? 'Profile saved.' : 'Profile saved with warnings. Review the active portfolio before generating.', response.validation && response.validation.ok ? 'ok' : '');
      });
    });
  }
}

bindSiteControls();
loadSiteAccount();
