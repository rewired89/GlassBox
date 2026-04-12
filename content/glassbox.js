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
    if (!platform.imgSel) return [];
    return Array.from(postEl.querySelectorAll(platform.imgSel))
      .map(img => img.src || img.getAttribute('src'))
      .filter(src => src && src.startsWith('https://'))
      .slice(0, 3);
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

  function renderResonanceIndicator(resonance) {
    const label = resonance.label || 'Neutral';
    const desc  = RESONANCE_DESCRIPTIONS[label] || '';
    const icon  = resonance.score < 35 ? '💢' : (resonance.score < 50 ? '⚠️' : '💬');

    const wrap = document.createElement('div');
    wrap.setAttribute('data-glassbox', 'resonance-indicator');
    wrap.style.cssText = 'display:inline-flex;flex-direction:column;gap:2px;';

    const btn = document.createElement('button');
    btn.className = 'gb-resonance';
    btn.style.cssText = `color:${resonance.color};border-color:${resonance.color}33;background:${resonance.color}11`;
    btn.textContent = `${icon} ${resonance.score}% ${label}`;

    const detail = document.createElement('div');
    detail.className = 'gb-resonance-detail';
    detail.style.cssText = `display:none;font-size:11px;color:${resonance.color};padding:3px 6px;border-radius:4px;background:${resonance.color}11;max-width:220px;line-height:1.4`;
    detail.textContent = desc;

    btn.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      detail.style.display = detail.style.display === 'none' ? 'block' : 'none';
    });

    wrap.appendChild(btn);
    wrap.appendChild(detail);
    return wrap;
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
        ${_resonanceBadgeHTML(resonance)}
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
        ${_resonanceBadgeHTML(resonance)}
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
      return;
    }
    if (!result) { console.log('[GlassBox] API returned null — check API URL and server logs'); return; }

    console.log('[GlassBox] result:', { flagged: result.flagged, figure: result.figure?.name, resonance: result.resonance?.score });

    // Fallback insert point: text element's parent, or the article itself
    const insertPoint = textEl?.parentElement ?? postEl.querySelector('[data-testid="tweetText"]')?.closest('div') ?? postEl;
    if (!insertPoint) return;

    // ── Annotation row (resonance indicator — always shown when score available) ──
    if (settings.showManipulationIndicators && result.resonance) {
      const actionBar = postEl.querySelector(platform.actionSel);
      if (actionBar && !actionBar.querySelector('[data-glassbox="annotation-row"]')) {
        const row = document.createElement('div');
        row.setAttribute('data-glassbox', 'annotation-row');
        row.className = 'gb-post-annotation';
        row.appendChild(renderResonanceIndicator(result.resonance));
        actionBar.appendChild(row);
      }
    }

    // Safe reference: null means "append to end of insertPoint"
    const afterText = textEl?.nextSibling ?? null;

    // ── Fact-check banners ────────────────────────────────────────────────────
    for (const fc of (result.fact_checks || []).slice(0, 2)) {
      insertPoint.insertBefore(renderFactCheckBanner(fc), afterText);
    }

    // ── Image concern banner ──────────────────────────────────────────────────
    if (result.image_concerns) {
      insertPoint.insertBefore(renderImageConcernBanner(result.image_concerns), afterText);
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
  function hookComposeBtn(btn) {
    if (btn.dataset.gbHooked) return;
    btn.dataset.gbHooked = '1';
    btn.addEventListener('pointerdown', e => {
      if (btn.dataset.gbProceed) return;
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
          btn.dataset.gbProceed = '1';
          btn.click();
          setTimeout(() => delete btn.dataset.gbProceed, 500);
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
          <button class="gb-modal__btn gb-modal__btn--proceed" data-action="proceed">Post anyway</button>
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
