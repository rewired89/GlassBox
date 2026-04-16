/**
 * GlassBox — AI-driven content script.
 * Thin client: extracts post data, sends to GlassBox API, renders response.
 * Supports: Twitter/X, Reddit, YouTube.
 */
(async function GlassBox() {
  'use strict';

  // ── Teardown previous instance ────────────────────────────────────────────────
  if (typeof window.__glassboxTeardown === 'function') {
    window.__glassboxTeardown();
    await new Promise(r => setTimeout(r, 30));
  }
  document.querySelectorAll('[data-glassbox]').forEach(el => el.remove());

  // ── Hardcoded fallback API URL ─────────────────────────────────────────────────
  // If chrome.storage is unavailable, this URL is used directly.
  const HARDCODED_API_URL = 'https://glassbox-production-3db2.up.railway.app';

  // ── Settings ──────────────────────────────────────────────────────────────────
  const DEFAULT_SETTINGS = {
    enabled:                  true,
    apiUrl:                   HARDCODED_API_URL,
    showContextCards:         true,
    showManipulationIndicators: true,
    showCredibilityBadges:    true,
    prePostReflection:        true,
    manipulationThreshold:    'medium',
  };

  let _settings = null;
  async function getSettings() {
    if (_settings) return _settings;
    try {
      if (!chrome?.storage?.sync) throw new Error('storage unavailable');
      return new Promise(resolve => {
        chrome.storage.sync.get('glassbox_settings', r => {
          const saved = r?.glassbox_settings || {};
          _settings = { ...DEFAULT_SETTINGS, ...saved };
          // Always ensure API URL is set
          if (!_settings.apiUrl) _settings.apiUrl = HARDCODED_API_URL;
          resolve(_settings);
        });
      });
    } catch (e) {
      console.warn('[GlassBox] chrome.storage unavailable — using hardcoded defaults:', e.message);
      _settings = { ...DEFAULT_SETTINGS };
      return _settings;
    }
  }

  // ── Platforms ─────────────────────────────────────────────────────────────────
  const PLATFORMS = {
    twitter: {
      test:         () => /twitter\.com|x\.com/.test(location.hostname),
      postSel:      'article[data-testid="tweet"]',
      textSel:      'div[data-testid="tweetText"]',
      actionSel:    'div[role="group"][aria-label]',
      authorSel:    '[data-testid="User-Name"] a[href^="/"]',
      imgSel:       'img[src*="pbs.twimg.com/media"]',
      composeSel:   'div[data-testid="tweetTextarea_0"]',
      submitBtns:   ['button[data-testid="tweetButtonInline"]', 'button[data-testid="tweetButton"]', 'button[data-testid="sendDmButton"]'],
    },
    reddit: {
      test:         () => /reddit\.com/.test(location.hostname),
      postSel:      'shreddit-post, [data-testid="post-container"]',
      textSel:      '[slot="text-body"], .RichTextJSON-root, [data-click-id="text"]',
      actionSel:    '[data-testid="post-actions-bottom"], .action-bar',
      authorSel:    'a[href*="/user/"]',
      imgSel:       'img[src*="i.redd.it"], img[src*="preview.redd.it"]',
      composeSel:   null,
      submitBtns:   [],
    },
    youtube: {
      test:         () => /youtube\.com/.test(location.hostname),
      postSel:      'ytd-comment-renderer',
      textSel:      '#content-text',
      actionSel:    '#toolbar',
      authorSel:    '#author-text a, .ytd-comment-renderer #author-text',
      imgSel:       null,
      composeSel:   null,
      submitBtns:   [],
    },
    tiktok: {
      test:         () => /tiktok\.com/.test(location.hostname),
      // Feed items on For You page, individual video browse page
      postSel:      'div[data-e2e="recommend-list-item-container"], div[data-e2e="browse-video-container"]',
      // Video caption/description — multiple selectors for different page layouts
      textSel:      'h1[data-e2e="browse-video-desc"], div[data-e2e="video-desc"], span[data-e2e="video-desc-title"]',
      // Right-side action bar (like/comment/share buttons)
      actionSel:    'div[data-e2e="action-bar"]',
      authorSel:    'a[data-e2e="video-author-uniqueid"], a[data-e2e="browse-username"]',
      imgSel:       null,
      composeSel:   null,
      submitBtns:   [],
    },
  };

  const PLATFORM = Object.entries(PLATFORMS).find(([, p]) => p.test());
  if (!PLATFORM) return;
  const [platformName, platform] = PLATFORM;
  console.log(`[GlassBox] loaded on ${platformName}`);

  // ── Utilities ─────────────────────────────────────────────────────────────────
  function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  async function hashString(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
  }

  function getTextContent(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-glassbox]').forEach(n => n.remove());
    return clone.textContent?.trim() || '';
  }

  function getAuthorHandle(postEl) {
    const sel = platform.authorSel;
    if (!sel) return null;
    for (const el of postEl.querySelectorAll(sel)) {
      const href = el.getAttribute('href') || '';
      const m = href.match(/\/(?:user\/)?([A-Za-z0-9_.-]{1,50})(?:\/|$)/);
      if (m && !['search','explore','notifications','messages','settings','home'].includes(m[1].toLowerCase())) {
        return m[1].toLowerCase();
      }
    }
    return null;
  }

  function getImageUrls(postEl) {
    const imgs = platform.imgSel
      ? Array.from(postEl.querySelectorAll(platform.imgSel))
          .map(img => img.src || img.getAttribute('src'))
          .filter(src => src && src.startsWith('https://'))
      : [];
    // Also grab video poster frames — lets AI-detection run on video thumbnails
    const posters = Array.from(postEl.querySelectorAll('video[poster]'))
      .map(v => v.getAttribute('poster'))
      .filter(src => src && src.startsWith('https://'));
    return [...imgs, ...posters].slice(0, 3);
  }

  // ── API client ────────────────────────────────────────────────────────────────
  const _cache = new Map();

  async function callAPI(text, imageUrls, handle) {
    const settings = await getSettings();
    if (!settings.apiUrl) return null;

    const key = await hashString(text.slice(0, 300) + (handle || '') + String(imageUrls.length));
    if (_cache.has(key)) return _cache.get(key);

    try {
      const res = await fetch(`${settings.apiUrl.replace(/\/$/, '')}/api/analyze`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, imageUrls, handle, platform: platformName }),
        signal:  AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        console.error(`[GlassBox] API ${res.status} error:`, errBody.detail || errBody.error || res.statusText);
        return null;
      }
      const data = await res.json();
      _cache.set(key, data);
      // Expire after 10 minutes
      setTimeout(() => _cache.delete(key), 600_000);
      return data;
    } catch {
      return null;
    }
  }

  // ── Renderers ─────────────────────────────────────────────────────────────────

  const RESONANCE_DESCRIPTIONS = {
    Empathetic: 'Respectful, good-faith tone. Fact-based and constructive.',
    Neutral:    'Balanced, informational tone. No strong emotional charge.',
    Dismissive: 'Condescending or indifferent. Opinion-driven, low on facts.',
    Hostile:    'Aggressive or dehumanizing. Designed to provoke fear or anger.',
  };

  /**
   * Standalone resonance banner — injected directly below the tweet text,
   * always fully visible (no click needed). Shows:
   *   • Score + label + description (tone)
   *   • News verification status (if present)
   *   • Manipulation tactic name, description, and book recommendation (if present)
   *
   * Score display is INVERTED for negative labels so that bad content shows
   * a high percentage:  resonance 18 (Hostile) → displayed as "82% Hostile"
   *                     resonance 82 (Empathetic) → displayed as "82% Empathetic"
   */
  /**
   * Resonance tag — compact pill by default. Click to expand full detail.
   * Clicking NEVER navigates to the tweet (stopPropagation + preventDefault).
   *
   * Collapsed:  [⚠️ 65% Dismissive ▼]
   * Expanded:   tone description
   *             ⚠️ Missing Context — explanation of the tactic used here
   *             📚 Read: "Manufacturing Consent" — Noam Chomsky
   *             🚩 Unverified, possibly fake (70%) — No credible sources found.
   */
  function renderResonanceBanner(resonance, newsVerification, manipulationTactic) {
    const label = resonance.label || 'Neutral';
    const desc  = RESONANCE_DESCRIPTIONS[label] || '';

    const isNegative = label === 'Hostile' || label === 'Dismissive';
    const displayPct = isNegative ? (100 - resonance.score) : resonance.score;
    const scoreIcon  = label === 'Hostile' ? '💢' : label === 'Dismissive' ? '⚠️' : label === 'Neutral' ? '💬' : '✅';

    const TEXT    = '#111827';
    const SUBTEXT = '#374151';
    const FF      = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

    // ── Wrapper ──────────────────────────────────────────────────────────────
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'resonance-banner');
    el.style.cssText = `${FF};margin:4px 0;display:inline-block;max-width:100%;`;

    // ── Compact pill (always visible) ────────────────────────────────────────
    const trigger = document.createElement('div');
    trigger.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:5px',
      `border-left:3px solid ${resonance.color}`,
      `background:${resonance.color}18`,
      'border-radius:0 4px 4px 0',
      'padding:3px 9px 3px 7px',
      'cursor:pointer', 'user-select:none',
    ].join(';');

    const scoreSpan = document.createElement('span');
    scoreSpan.style.cssText = `color:${TEXT};font-weight:700;font-size:12px;white-space:nowrap;`;
    scoreSpan.textContent = `${scoreIcon} ${displayPct}% ${label}`;

    const arrow = document.createElement('span');
    arrow.style.cssText = `color:${SUBTEXT};font-size:9px;margin-left:2px;`;
    arrow.textContent = '▼';

    trigger.appendChild(scoreSpan);
    trigger.appendChild(arrow);

    // ── Expanded detail (hidden by default) ──────────────────────────────────
    const body = document.createElement('div');
    body.style.cssText = [
      'display:none',
      `border-left:3px solid ${resonance.color}`,
      `background:${resonance.color}18`,
      'border-radius:0 0 6px 0',
      'padding:8px 12px',
      'margin-top:1px',
      `${FF}`, 'line-height:1.5',
    ].join(';');

    // Tone description
    const descEl = document.createElement('div');
    descEl.style.cssText = `color:${SUBTEXT};font-size:11px;margin-bottom:4px;`;
    descEl.textContent = desc;
    body.appendChild(descEl);

    // Manipulation tactic + book recommendation
    if (manipulationTactic) {
      const tacticWrap = document.createElement('div');
      tacticWrap.style.cssText = `border-top:1px solid ${resonance.color}44;padding-top:6px;margin-top:6px;`;

      const tacticLine = document.createElement('div');
      tacticLine.style.cssText = 'font-size:11px;';
      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = `color:${TEXT};font-weight:700;`;
      nameSpan.textContent = `⚠️ ${manipulationTactic.name}`;
      const dashSpan = document.createElement('span');
      dashSpan.style.cssText = `color:${SUBTEXT};margin-left:5px;`;
      dashSpan.textContent = `— ${manipulationTactic.description}`;
      tacticLine.appendChild(nameSpan);
      tacticLine.appendChild(dashSpan);
      tacticWrap.appendChild(tacticLine);

      const bookLine = document.createElement('div');
      bookLine.style.cssText = `font-size:10px;color:${SUBTEXT};margin-top:4px;`;
      const bookBold = document.createElement('strong');
      bookBold.style.color = TEXT;
      bookBold.textContent = '📚 Read: ';
      const bookTitle = document.createElement('em');
      bookTitle.textContent = `"${manipulationTactic.book_title}"`;
      const bookAuth = document.createTextNode(` — ${manipulationTactic.book_author}`);
      bookLine.appendChild(bookBold);
      bookLine.appendChild(bookTitle);
      bookLine.appendChild(bookAuth);
      tacticWrap.appendChild(bookLine);

      body.appendChild(tacticWrap);
    }

    // News verification
    if (newsVerification?.label) {
      const nvScore = newsVerification.score;
      const nvIcon  = nvScore < 30 ? '✅' : nvScore < 70 ? '⚠️' : '🚩';
      const nvNote  = nvScore >= 70 ? 'No credible sources found.'
                    : nvScore >= 30 ? 'Partially verifiable; some details unconfirmed.'
                    : 'Confirmed by credible sources.';
      const nvEl = document.createElement('div');
      nvEl.style.cssText = `color:${TEXT};font-size:11px;margin-top:6px;border-top:1px solid ${resonance.color}44;padding-top:6px;`;
      nvEl.textContent = `${nvIcon} ${newsVerification.label} (${nvScore}%) — ${nvNote}`;
      body.appendChild(nvEl);
    }

    // ── Toggle on click — never lets the click reach Twitter ─────────────────
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      e.preventDefault();
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      arrow.textContent  = open ? '▼' : '▲';
    });

    el.appendChild(trigger);
    el.appendChild(body);
    return el;
  }

  /**
   * AI-generated content banner.
   * Shows when Claude detects a medium/high-confidence AI image in the post.
   */
  function renderAiContentTag(aiDetection) {
    const color = aiDetection.confidence === 'high' ? '#8b5cf6' : '#6366f1';
    const confidenceLabel = aiDetection.confidence === 'high' ? 'High confidence' : 'Likely AI-generated';

    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'ai-detection');
    el.className = 'gb-factcheck';
    el.style.cssText = `border-left-color:${color};background:${color}0d;`;

    const header = document.createElement('div');
    header.className = 'gb-factcheck__header';

    const icon = document.createElement('span');
    icon.className = 'gb-factcheck__icon';
    icon.textContent = '🤖';

    const title = document.createElement('span');
    title.className = 'gb-factcheck__title';
    title.style.color = color;
    title.textContent = 'AI-Generated Content';

    const badge = document.createElement('span');
    badge.className = 'gb-factcheck__verdict';
    badge.style.color = color;
    badge.textContent = confidenceLabel;

    header.appendChild(icon);
    header.appendChild(title);
    header.appendChild(badge);
    el.appendChild(header);

    const signals = (aiDetection.signals || []).slice(0, 2);
    if (signals.length) {
      const detail = document.createElement('div');
      detail.className = 'gb-factcheck__claim';
      detail.style.color = '#374151';
      detail.textContent = signals.join(' · ');
      el.appendChild(detail);
    }

    el.addEventListener('click', e => e.stopPropagation());
    return el;
  }

  /**
   * Standalone news-verification tag — used on TikTok and any platform where
   * we want a visible "Verified / Unverified, possibly fake" label.
   */
  function renderNewsVerificationTag(newsVerification) {
    const score = newsVerification.score;
    let icon, text, color;
    if (score < 30) {
      icon = '✅'; text = 'Verified';                   color = '#22c55e';
    } else if (score < 70) {
      icon = '⚠️'; text = 'Partially Verified';         color = '#f59e0b';
    } else {
      icon = '🚩'; text = 'Unverified, possibly fake';  color = '#ef4444';
    }

    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'news-verification-tag');
    el.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:4px',
      `padding:3px 8px`, 'border-radius:4px',
      'font-size:11px', 'font-weight:600', 'font-family:sans-serif',
      `color:${color}`, `background:${color}1a`, `border:1px solid ${color}44`,
      'cursor:default', 'margin-top:4px',
    ].join(';');

    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    const textSpan = document.createElement('span');
    textSpan.textContent = text;

    const scoreNote = document.createElement('span');
    scoreNote.style.cssText = 'font-size:10px;opacity:0.7;font-weight:400';
    scoreNote.textContent = ` (${score}% unverified)`;

    el.appendChild(iconSpan);
    el.appendChild(textSpan);
    el.appendChild(scoreNote);

    // Tooltip: explain the 99% case
    const tip = score >= 99
      ? 'GlassBox could not find any sources for this story. A 1% chance remains that an obscure source exists but was not found.'
      : `GlassBox news verification — ${newsVerification.label}. Score: ${score}/99.`;
    el.title = tip;
    el.addEventListener('click', e => e.stopPropagation());
    return el;
  }

  function renderFactCheckBanner(fc) {
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'factcheck-banner');
    el.className = 'gb-factcheck';
    el.innerHTML = `
      <div class="gb-factcheck__header">
        <span class="gb-factcheck__icon">🔎</span>
        <span class="gb-factcheck__title">Fact Check</span>
        <span class="gb-factcheck__verdict">${escHTML(fc.verdict)}</span>
      </div>
      ${fc.claim ? `<div class="gb-factcheck__claim">Claim: "${escHTML(fc.claim)}"</div>` : ''}
      ${fc.source_url
        ? `<a class="gb-factcheck__source" href="${escHTML(fc.source_url)}" target="_blank" rel="noopener noreferrer">📄 ${escHTML(fc.source)}</a>`
        : (fc.source ? `<span class="gb-factcheck__source">${escHTML(fc.source)}</span>` : '')}`;
    // Prevent click from bubbling to Twitter and navigating to the tweet
    el.addEventListener('click', e => e.stopPropagation());
    return el;
  }

  function renderContextCard(card, cardId) {
    const timelineHTML = (card.timeline || []).map(t =>
      `<div class="gb-card__tl-row"><span class="gb-card__tl-date">${escHTML(t.date)}</span><span class="gb-card__tl-event">${escHTML(t.event)}</span></div>`
    ).join('');
    const sourcesHTML = (card.sources || []).map(s =>
      `<li>${escHTML(s)}</li>`
    ).join('');

    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'context-card');
    el.setAttribute('data-card-id', cardId || '');
    el.className = 'gb-card';
    el.innerHTML = `
      <button class="gb-card__trigger" aria-expanded="false">
        <span class="gb-card__hook">${escHTML(card.hook || '')}</span>
        <span class="gb-card__arrow">▼</span>
      </button>
      <div class="gb-card__body">
        <div class="gb-card__title">${escHTML(card.title || '')}</div>
        ${timelineHTML ? `<div class="gb-card__timeline">${timelineHTML}</div>` : ''}
        ${card.irony_highlight ? `<div class="gb-card__callout gb-card__callout--irony">💡 ${escHTML(card.irony_highlight)}</div>` : ''}
        ${card.empathy_angle  ? `<div class="gb-card__callout gb-card__callout--empathy">💛 ${escHTML(card.empathy_angle)}</div>` : ''}
        ${sourcesHTML ? `<div class="gb-card__sources"><div class="gb-card__sources-title">Sources</div><ul>${sourcesHTML}</ul></div>` : ''}
      </div>`;
    el.querySelector('.gb-card__trigger').addEventListener('click', e => {
      e.stopPropagation();
      const expanded = el.classList.toggle('gb-card--expanded');
      el.querySelector('.gb-card__trigger').setAttribute('aria-expanded', expanded);
    });
    return el;
  }

  function _resonanceBadgeHTML(res) {
    if (!res) return '';
    const icon = res.score < 35 ? '💢' : (res.score < 50 ? '⚠️' : '💬');
    return `<span class="gb-acct-card__resonance" title="${RESONANCE_DESCRIPTIONS[res.label] || ''}" style="color:${res.color};border-color:${res.color}44;background:${res.color}11">${icon} ${res.score}% ${res.label}</span>`;
  }

  function renderAccountabilityCard(figure, resonance) {
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'accountability-card');
    el.className = 'gb-acct-card';

    const legalHTML = (figure.legal_proceedings || []).slice(0, 3).map(p => `
      <div class="gb-acct-card__item">
        <span class="gb-acct-card__item-badge gb-acct-card__item-badge--${p.status}">${p.status}</span>
        <div>
          <div class="gb-acct-card__item-title">${escHTML(p.case)}</div>
          <div class="gb-acct-card__item-detail">${escHTML(p.summary)}</div>
          ${p.source_url ? `<a class="gb-acct-card__item-link" href="${escHTML(p.source_url)}" target="_blank" rel="noopener noreferrer">📄 ${escHTML(p.source)}</a>` : ''}
        </div>
      </div>`).join('');

    const factHTML = (figure.fact_check_discrepancies || []).slice(0, 3).map(f => `
      <div class="gb-acct-card__item">
        <span class="gb-acct-card__item-badge gb-acct-card__item-badge--disputed">disputed</span>
        <div>
          <div class="gb-acct-card__item-title">"${escHTML(f.claim)}"</div>
          <div class="gb-acct-card__item-detail">↳ ${escHTML(f.finding)}</div>
          ${f.source_url ? `<a class="gb-acct-card__item-link" href="${escHTML(f.source_url)}" target="_blank" rel="noopener noreferrer">📄 ${escHTML(f.source)}</a>` : ''}
        </div>
      </div>`).join('');

    const financeHTML = (figure.financial_ties || []).slice(0, 3).map(f => `
      <div class="gb-acct-card__item">
        <span class="gb-acct-card__item-badge gb-acct-card__item-badge--financial">financial</span>
        <div>
          <div class="gb-acct-card__item-title">${escHTML(f.entity)}</div>
          <div class="gb-acct-card__item-detail">${escHTML(f.relationship)}${f.amount ? ` — ${escHTML(f.amount)}` : ''}</div>
          ${f.source_url ? `<a class="gb-acct-card__item-link" href="${escHTML(f.source_url)}" target="_blank" rel="noopener noreferrer">📄 ${escHTML(f.source)}</a>` : ''}
        </div>
      </div>`).join('');

    // Mirror context: does the post topic match the figure's documented background?
    const mirrorHTML = (() => {
      if (!figure.mirror_note || !figure.mirror_triggers?.length) return '';
      // Check already done server-side — mirror_note is returned only when relevant
      return `
        <div class="gb-acct-card__section gb-acct-card__section--mirror">
          <div class="gb-acct-card__section-title">🪞 Biographical Mirror</div>
          <div class="gb-acct-card__mirror-note">${escHTML(figure.mirror_note)}</div>
          ${figure.biography?.source_url ? `<a class="gb-acct-card__item-link" href="${escHTML(figure.biography.source_url)}" target="_blank" rel="noopener noreferrer">📄 Wikipedia biographical record</a>` : ''}
        </div>`;
    })();

    // Sex offender registry alert
    const registryHTML = (() => {
      const reg = figure.sex_offender_registry;
      if (!reg?.registered) return '';
      const matches = reg.matches || [{ offense: reg.offense, jurisdiction: reg.jurisdiction }];
      return `<div class="gb-acct-card__section" style="border-left:3px solid #ef4444;background:rgba(239,68,68,0.06)">
        <div class="gb-acct-card__section-title" style="color:#ef4444">🚨 Registered Sex Offender — NSOPW.gov</div>
        ${matches.map(m => `
          <div class="gb-acct-card__item">
            <span class="gb-acct-card__item-badge gb-acct-card__item-badge--convicted">registered</span>
            <div>
              <div class="gb-acct-card__item-title">${escHTML(m.jurisdiction || reg.jurisdiction || '')} Registry</div>
              <div class="gb-acct-card__item-detail">${escHTML(m.offense || reg.offense || 'Registered sex offense')}</div>
              ${(m.registry_url || reg.registry_url) ? `<a class="gb-acct-card__item-link" href="${escHTML(m.registry_url || reg.registry_url)}" target="_blank" rel="noopener noreferrer">🔗 Registry entry</a>` : '<a class="gb-acct-card__item-link" href="https://www.nsopw.gov" target="_blank" rel="noopener noreferrer">🔗 NSOPW.gov</a>'}
            </div>
          </div>`).join('')}
        ${reg.disclaimer ? `<div style="font-size:10px;color:#9ca3af;margin-top:4px">⚠️ ${escHTML(reg.disclaimer)}</div>` : ''}
      </div>`;
    })();

    // Criminal convictions
    const convictionsHTML = (figure.criminal_convictions || []).slice(0, 3).map(c => `
      <div class="gb-acct-card__item">
        <span class="gb-acct-card__item-badge gb-acct-card__item-badge--convicted">${escHTML(c.severity || 'conviction')}</span>
        <div>
          <div class="gb-acct-card__item-title">${escHTML(c.offense)}</div>
          <div class="gb-acct-card__item-detail">${escHTML(c.jurisdiction)} · ${escHTML(c.conviction_date || '')}${c.sentence ? ` · ${escHTML(c.sentence)}` : ''}</div>
          ${c.source_url ? `<a class="gb-acct-card__item-link" href="${escHTML(c.source_url)}" target="_blank" rel="noopener noreferrer">📄 ${escHTML(c.source)}</a>` : ''}
        </div>
      </div>`).join('');

    const sections = [
      registryHTML,
      convictionsHTML ? `<div class="gb-acct-card__section" style="border-left:3px solid #ef4444;background:rgba(239,68,68,0.04)"><div class="gb-acct-card__section-title" style="color:#ef4444">🔒 Criminal Convictions</div>${convictionsHTML}</div>` : '',
      mirrorHTML,
      legalHTML   ? `<div class="gb-acct-card__section"><div class="gb-acct-card__section-title">⚖️ Verified Legal Proceedings</div>${legalHTML}</div>` : '',
      factHTML    ? `<div class="gb-acct-card__section"><div class="gb-acct-card__section-title">🔎 Documented Contradictions</div>${factHTML}</div>` : '',
      financeHTML ? `<div class="gb-acct-card__section"><div class="gb-acct-card__section-title">💰 Financial Ties</div>${financeHTML}</div>` : '',
    ].filter(Boolean).join('');

    el.innerHTML = `
      <button class="gb-acct-card__trigger" aria-expanded="false">
        <span>🏛️</span>
        <span class="gb-acct-card__trigger-label">Public Record — ${escHTML(figure.name)}</span>
        <span class="gb-acct-card__trigger-role">${escHTML(figure.role || '')}</span>
        <span class="gb-acct-card__trigger-arrow">▼</span>
      </button>
      <div class="gb-acct-card__body">${sections || '<div style="color:#6b7280;font-size:12px;padding:10px">No verified records on file for this topic.</div>'}</div>`;

    el.querySelector('.gb-acct-card__trigger').addEventListener('click', e => {
      e.stopPropagation();
      const expanded = el.classList.toggle('gb-acct-card--expanded');
      el.querySelector('.gb-acct-card__trigger').setAttribute('aria-expanded', expanded);
    });
    return el;
  }

  // Lightweight biographical mirror card (for figures with mirror context but no full accountability data)
  function renderMirrorCard(figure, resonance) {
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'mirror-card');
    el.className = 'gb-acct-card gb-mirror-card';

    const bioDetail = figure.biography?.migration_note
      ? `<div class="gb-acct-card__item-detail gb-acct-card__mirror-detail">${escHTML(figure.biography.migration_note)}</div>` : '';

    el.innerHTML = `
      <button class="gb-acct-card__trigger" aria-expanded="false">
        <span>🪞</span>
        <span class="gb-acct-card__trigger-label">Biographical Context — ${escHTML(figure.name)}</span>
        <span class="gb-acct-card__trigger-role">${escHTML(figure.role || '')}</span>
        <span class="gb-acct-card__trigger-arrow">▼</span>
      </button>
      <div class="gb-acct-card__body">
        <div class="gb-acct-card__section gb-acct-card__section--mirror">
          <div class="gb-acct-card__section-title">🪞 Biographical Mirror</div>
          <div class="gb-acct-card__mirror-note">${escHTML(figure.mirror_note)}</div>
          ${bioDetail}
          ${figure.biography?.source_url ? `<a class="gb-acct-card__item-link" href="${escHTML(figure.biography.source_url)}" target="_blank" rel="noopener noreferrer">📄 Wikipedia biographical record</a>` : ''}
        </div>
      </div>`;

    el.querySelector('.gb-acct-card__trigger').addEventListener('click', e => {
      e.stopPropagation();
      const expanded = el.classList.toggle('gb-acct-card--expanded');
      el.querySelector('.gb-acct-card__trigger').setAttribute('aria-expanded', expanded);
    });
    return el;
  }

  function renderImageConcernBanner(concern) {
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'image-concern');
    el.className = 'gb-factcheck';
    el.style.borderLeftColor = '#f59e0b';
    el.innerHTML = `
      <div class="gb-factcheck__header">
        <span class="gb-factcheck__icon">🖼️</span>
        <span class="gb-factcheck__title">Image Context</span>
      </div>
      <div class="gb-factcheck__claim">${escHTML(concern)}</div>`;
    el.addEventListener('click', e => e.stopPropagation());
    return el;
  }

  function escHTML(s) {
    if (!s) return '';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Compose gate (Twitter only — local patterns for synchronous block) ──────────
  const COMPOSE_CLAIM_PATTERNS = [
    /\bvaccines? (cause[sd]?|causes) autism\b/i,
    /\b(the |2020 )?election was stolen\b/i,
    /\b(there'?s? (no|no such thing as) genocide|not (a )?genocide|wasn'?t genocide)\b/i,
    /\b(climate change|global warming) (is|are) (a )?(hoax|fake|fraud|scam)\b/i,
    /\bmmiwg.{0,30}(not|no|never|wasn.t|isn.t)\b/i,
  ];

  const DEHUMANIZATION_RE = [
    /\b(immigrants?|refugees?|illegals?|muslims?|jews?|christians?|blacks?|whites?|natives?|indigenous).{0,30}(animals?|vermin|rats?|cockroach|parasites?|subhuman|disease|invasion|infestation)\b/i,
    /\b(animals?|vermin|rats?|cockroach|parasites?|subhuman).{0,30}(immigrants?|refugees?|muslims?|jews?|blacks?|natives?)\b/i,
    /\bgo back to (your country|where you came from|africa|mexico)\b/i,
  ];

  function localQuickCheck(text) {
    const hasFalseClaim    = COMPOSE_CLAIM_PATTERNS.some(p => p.test(text));
    const hasDehumanization = DEHUMANIZATION_RE.some(p => p.test(text));
    return hasFalseClaim || hasDehumanization;
  }

  // ── Post annotation ───────────────────────────────────────────────────────────
  const processedPosts = new WeakSet();
  const _retryCount    = new WeakMap();

  async function annotatePost(postEl) {
    if (processedPosts.has(postEl)) return;
    processedPosts.add(postEl);

    const settings = await getSettings();
    if (!settings.enabled) return;

    const textEl = postEl.querySelector(platform.textSel);
    const text   = textEl ? getTextContent(textEl) : '';
    const handle = getAuthorHandle(postEl);

    // Skip compose/DM pages — nothing to annotate there
    if (location.pathname.includes('/compose/') || location.pathname.includes('/messages/')) return;

    // Need either meaningful text or a known handle to be worth calling
    if (!text && !handle) return;

    // Only call API if configured; silently skip otherwise
    if (!settings.apiUrl) {
      console.log('[GlassBox] skipping — API URL not set. Go to extension popup → Settings to configure it.');
      return;
    }

    console.log(`[GlassBox] analyzing post by @${handle || 'unknown'} — text: "${text.slice(0,60)}…"`);

    const imageUrls = getImageUrls(postEl);

    let result = null;
    try {
      result = await callAPI(text, imageUrls, handle);
    } catch (e) {
      console.warn('[GlassBox] API error:', e.message);
      processedPosts.delete(postEl);
      return;
    }
    if (!result) {
      // API timed out or returned nothing — likely a Railway cold start.
      // Remove from processedPosts so we can retry, up to 2 times.
      const retries = _retryCount.get(postEl) || 0;
      if (retries < 2) {
        _retryCount.set(postEl, retries + 1);
        processedPosts.delete(postEl);
        console.log(`[GlassBox] API returned null — retry ${retries + 1}/2 in 8s`);
        setTimeout(() => queuePost(postEl), 8_000);
      } else {
        console.log('[GlassBox] API returned null after 2 retries — giving up on this post');
      }
      return;
    }

    console.log('[GlassBox] result:', { flagged: result.flagged, figure: result.figure?.name, resonance: result.resonance?.score });

    // Fallback insert point: text element's parent, or the article itself
    const insertPoint = textEl?.parentElement ?? postEl.querySelector('[data-testid="tweetText"]')?.closest('div') ?? postEl;
    if (!insertPoint) return;

    // Safe reference: null means "append to end of insertPoint"
    const afterText = textEl?.nextSibling ?? null;

    // ── Resonance banner — standalone, below tweet text, always visible ──────────
    // No longer placed inside the action bar or the card header.
    // The score is shown as the first thing below the post so readers
    // see it immediately without having to expand any card.
    if (result.resonance && !insertPoint.querySelector('[data-glassbox="resonance-banner"]')) {
      insertPoint.insertBefore(
        renderResonanceBanner(result.resonance, result.news_verification, result.manipulation_tactic),
        afterText
      );
    }

    // ── Standalone news-verification tag (TikTok only) ────────────────────────
    if (platformName === 'tiktok' && result.news_verification?.label) {
      if (!insertPoint.querySelector('[data-glassbox="news-verification-tag"]')) {
        insertPoint.insertBefore(renderNewsVerificationTag(result.news_verification), afterText);
      }
    }

    // ── Fact-check banners ────────────────────────────────────────────────────
    for (const fc of (result.fact_checks || []).slice(0, 2)) {
      insertPoint.insertBefore(renderFactCheckBanner(fc), afterText);
    }

    // ── Image concern banner ──────────────────────────────────────────────────
    if (result.image_concerns) {
      insertPoint.insertBefore(renderImageConcernBanner(result.image_concerns), afterText);
    }

    // ── AI-generated content tag ──────────────────────────────────────────────
    if (result.ai_generated?.detected && result.ai_generated.confidence !== 'low') {
      insertPoint.insertBefore(renderAiContentTag(result.ai_generated), afterText);
    }

    // ── Context card ──────────────────────────────────────────────────────────
    if (settings.showContextCards && result.flagged && result.context_card) {
      const container = document.createElement('div');
      container.setAttribute('data-glassbox', 'card-container');
      container.appendChild(renderContextCard(result.context_card, result.context_card_id));
      insertPoint.insertBefore(container, afterText);
    }

    // ── Figure card — always show when figure is in the database ─────────────
    if (result.figure) {
      insertPoint.insertBefore(
        renderAccountabilityCard(result.figure, result.resonance),
        afterText
      );
    }
  }

  // ── Twitter compose gate ──────────────────────────────────────────────────────
  // Module-level flag — survives Twitter re-rendering the button DOM element.
  // Storing the flag on btn.dataset fails because Twitter creates a brand-new
  // <button> element after every modal open/close, losing the flag each time.
  // This closure variable persists for the lifetime of the content script so
  // "Post anyway → press Post once more" always takes exactly 2 presses total.
  let _composeWarned = false;
  let _composeWarnedTimer = null;

  function hookComposeBtn(btn) {
    if (btn.dataset.gbHooked) return;
    btn.dataset.gbHooked = '1';
    btn.addEventListener('pointerdown', e => {
      if (_composeWarned) return; // already acknowledged — let it through

      const area = document.querySelector(platform.composeSel);
      if (!area) return;
      const text = getTextContent(area);
      if (!text || text.trim().length < 5) return;
      if (!localQuickCheck(text)) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      showReflectionModal({
        postText: text,
        onProceed: () => {
          _composeWarned = true;
          if (_composeWarnedTimer) clearTimeout(_composeWarnedTimer);
          // Auto-reset after 60 s so a heavily-edited follow-up post is still checked.
          _composeWarnedTimer = setTimeout(() => {
            _composeWarned = false;
            _composeWarnedTimer = null;
          }, 60_000);
        },
        onCancel: () => {},
      });
    }, { capture: true });
  }

  function showReflectionModal({ postText, onProceed, onCancel }) {
    const existing = document.querySelector('[data-glassbox="reflection-modal"]');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.setAttribute('data-glassbox', 'reflection-modal');
    overlay.className = 'gb-modal-overlay';

    overlay.innerHTML = `
      <div class="gb-modal" role="dialog" aria-modal="true">
        <div class="gb-modal__header">
          <span class="gb-modal__icon">⚠️</span>
          <span class="gb-modal__title">Before you post</span>
        </div>
        <div class="gb-modal__body">
          <p class="gb-modal__msg">This post may contain content that contradicts verified public records or uses harmful language. Take a moment to review.</p>
          <div class="gb-modal__preview">${escHTML(postText.slice(0, 280))}</div>
        </div>
        <div class="gb-modal__actions">
          <button class="gb-modal__btn gb-modal__btn--cancel" data-action="cancel">Edit my post</button>
          <button class="gb-modal__btn gb-modal__btn--proceed" data-action="proceed">Post anyway → press Post once more</button>
        </div>
      </div>`;

    overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => {
      overlay.remove(); onCancel();
    });
    overlay.querySelector('[data-action="proceed"]').addEventListener('click', () => {
      overlay.remove(); onProceed();
    });

    document.body.appendChild(overlay);
    overlay.querySelector('[data-action="cancel"]').focus();
  }

  // ── Observer / Injector ───────────────────────────────────────────────────────
  const observerQueue = new Set();
  let processing = false;

  async function drainQueue() {
    if (processing) return;
    processing = true;
    for (const el of [...observerQueue]) {
      observerQueue.delete(el);
      await annotatePost(el);
    }
    processing = false;
  }

  const debouncedDrain = debounce(drainQueue, 300);

  function queuePost(el) {
    if (!processedPosts.has(el)) {
      observerQueue.add(el);
      debouncedDrain();
    }
  }

  // Scan for existing posts + watch for new ones
  function startObserver() {
    const scan = () => {
      const posts = document.querySelectorAll(platform.postSel);
      if (posts.length) console.log(`[GlassBox] found ${posts.length} post(s) on page`);
      posts.forEach(queuePost);
    };

    const mo = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(platform.postSel)) queuePost(node);
          node.querySelectorAll?.(platform.postSel).forEach(queuePost);
        }
      }
    });

    mo.observe(document.body, { childList: true, subtree: true });
    scan();

    // Twitter compose button hooking
    if (platformName === 'twitter' && platform.submitBtns.length) {
      const hookAll = () => {
        platform.submitBtns.forEach(sel => document.querySelectorAll(sel).forEach(hookComposeBtn));
      };
      hookAll();
      const composeMo = new MutationObserver(hookAll);
      composeMo.observe(document.body, { childList: true, subtree: true });
      window.__glassboxTeardown = () => { mo.disconnect(); composeMo.disconnect(); };
    } else {
      window.__glassboxTeardown = () => mo.disconnect();
    }
  }

  startObserver();

})();
