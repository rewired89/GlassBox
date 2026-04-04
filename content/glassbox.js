/**
 * GlassBox — Single-file self-contained content script.
 * All modules inlined into one IIFE to avoid ES module loading issues.
 * Injected into Twitter/X pages.
 */
(async function GlassBox() {
  'use strict';

  // ── Guard: run only once ─────────────────────────────────────────────────────
  if (window.__glassboxLoaded) return;
  window.__glassboxLoaded = true;

  // ════════════════════════════════════════════════════════════════════════════
  // UTILS
  // ════════════════════════════════════════════════════════════════════════════

  function extractDomain(url) {
    if (!url) return null;
    try {
      const hostname = new URL(url).hostname;
      return hostname.replace(/^(www\.|m\.|mobile\.|amp\.)+/, '');
    } catch { return null; }
  }

  function extractLinksFromElement(el) {
    return Array.from(el.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(h => h && h.startsWith('http'));
  }

  function getTextContent(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-glassbox]').forEach(n => n.remove());
    return clone.textContent || '';
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  function truncate(text, maxLen = 280) {
    if (!text || text.length <= maxLen) return text;
    return text.slice(0, maxLen - 3) + '…';
  }

  function formatCredibility(score) {
    if (score == null) return { color: '#888', label: 'Unknown', tier: 'unknown' };
    if (score >= 7.5) return { color: '#22c55e', label: score.toFixed(1) + '/10', tier: 'high' };
    if (score >= 5.0) return { color: '#f59e0b', label: score.toFixed(1) + '/10', tier: 'medium' };
    if (score >= 2.5) return { color: '#ef4444', label: score.toFixed(1) + '/10', tier: 'low' };
    return { color: '#fca5a5', label: score.toFixed(1) + '/10', tier: 'very-low' };
  }

  const TACTIC_LABELS = {
    emotional_appeal: 'Emotional Appeal',
    fear_mongering: 'Fear-Mongering',
    false_dichotomy: 'False Dichotomy',
    ad_hominem: 'Ad Hominem',
    appeal_to_authority: 'Questionable Authority',
    bandwagon: 'Bandwagon',
    slippery_slope: 'Slippery Slope',
    dehumanization: 'Dehumanizing Language',
    cherry_picking: 'Cherry-Picked Data',
    missing_context: 'Missing Context',
    conspiracy: 'Conspiracy Framing',
  };
  const TACTIC_ICONS = {
    emotional_appeal: '😡', fear_mongering: '😨', false_dichotomy: '⚖️',
    ad_hominem: '🎯', appeal_to_authority: '🎓', bandwagon: '🐑',
    slippery_slope: '🎿', dehumanization: '🚫', cherry_picking: '🍒',
    missing_context: '📋', conspiracy: '🕵️',
  };
  function getTacticLabel(k) { return TACTIC_LABELS[k] || k; }
  function getTacticIcon(k)  { return TACTIC_ICONS[k]  || '⚠️'; }

  // ════════════════════════════════════════════════════════════════════════════
  // STORAGE  (routed through background service worker → chrome.storage.local)
  //
  // Content scripts run under twitter.com's origin, so their IndexedDB is
  // completely separate from the extension popup's IndexedDB. We route all
  // writes through the background service worker which uses chrome.storage.local
  // — accessible from both the content script and the popup.
  // ════════════════════════════════════════════════════════════════════════════

  function recordPostView(params) {
    chrome.runtime.sendMessage(
      { type: 'RECORD_POST_VIEW', payload: { ...params, timestamp: Date.now() } },
      () => { void chrome.runtime.lastError; } // fire-and-forget, suppress errors
    );
  }

  function recordCardInteraction(cardId, action) {
    chrome.runtime.sendMessage(
      { type: 'RECORD_CARD_INTERACTION', payload: { card_id: cardId, action, timestamp: Date.now() } },
      () => { void chrome.runtime.lastError; }
    );
  }

  const DEFAULT_SETTINGS = {
    enabled: true,
    showCredibilityBadges: true,
    showManipulationIndicators: true,
    showContextCards: true,
    prePostReflection: true,
    manipulationThreshold: 'medium',
    credibilityMinScore: 4,
  };

  function getSettings() {
    return new Promise(resolve => {
      if (typeof chrome === 'undefined' || !chrome.storage) { resolve(DEFAULT_SETTINGS); return; }
      chrome.storage.sync.get('glassbox_settings', r =>
        resolve({ ...DEFAULT_SETTINGS, ...(r.glassbox_settings || {}) })
      );
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // MANIPULATION DETECTOR
  // ════════════════════════════════════════════════════════════════════════════

  let _patternsData = null;

  async function loadPatterns() {
    if (_patternsData) return _patternsData;
    try {
      const url = chrome.runtime.getURL('data/manipulation-patterns.json');
      _patternsData = await fetch(url).then(r => r.json());
    } catch {
      _patternsData = { tactics: {}, thresholds: { low: 0.3, medium: 0.6, high: 1.0 } };
    }
    return _patternsData;
  }

  async function detectManipulation(text) {
    if (!text || text.length < 20)
      return { is_manipulative: false, score: 0, level: 'none', tactics: [], confidence: 0 };

    const data = await loadPatterns();
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const detected = [];
    let total = 0;

    for (const [key, tactic] of Object.entries(data.tactics || {})) {
      const matches = [];
      for (const p of tactic.patterns || []) {
        if (norm.includes(p.toLowerCase())) matches.push(p);
      }
      for (const rstr of tactic.regex_patterns || []) {
        try { if (new RegExp(rstr, 'i').test(norm)) matches.push(rstr); } catch {}
      }
      if (matches.length > 0) {
        const score = (tactic.weight || 1) * Math.min(matches.length, 3);
        detected.push({ tactic: key, label: tactic.label, icon: tactic.icon,
                        description: tactic.description, matches, score });
        total += score;
      }
    }

    const t = data.thresholds || { low: 0.3, medium: 0.6, high: 1.0 };
    const norm2 = Math.min(total, 5);
    const level = norm2 >= t.high ? 'high' : norm2 >= t.medium ? 'medium' : norm2 >= t.low ? 'low' : 'none';
    const confidence = detected.length ? Math.min(0.5 + detected.length * 0.15, 0.95) : 0;

    return {
      is_manipulative: level !== 'none',
      score: total, level,
      tactics: detected.sort((a, b) => b.score - a.score),
      confidence,
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TOXICITY DETECTOR
  // ════════════════════════════════════════════════════════════════════════════

  const TOXIC_PATTERNS = [
    /\b(animals?|vermin|cockroach|parasite|plague|infestation)\b/i,
    /\b(should (be|get) (killed|shot|hanged|executed|eliminated))\b/i,
    /\b(kill (all|every|those))\b/i,
    /\b(go (kill|hang|shoot) yourself)\b/i,
    /\bkys\b/i,
    /\bgo back to (your country|where you came from|africa|mexico|china|the middle east)\b/i,
  ];

  const SENSITIVE_PATTERNS = [
    /\bgo back to your country\b/i,
    /\breal Americans?\b/i,
    /\byou people\b/i,
    /\bthose people\b/i,
    /\bthey (are|'re) (all|just|only)\b/i,
  ];

  function analyzeToxicity(text) {
    if (!text || text.length < 5) return { toxic: false, score: 0, sensitive: false, flags: [] };
    const flags = [];
    let toxicHits = 0, sensitiveHits = 0;

    TOXIC_PATTERNS.forEach(p     => { if (p.test(text)) { toxicHits++;     flags.push('toxicity_pattern');   } });
    SENSITIVE_PATTERNS.forEach(p => { if (p.test(text)) { sensitiveHits++; flags.push('sensitive_language'); } });

    const words = text.split(/\s+/);
    const capsWords = words.filter(w => w.length > 3 && w === w.toUpperCase());
    if (capsWords.length / words.length > 0.3) flags.push('excessive_caps');
    if ((text.match(/!/g) || []).length > 3)   flags.push('excessive_punctuation');

    return {
      toxic: toxicHits > 0,
      score: Math.min(toxicHits * 0.4 + sensitiveHits * 0.15, 1),
      sensitive: sensitiveHits > 0 || flags.includes('excessive_caps'),
      flags: [...new Set(flags)],
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CREDIBILITY DETECTOR
  // ════════════════════════════════════════════════════════════════════════════

  function getBadgeFromBackground(domain) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_BADGE', payload: { domain } }, response => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response || null);
      });
    });
  }

  async function getPostCredibility(postEl) {
    const SKIP = ['t.co', 'twitter.com', 'x.com', 'youtu.be', 'bit.ly', 'ow.ly'];
    const links = extractLinksFromElement(postEl);
    if (!links.length) return [];
    const domains = [...new Set(links.map(extractDomain).filter(d => d && !SKIP.includes(d)))];
    if (!domains.length) return [];
    const results = await Promise.all(domains.map(d => getBadgeFromBackground(d).then(b => ({ domain: d, badge: b }))));
    return results.filter(r => r.badge !== null);
  }

  function getPrimaryCredibilityInfo(results) {
    const scored = results.filter(r => r.badge && r.badge.score != null);
    if (!scored.length) return null;
    return scored.reduce((min, r) => r.badge.score < min.badge.score ? r : min, scored[0]).badge;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CONTEXT CARDS
  // ════════════════════════════════════════════════════════════════════════════

  let _cardDatabase = null;

  async function loadCards() {
    if (_cardDatabase) return _cardDatabase;
    try {
      const url = chrome.runtime.getURL('data/context-cards.json');
      const json = await fetch(url).then(r => r.json());
      _cardDatabase = json.cards || [];
    } catch { _cardDatabase = []; }
    return _cardDatabase;
  }

  async function findMatchingCards(text) {
    const cards = await loadCards();
    const norm = text.toLowerCase();
    return cards.filter(c => (c.trigger_phrases || []).some(p => norm.includes(p.toLowerCase())));
  }

  function renderContextCard(cardDef) {
    const { id, card } = cardDef;
    const wrap = document.createElement('div');
    wrap.setAttribute('data-glassbox', 'context-card');
    wrap.className = 'gb-card';

    const timelineHTML = (card.timeline || []).map(i => `
      <div class="gb-card__timeline-item">
        <div class="gb-card__timeline-date">${i.date}</div>
        <div class="gb-card__timeline-event">${i.event}</div>
      </div>`).join('');

    const sourcesHTML = card.sources?.length ? `
      <div class="gb-card__sources">
        <div class="gb-card__sources-label">Sources</div>
        <ul class="gb-card__source-list">
          ${card.sources.map(s => `<li class="gb-card__source-item">${s}</li>`).join('')}
        </ul>
      </div>` : '';

    const rephraseHTML = cardDef.rephrase_suggestions?.length ? `
      <div class="gb-card__rephrase">
        <div class="gb-card__rephrase-label">How to rephrase</div>
        ${cardDef.rephrase_suggestions.map(r => `<div class="gb-card__rephrase-item">${r}</div>`).join('')}
      </div>` : '';

    wrap.innerHTML = `
      <button class="gb-card__trigger" aria-expanded="false">
        <span class="gb-card__trigger-icon">📌</span>
        <span class="gb-card__trigger-text">${card.hook}</span>
        <span class="gb-card__trigger-arrow">▼</span>
      </button>
      <div class="gb-card__body">
        <div class="gb-card__title">${card.title}</div>
        ${timelineHTML ? `<div class="gb-card__timeline">${timelineHTML}</div>` : ''}
        ${card.irony_highlight ? `<div class="gb-card__highlight">${card.irony_highlight}</div>` : ''}
        ${card.empathy_angle  ? `<div class="gb-card__empathy">💭 ${card.empathy_angle}</div>` : ''}
        ${rephraseHTML}${sourcesHTML}
      </div>`;

    wrap.querySelector('.gb-card__trigger').addEventListener('click', e => {
      e.stopPropagation();
      const expanded = wrap.classList.toggle('gb-card--expanded');
      wrap.querySelector('.gb-card__trigger').setAttribute('aria-expanded', expanded);
      if (expanded) recordCardInteraction(id, 'expand').catch(() => {});
    });

    return wrap;
  }

  async function injectContextCards(text, container) {
    const matches = await findMatchingCards(text);
    matches.slice(0, 2).forEach(c => container.appendChild(renderContextCard(c)));
    return matches.length;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // INDICATOR UI  (badges + popovers)
  // ════════════════════════════════════════════════════════════════════════════

  function removePopover() {
    document.querySelector('[data-glassbox="popover"]')?.remove();
    document.removeEventListener('click', _outsideClickHandler, { capture: true });
  }

  function _outsideClickHandler(e) {
    if (!e.target.closest('[data-glassbox="popover"]')) removePopover();
  }

  function positionPopover(pop, anchor) {
    const r = anchor.getBoundingClientRect();
    let top  = r.bottom + window.scrollY + 6;
    let left = r.left   + window.scrollX;
    if (left + 300 > window.innerWidth - 16) left = window.innerWidth - 316;
    if (r.bottom + 250 > window.innerHeight) top = r.top + window.scrollY - 256;
    pop.style.cssText = `top:${top}px;left:${left}px`;
  }

  function showCredibilityPopover(badge, anchor) {
    removePopover();
    const pop = document.createElement('div');
    pop.setAttribute('data-glassbox', 'popover');
    pop.className = 'gb-popover';

    const scoreColor = { high: '#22c55e', medium: '#f59e0b', low: '#ef4444', 'very-low': '#fca5a5', satire: '#a855f7' }[badge.tier] || '#9ca3af';
    const scoreDisplay = badge.score != null
      ? `<div class="gb-popover__score" style="color:${scoreColor}">${badge.score}/10</div>`
      : `<div class="gb-popover__score" style="color:#a855f7">Satire</div>`;

    const strengthsHTML = badge.strengths?.length
      ? `<div class="gb-popover__section"><div class="gb-popover__section-title">Strengths</div>
         <ul class="gb-popover__list">${badge.strengths.map(s => `<li>${s}</li>`).join('')}</ul></div>` : '';

    const considerationsHTML = badge.considerations?.length
      ? `<div class="gb-popover__section"><div class="gb-popover__section-title">Considerations</div>
         <ul class="gb-popover__list">${badge.considerations.map(c => `<li>${c}</li>`).join('')}</ul></div>` : '';

    pop.innerHTML = `
      <div class="gb-popover__header">
        <div class="gb-popover__title">Source Credibility</div>
        <button class="gb-popover__close">✕</button>
      </div>
      ${scoreDisplay}
      <div class="gb-popover__meta">${badge.label || ''} &bull; ${badge.bias || ''}</div>
      <hr class="gb-popover__divider">
      ${strengthsHTML}${considerationsHTML}
      <div class="gb-popover__meta" style="margin-top:10px">Rated by NewsGuard · MBFC · Ad Fontes</div>`;

    pop.querySelector('.gb-popover__close').addEventListener('click', removePopover);
    document.body.appendChild(pop);
    positionPopover(pop, anchor);
    setTimeout(() => document.addEventListener('click', _outsideClickHandler, { once: true, capture: true }), 0);
  }

  function showManipulationPopover(result, anchor) {
    removePopover();
    const pop = document.createElement('div');
    pop.setAttribute('data-glassbox', 'popover');
    pop.className = 'gb-popover';

    pop.innerHTML = `
      <div class="gb-popover__header">
        <div class="gb-popover__title">⚠️ Manipulation Detected</div>
        <button class="gb-popover__close">✕</button>
      </div>
      <div class="gb-popover__meta">${result.tactics.length} tactic(s) &bull; ${Math.round(result.confidence * 100)}% confidence</div>
      <hr class="gb-popover__divider">
      <ul class="gb-popover__list" style="display:flex;flex-direction:column;gap:8px">
        ${result.tactics.slice(0, 4).map(t => `
          <li><span>${t.icon}</span>
            <div><strong style="color:#e7e9ea">${t.label}</strong>
              <div style="font-size:11px;color:#9ca3af;margin-top:2px">${t.description}</div>
            </div>
          </li>`).join('')}
      </ul>
      <div class="gb-popover__meta" style="margin-top:10px">Rated by NewsGuard · MBFC · Ad Fontes</div>`;

    pop.querySelector('.gb-popover__close').addEventListener('click', removePopover);
    document.body.appendChild(pop);
    positionPopover(pop, anchor);
    setTimeout(() => document.addEventListener('click', _outsideClickHandler, { once: true, capture: true }), 0);
  }

  function createCredibilityBadge(badge) {
    const btn = document.createElement('button');
    btn.setAttribute('data-glassbox', 'credibility-badge');
    btn.className = `gb-badge gb-badge--${badge.tier}`;
    btn.textContent = badge.tier === 'satire' ? '🎭 Satire'
      : badge.score != null ? `✓ ${formatCredibility(badge.score).label}` : '? Unrated';
    btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showCredibilityPopover(badge, btn); });
    return btn;
  }

  function createManipulationIndicator(result) {
    const t = result.tactics[0];
    const btn = document.createElement('button');
    btn.setAttribute('data-glassbox', 'manipulation-indicator');
    btn.className = `gb-indicator gb-indicator--${result.level}`;
    btn.textContent = t ? `${t.icon} ${t.label}` : '⚠️ Manipulation detected';
    btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); showManipulationPopover(result, btn); });
    return btn;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PRE-POST REFLECTION MODAL
  // ════════════════════════════════════════════════════════════════════════════

  function removeModal() {
    document.querySelector('[data-glassbox="modal-overlay"]')?.remove();
  }

  function showReflectionModal({ manipulation, toxicity, credibility, postText, onProceed, onCancel }) {
    removeModal();

    const hasToxic       = toxicity?.toxic;
    const hasSensitive   = toxicity?.sensitive;
    const hasManipulation = manipulation?.is_manipulative;
    const hasLowCred     = credibility?.score != null && credibility.score < 4;

    let emoji = '💭', headline = 'Before you share…', subline = 'GlassBox found some things worth knowing.';
    if (hasToxic)        { emoji = '🤔'; headline = 'Quick thought before you post'; subline = 'This language may have more impact than you expect.'; }
    else if (hasLowCred) { emoji = '⚠️'; subline = 'The linked source has a low credibility rating.'; }
    else if (hasManipulation) { emoji = '🔍'; headline = 'Heads up'; subline = 'This content uses patterns associated with manipulation.'; }

    const findings = [];
    if (hasLowCred)      findings.push({ icon: '⚠️', text: `Source rated ${credibility.score}/10 credibility`, detail: credibility.label });
    if (hasToxic)        findings.push({ icon: '🚫', text: 'Contains potentially harmful language', detail: null });
    else if (hasSensitive) findings.push({ icon: '💬', text: 'Contains language with historical or social weight', detail: null });
    if (hasManipulation) findings.push({ icon: '🎭', text: `${manipulation.tactics.length} manipulation tactic(s) detected`,
                                         detail: manipulation.tactics.slice(0, 2).map(t => t.label).join(', ') });

    const findingsHTML = findings.length ? `
      <div class="gb-modal__findings">
        ${findings.map(f => `
          <div class="gb-modal__finding">
            <span class="gb-modal__finding-icon">${f.icon}</span>
            <div>${f.text}${f.detail ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">${f.detail}</div>` : ''}</div>
          </div>`).join('')}
      </div>` : '';

    // Context card for the post text
    const contextCardContainer = document.createElement('div');
    contextCardContainer.id = 'gb-modal-cards';

    const overlay = document.createElement('div');
    overlay.setAttribute('data-glassbox', 'modal-overlay');
    overlay.className = 'gb-modal-overlay';

    const modal = document.createElement('div');
    modal.setAttribute('data-glassbox', 'modal');
    modal.className = 'gb-modal';
    modal.innerHTML = `
      <div class="gb-modal__emoji">${emoji}</div>
      <div class="gb-modal__headline">${headline}</div>
      <div class="gb-modal__subline">${subline}</div>
      ${postText ? `<div style="font-size:12px;color:#6b7280;background:#0f1117;border-radius:8px;padding:8px 10px;margin-bottom:14px;border-left:3px solid #374151;font-style:italic">"${postText}"</div>` : ''}
      ${findingsHTML}
      <div id="gb-modal-cards-slot"></div>
      <div class="gb-modal__actions">
        <button class="gb-modal__btn gb-modal__btn--secondary" data-action="cancel">Cancel</button>
        <button class="gb-modal__btn gb-modal__btn--proceed"   data-action="proceed">Post anyway</button>
      </div>
      <div style="font-size:10px;color:#374151;margin-top:12px;text-align:center">GlassBox &bull; Helping you think before you post.</div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Inject context cards into modal
    if (postText) {
      findMatchingCards(postText).then(matches => {
        const slot = modal.querySelector('#gb-modal-cards-slot');
        if (slot && matches.length) {
          matches.slice(0, 1).forEach(c => slot.appendChild(renderContextCard(c)));
        }
      });
    }

    overlay.addEventListener('click', e => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'proceed') { removeModal(); onProceed?.(); }
      else if (action === 'cancel' || e.target === overlay) { removeModal(); onCancel?.(); }
    });

    // Focus first button
    modal.querySelector('[data-action="cancel"]')?.focus();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ANNOTATION ENGINE  (platform-agnostic)
  // ════════════════════════════════════════════════════════════════════════════

  const processedPosts = new WeakSet();
  let _cachedSettings = null;
  let _settingsTs = 0;

  async function getCachedSettings() {
    const now = Date.now();
    if (!_cachedSettings || now - _settingsTs > 10000) {
      _cachedSettings = await getSettings();
      _settingsTs = now;
    }
    return _cachedSettings;
  }

  async function annotatePost(postEl, { getTextEl, getActionBar }) {
    if (processedPosts.has(postEl)) return;
    processedPosts.add(postEl);

    const settings = await getCachedSettings();
    if (!settings.enabled) return;

    const textEl = getTextEl(postEl);
    const text   = textEl ? getTextContent(textEl) : '';
    if (!text || text.trim().length < 20) return;

    const [manipulation, credResults] = await Promise.all([
      settings.showManipulationIndicators ? detectManipulation(text) : Promise.resolve(null),
      settings.showCredibilityBadges      ? getPostCredibility(postEl) : Promise.resolve([]),
    ]);
    const toxicity   = settings.showManipulationIndicators ? analyzeToxicity(text) : null;
    const primaryCred = getPrimaryCredibilityInfo(credResults);

    // Annotation row
    const actionBar = getActionBar(postEl);
    if (actionBar) {
      const row = document.createElement('div');
      row.setAttribute('data-glassbox', 'annotation-row');
      row.className = 'gb-post-annotation';

      if (settings.showCredibilityBadges && primaryCred) {
        row.appendChild(createCredibilityBadge(primaryCred));
      }

      if (settings.showManipulationIndicators && manipulation?.is_manipulative) {
        const levels = { low: ['low','medium','high'], medium: ['medium','high'], high: ['high'] };
        if ((levels[settings.manipulationThreshold] || levels.medium).includes(manipulation.level)) {
          row.appendChild(createManipulationIndicator(manipulation));
        }
      }

      if (row.children.length) actionBar.appendChild(row);
    }

    // Context cards
    if (settings.showContextCards && textEl) {
      const cardContainer = document.createElement('div');
      cardContainer.setAttribute('data-glassbox', 'card-container');
      const count = await injectContextCards(text, cardContainer);
      if (count > 0) textEl.parentElement?.insertBefore(cardContainer, textEl.nextSibling);
    }

    // Record view
    recordPostView({
      platform: 'twitter',
      source_domain: primaryCred?.domain || null,
      credibility_score: primaryCred?.score || null,
      manipulation_detected: manipulation?.is_manipulative || false,
      tactics_used: manipulation?.tactics?.map(t => t.tactic) || [],
      user_engaged: false,
      engagement_type: 'view',
      post_text_hash: hashString(text.slice(0, 100)),
    }).catch(() => {});
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TWITTER / X INJECTOR
  // ════════════════════════════════════════════════════════════════════════════

  const SEL = {
    tweet:       'article[data-testid="tweet"]',
    tweetText:   'div[data-testid="tweetText"]',
    actionBar:   'div[role="group"][aria-label]',
    composeArea: 'div[data-testid="tweetTextarea_0"]',
    submitBtns:  ['button[data-testid="tweetButtonInline"]',
                  'button[data-testid="tweetButton"]',
                  'button[data-testid="sendDmButton"]'],
  };

  function getTextEl(tweetEl)   { return tweetEl.querySelector(SEL.tweetText); }
  function getActionBar(tweetEl){ return tweetEl.querySelector(SEL.actionBar); }

  async function processTweet(tweetEl) {
    await annotatePost(tweetEl, { getTextEl, getActionBar });
  }

  // ── Compose box intercept ──────────────────────────────────────────────────

  function hookComposeBtn(btn) {
    if (btn.dataset.gbHooked) return;
    btn.dataset.gbHooked = '1';

    btn.addEventListener('click', async e => {
      const settings = await getCachedSettings();
      if (!settings.prePostReflection) return;
      if (btn.dataset.gbProceed) return;

      const composeEl = document.querySelector(SEL.composeArea);
      const text = composeEl?.textContent?.trim() || '';
      if (text.length < 5) return;

      const [manipulation, toxicity] = await Promise.all([
        detectManipulation(text),
        Promise.resolve(analyzeToxicity(text)),
      ]);

      const shouldShow =
        toxicity.toxic || toxicity.sensitive ||
        (manipulation.is_manipulative && manipulation.level !== 'low');

      if (!shouldShow) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      showReflectionModal({
        manipulation, toxicity,
        credibility: null,
        postText: truncate(text, 120),
        onProceed: () => { btn.dataset.gbProceed = '1'; btn.click(); },
        onCancel:  () => {},
      });
    }, true); // capture phase
  }

  function watchComposeBox() {
    const check = () => {
      SEL.submitBtns.forEach(sel =>
        document.querySelectorAll(sel).forEach(btn => hookComposeBtn(btn))
      );
    };
    check();
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
  }

  // ── Feed observer ──────────────────────────────────────────────────────────

  function watchFeed() {
    const debouncedScan = debounce(() => {
      document.querySelectorAll(SEL.tweet).forEach(el => {
        if (!processedPosts.has(el)) processTweet(el);
      });
    }, 300);

    new MutationObserver(mutations => {
      let found = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(SEL.tweet)) { processTweet(node); found = true; }
          node.querySelectorAll?.(SEL.tweet).forEach(el => { processTweet(el); found = true; });
        }
      }
      if (!found) debouncedScan();
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  async function init() {
    const settings = await getSettings();
    if (!settings.enabled) return;

    // Process tweets already in DOM
    document.querySelectorAll(SEL.tweet).forEach(el => processTweet(el));

    watchFeed();
    watchComposeBox();

    console.info('[GlassBox] Twitter injector active. ✓');
  }

  init();

})();
