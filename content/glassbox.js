/**
 * GlassBox — Single-file self-contained content script.
 * All modules inlined into one IIFE to avoid ES module loading issues.
 * Injected into Twitter/X pages.
 */
(async function GlassBox() {
  'use strict';

  // ── Teardown previous instance, then run fresh ────────────────────────────────
  // On extension reload Chrome re-injects into open tabs. Calling the previous
  // instance's teardown disconnects its observers and resets button hooks so the
  // new code fully takes over — no stale handlers, no duplicate observers.
  if (typeof window.__glassboxTeardown === 'function') {
    window.__glassboxTeardown();
    await new Promise(r => setTimeout(r, 30)); // let teardown settle
  }
  document.querySelectorAll('[data-glassbox]').forEach(el => el.remove());

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
  // STORAGE  (chrome.storage.local — shared between content script and popup)
  //
  // chrome.storage.local is extension storage, NOT origin-scoped like IndexedDB.
  // Content scripts, background, and popup all access the same store directly.
  // ════════════════════════════════════════════════════════════════════════════

  const STORAGE_KEY = 'gb_post_views';
  const MAX_DAYS    = 90;

  async function recordPostView(params) {
    try {
      const data   = { ...params, timestamp: Date.now() };
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const views  = result[STORAGE_KEY] || [];
      views.push(data);
      const cutoff  = Date.now() - MAX_DAYS * 24 * 60 * 60 * 1000;
      await chrome.storage.local.set({ [STORAGE_KEY]: views.filter(v => v.timestamp >= cutoff) });
    } catch {
      // storage failure is non-critical
    }
  }

  function recordCardInteraction(cardId, action) {
    // Phase 2: track card engagement in chrome.storage.local
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
    // Dehumanizing slurs — almost always used to describe people, not literal creatures
    /\b(vermin|cockroaches?|parasites?|subhuman)\b/i,
    // "animals" is a common word, only flag when directed at a human group
    /\b(they|those|these|immigrants?|refugees?|you people).{0,40}\banimals?\b/i,
    /\banimals?\b.{0,20}\b(immigrants?|refugees?|those people|these people)\b/i,
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

  // Named animals — when text is specifically about a real animal (not using "animals"
  // as a slur against a human group), dehumanization patterns don't apply.
  const NAMED_ANIMALS_RE = /\b(monkey|elephant|dog|cat|bear|lion|tiger|gorilla|chimpanzee|chimp|bird|snake|fox|wolf|deer|horse|cow|pig|rat|mouse|fish|shark|whale|dolphin|parrot|rabbit|squirrel|raccoon|alligator|crocodile|kangaroo|koala|panda|penguin|crow|pigeon|owl|eagle|hawk|giraffe|zebra|hippo|rhino|cheetah|leopard|jaguar|moose|bison|buffalo|donkey|sheep|goat|chicken|duck|goose|turkey|hamster|otter|seal|llama|camel|sloth|iguana|lizard|turtle|frog|toad|bee|spider|crab|lobster|octopus|jellyfish|flamingo|peacock)\b/i;
  const HUMAN_GROUP_TARGETS_RE = /\b(immigrant|refugee|liberal|conservative|democrat|republican|muslim|jew|christian|black people|white people|latino|hispanic|asian|those people|these people|you people|people like (them|us|you))\b/i;

  function analyzeToxicity(text) {
    if (!text || text.length < 5) return { toxic: false, score: 0, sensitive: false, flags: [] };

    // If the text is about a named animal and doesn't target a human group, clear the flag
    const hasNamedAnimal   = NAMED_ANIMALS_RE.test(text);
    const hasHumanTarget   = HUMAN_GROUP_TARGETS_RE.test(text);
    const animalOnlyContext = hasNamedAnimal && !hasHumanTarget;

    const flags = [];
    let toxicHits = 0, sensitiveHits = 0;

    TOXIC_PATTERNS.forEach(p => {
      if (!p.test(text)) return;
      // Skip "animals" patterns when text is clearly about a real animal, not a slur
      if (animalOnlyContext && p.source.includes('animals?')) return;
      toxicHits++;
      flags.push('toxicity_pattern');
    });
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
  // PSYCHOLINGUISTIC ENGINE  — Sympathetic Resonance & Toxic Affect
  //
  // Sympathetic Resonance (0–100): how much the text uses empathy, inclusivity,
  // constructive framing, and humanizing language.
  //
  // Toxic Affect (0–100): how much the text carries aggression, dehumanization,
  // absolutism, and attack-oriented language.
  //
  // Both scores are computed synchronously from word-list and pattern matching,
  // modeled on LIWC (Linguistic Inquiry and Word Count) psycholinguistic research.
  // ════════════════════════════════════════════════════════════════════════════

  const EMPATHY_MARKERS = [
    'understand', 'imagine', 'feel', 'feelings', 'together', 'community',
    'support', 'compassion', 'care', 'listen', 'respect', 'acknowledge',
    'grief', 'heal', 'justice', 'rights', 'dignity', 'humanity', 'empathy',
    'solidarity', 'concern', 'protect', 'voice', 'story', 'family',
    'children', 'mothers', 'sisters', 'survivors', 'loved ones', 'wellbeing',
  ];

  const CONSTRUCTIVE_VERBS = [
    'build', 'improve', 'solve', 'address', 'advocate', 'reform', 'invest',
    'create', 'develop', 'strengthen', 'collaborate', 'commit', 'pursue',
    'achieve', 'restore', 'reconcile', 'honour', 'recognize', 'empower',
  ];

  const ATTACK_MARKERS = [
    'idiot', 'stupid', 'moron', 'pathetic', 'disgusting', 'loser', 'clown',
    'trash', 'garbage', 'filth', 'scum', 'coward', 'liar', 'fraud',
    'useless', 'incompetent', 'corrupt', 'hypocrisy', 'hypocrite',
  ];

  const ABSOLUTIST_RE = [
    /\ball (of )?them\b/i,
    /\bevery single (one|person|immigrant|liberal|conservative)\b/i,
    /\bnone of them\b/i,
    /\b(always|never) (care|listen|help|tell the truth|work)\b/i,
    /\ball (liberals?|conservatives?|immigrants?|muslims?|jews?|christians?)\b/i,
  ];

  function computeResonanceScore(text, precomputedToxicity) {
    if (!text || text.length < 10) return { resonance: 50, affect: 0, label: 'Neutral', color: '#9ca3af' };
    const norm    = text.toLowerCase();
    const words   = norm.split(/\s+/);
    const wCount  = Math.max(words.length, 1);

    let resonance = 50;
    let affect    = 0;

    // ── Positive resonance signals ──────────────────────────────────────────
    const empathyHits     = EMPATHY_MARKERS.filter(m => norm.includes(m)).length;
    const constructHits   = CONSTRUCTIVE_VERBS.filter(v => norm.includes(v)).length;
    resonance += Math.min(empathyHits * 4, 20);
    resonance += Math.min(constructHits * 3, 12);

    // Hedged opinion ("I think", "I believe") — non-assertive, lower threat
    if (/\bi (think|believe|feel|wonder|hope)\b/.test(norm)) resonance += 5;

    // Inclusive "we" framing
    if (/\b(our community|together|we can|let'?s|collective)\b/.test(norm)) resonance += 6;

    // Single genuine question (curiosity, not rhetorical gotcha)
    if (/\?/.test(text) && (text.match(/\?/g) || []).length === 1) resonance += 3;

    // ── Negative resonance / positive affect signals ─────────────────────────
    const attackHits      = ATTACK_MARKERS.filter(w => norm.includes(w)).length;
    const absolutistHits  = ABSOLUTIST_RE.filter(r => r.test(norm)).length;
    resonance -= Math.min(attackHits * 6, 25);
    resonance -= absolutistHits * 5;
    affect    += Math.min(attackHits * 8, 30);
    affect    += absolutistHits * 8;

    // Toxicity (use pre-computed result if available to avoid double-run)
    const tox = precomputedToxicity || analyzeToxicity(text);
    if (tox.toxic)     { resonance -= 30; affect += 40; }
    else if (tox.sensitive) { resonance -= 10; affect += 15; }

    // Excessive caps
    const capsRatio = words.filter(w => w.length > 3 && w.toUpperCase() === w && /[A-Z]/.test(w)).length / wCount;
    if (capsRatio > 0.2) { resonance -= 10; affect += 10; }

    // Excessive punctuation
    if ((text.match(/!/g) || []).length > 2) { resonance -= 5; affect += 5; }

    // ── Clamp & label ────────────────────────────────────────────────────────
    resonance = Math.max(0, Math.min(100, Math.round(resonance)));
    affect    = Math.max(0, Math.min(100, Math.round(affect)));

    let label, color;
    if      (resonance >= 70) { label = 'Empathetic';  color = '#22c55e'; }
    else if (resonance >= 50) { label = 'Neutral';     color = '#9ca3af'; }
    else if (resonance >= 30) { label = 'Dismissive';  color = '#f59e0b'; }
    else                      { label = 'Hostile';     color = '#ef4444'; }

    return { resonance, affect, label, color };
  }

  function createResonanceIndicator(score) {
    const btn = document.createElement('button');
    btn.setAttribute('data-glassbox', 'resonance-indicator');
    btn.className = 'gb-resonance';
    btn.style.cssText = `color:${score.color};border-color:${score.color}33;background:${score.color}11`;
    btn.title = `Sympathetic Resonance: ${score.resonance}%  |  Toxic Affect: ${score.affect}%`;
    btn.textContent = `${score.resonance < 35 ? '💢' : '💭'} ${score.resonance}% resonance`;
    // No popover for now — tooltip is sufficient
    btn.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); });
    return btn;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // CREDIBILITY DETECTOR
  // ════════════════════════════════════════════════════════════════════════════

  function getBadgeFromBackground(domain) {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 2000);
      try {
        chrome.runtime.sendMessage({ type: 'GET_BADGE', payload: { domain } }, response => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response || null);
        });
      } catch { clearTimeout(timer); resolve(null); }
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
    const norm = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');
    return cards.filter(c => !c.is_fallback && (c.trigger_phrases || []).some(p => {
      // Exact substring match first
      if (norm.includes(p.toLowerCase())) return true;
      // Also match if all significant words in the phrase appear in the text
      const words = p.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      return words.length >= 2 && words.every(w => norm.includes(w));
    }));
  }

  // findBestCard — guaranteed to return a card when content is flagged:
  // 1. Try trigger phrase match  2. Try topic keyword match  3. Return generic fallback
  async function findBestCard(text) {
    const cards = await loadCards();
    const norm = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');

    // 1. Trigger phrase match
    const byPhrase = cards.filter(c => !c.is_fallback && (c.trigger_phrases || []).some(p => {
      if (norm.includes(p.toLowerCase())) return true;
      const words = p.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      return words.length >= 2 && words.every(w => norm.includes(w));
    }));
    if (byPhrase.length) return [byPhrase[0]];

    // 2. Topic keyword matching
    const TOPIC_KEYWORDS = [
      { id: 'immigration_history',         keys: ['immigrant', 'immigration', 'border', 'deport', 'migrant', 'undocumented', 'illegal alien'] },
      { id: 'native_american_indigeneity', keys: ['native american', 'indigenous', 'tribe', 'real american', 'our country', 'belong here'] },
      { id: 'climate_change_consensus',    keys: ['climate', 'global warming', 'carbon', 'greenhouse', 'emissions'] },
      { id: 'vaccine_safety',              keys: ['vaccine', 'vaccin', 'immuniz', 'autism', 'anti-vax', 'vax'] },
      { id: 'election_integrity',          keys: ['election', 'vote', 'ballot', 'stolen', 'fraud', 'dominion'] },
      { id: 'lgbtq_history',               keys: ['gay', 'lesbian', 'trans', 'lgbt', 'queer', 'gender', 'groomer'] },
      { id: 'systemic_racism',             keys: ['racist', 'racism', 'racial', 'black lives', 'white suprema', 'race card'] },
    ];
    for (const { id, keys } of TOPIC_KEYWORDS) {
      if (keys.some(k => norm.includes(k))) {
        const card = cards.find(c => c.id === id);
        if (card) return [card];
      }
    }

    // 3. Generic fallback — always shown when content is flagged but no specific card matches
    const fallback = cards.find(c => c.is_fallback);
    return fallback ? [fallback] : [];
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
      if (expanded) recordCardInteraction(id, 'expand');
    });

    return wrap;
  }

  async function injectContextCards(text, container) {
    const matches = await findMatchingCards(text);
    matches.slice(0, 2).forEach(c => container.appendChild(renderContextCard(c)));
    return matches.length;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FACT-CHECK ENGINE  — detects when content contradicts verified public records
  // ════════════════════════════════════════════════════════════════════════════

  let _factCheckDB = null;

  async function loadFactChecks() {
    if (_factCheckDB) return _factCheckDB;
    try {
      const url = chrome.runtime.getURL('data/fact-checks.json');
      const json = await fetch(url).then(r => r.json());
      _factCheckDB = json.fact_checks || [];
    } catch { _factCheckDB = []; }
    return _factCheckDB;
  }

  // Returns fact_checks whose claim_pattern AND context_keyword both appear in text.
  // Requiring both prevents false positives (e.g. "not stolen" without election context).
  async function detectFalseClaims(text) {
    if (!text || text.length < 15) return [];
    const checks = await loadFactChecks();
    const norm = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ');
    return checks.filter(fc => {
      const claimMatch = (fc.claim_patterns || []).some(p => norm.includes(p.toLowerCase()));
      if (!claimMatch) return false;
      if (fc.context_keywords?.length) {
        return fc.context_keywords.some(k => norm.includes(k.toLowerCase()));
      }
      return true;
    });
  }

  function renderFactCheckBanner(fc) {
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'fact-check-banner');
    el.className = 'gb-factcheck';
    el.innerHTML = `
      <div class="gb-factcheck__header">
        <span class="gb-factcheck__icon">🔎</span>
        <span class="gb-factcheck__verdict">${fc.verdict}</span>
      </div>
      <div class="gb-factcheck__fact">${fc.fact}</div>
      <a class="gb-factcheck__source" href="${fc.source_url}" target="_blank" rel="noopener noreferrer">📄 ${fc.source}</a>`;
    return el;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // USER CONTEXT SYSTEM  — per-user public record links stored locally
  // ════════════════════════════════════════════════════════════════════════════

  const USER_CONTEXT_KEY = 'gb_user_context';

  async function loadUserContext(hash) {
    try {
      const result = await chrome.storage.local.get(USER_CONTEXT_KEY);
      return (result[USER_CONTEXT_KEY] || {})[hash] || [];
    } catch { return []; }
  }

  async function saveUserContext(hash, url, note) {
    try {
      const result = await chrome.storage.local.get(USER_CONTEXT_KEY);
      const all = result[USER_CONTEXT_KEY] || {};
      if (!all[hash]) all[hash] = [];
      all[hash].push({ url, note: note || '', timestamp: Date.now() });
      all[hash] = all[hash].slice(-10); // cap at 10 per tweet
      await chrome.storage.local.set({ [USER_CONTEXT_KEY]: all });
    } catch {}
  }

  function renderUserContextCard(items) {
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'user-context-card');
    el.className = 'gb-user-context';
    const linksHTML = items.map(item => `
      <li class="gb-user-context__item">
        <a href="${item.url}" target="_blank" rel="noopener noreferrer" class="gb-user-context__link">
          ${item.note || item.url.replace(/^https?:\/\//, '').slice(0, 70)}
        </a>
      </li>`).join('');
    el.innerHTML = `
      <div class="gb-user-context__header"><span>📎</span><span>Public Records — Added by You</span></div>
      <ul class="gb-user-context__list">${linksHTML}</ul>`;
    return el;
  }

  function showAddContextForm(anchorEl, hash, textEl) {
    document.querySelectorAll('[data-glassbox="context-form"]').forEach(f => f.remove());
    const form = document.createElement('div');
    form.setAttribute('data-glassbox', 'context-form');
    form.className = 'gb-context-form';
    form.innerHTML = `
      <div class="gb-context-form__title">📎 Link a public record</div>
      <input class="gb-context-form__input" placeholder="URL to report, inquiry, or official source…" type="url">
      <input class="gb-context-form__note" placeholder="Brief description (optional)">
      <div class="gb-context-form__actions">
        <button class="gb-context-form__submit gb-btn gb-btn--primary" style="font-size:12px;padding:5px 10px">Save</button>
        <button class="gb-context-form__cancel gb-btn gb-btn--ghost" style="font-size:12px;padding:5px 10px">Cancel</button>
      </div>`;

    const urlInput = form.querySelector('.gb-context-form__input');
    const noteInput = form.querySelector('.gb-context-form__note');

    form.querySelector('.gb-context-form__cancel').addEventListener('click', e => {
      e.stopPropagation(); form.remove();
    });
    form.querySelector('.gb-context-form__submit').addEventListener('click', async e => {
      e.stopPropagation();
      const url = urlInput.value.trim();
      if (!url || !url.startsWith('http')) {
        urlInput.style.borderColor = '#ef4444'; return;
      }
      await saveUserContext(hash, url, noteInput.value.trim());
      form.remove();
      // Show ✓ confirmation inline
      const confirm = document.createElement('span');
      confirm.setAttribute('data-glassbox', 'ctx-confirm');
      confirm.className = 'gb-context-confirm';
      confirm.textContent = '✓ Saved';
      anchorEl.after(confirm);
      setTimeout(() => confirm.remove(), 2500);
      // Re-render context card
      if (textEl) {
        textEl.parentElement?.querySelector('[data-glassbox="user-context-card"]')?.remove();
        const newCtx = await loadUserContext(hash);
        if (newCtx.length) {
          textEl.parentElement?.insertBefore(renderUserContextCard(newCtx), textEl.nextSibling);
        }
      }
    });

    anchorEl.after(form);
    urlInput.focus();
  }

  function createAddContextButton(hash, textEl) {
    const btn = document.createElement('button');
    btn.setAttribute('data-glassbox', 'add-context-btn');
    btn.className = 'gb-add-context';
    btn.textContent = '📎 Add Context';
    btn.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      showAddContextForm(btn, hash, textEl);
    });
    return btn;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PUBLIC FIGURE ACCOUNTABILITY  — Accountability Cards for known public figures
  //
  // Schema: data/public-figures.json
  // Each entry has: handles[], legal_proceedings[], fact_check_discrepancies[],
  // financial_ties[].  All data must be sourced from verified public records.
  //
  // RAG note: The static JSON is Phase 1. Phase 2 will call the Perplexity
  // Sonar API at trigger time to fetch real-time verified public records.
  // ════════════════════════════════════════════════════════════════════════════

  let _publicFigureDB = null;

  async function loadPublicFigures() {
    if (_publicFigureDB) return _publicFigureDB;
    try {
      const url = chrome.runtime.getURL('data/public-figures.json');
      const json = await fetch(url).then(r => r.json());
      _publicFigureDB = json.figures || [];
    } catch { _publicFigureDB = []; }
    return _publicFigureDB;
  }

  // Extract Twitter/X author handle from a tweet article element
  function getAuthorHandle(tweetEl) {
    const nameEl = tweetEl.querySelector('[data-testid="User-Name"]');
    if (!nameEl) return null;
    const links = nameEl.querySelectorAll('a[role="link"][href^="/"]');
    for (const link of links) {
      const match = link.getAttribute('href')?.match(/^\/([A-Za-z0-9_]{1,50})(?:\/|$)/);
      if (match && !['search','explore','notifications','messages','settings'].includes(match[1].toLowerCase())) {
        return match[1].toLowerCase();
      }
    }
    return null;
  }

  async function findPublicFigure(tweetEl) {
    const handle = getAuthorHandle(tweetEl);
    if (!handle) return null;
    const figures = await loadPublicFigures();
    return figures.find(f => (f.handles || []).some(h => h.replace(/^@/, '').toLowerCase() === handle)) || null;
  }

  function renderAccountabilityCard(figure) {
    const el = document.createElement('div');
    el.setAttribute('data-glassbox', 'accountability-card');
    el.className = 'gb-acct-card';

    const legalHTML = (figure.legal_proceedings || []).slice(0, 3).map(p => `
      <div class="gb-acct-card__item">
        <span class="gb-acct-card__item-badge gb-acct-card__item-badge--${p.status}">${p.status}</span>
        <div>
          <div class="gb-acct-card__item-title">${p.case}</div>
          <div class="gb-acct-card__item-detail">${p.summary}</div>
          ${p.source_url ? `<a class="gb-acct-card__item-link" href="${p.source_url}" target="_blank" rel="noopener noreferrer">📄 ${p.source}</a>` : `<span class="gb-acct-card__item-src">${p.source}</span>`}
        </div>
      </div>`).join('');

    const factHTML = (figure.fact_check_discrepancies || []).slice(0, 3).map(f => `
      <div class="gb-acct-card__item">
        <span class="gb-acct-card__item-badge gb-acct-card__item-badge--disputed">disputed</span>
        <div>
          <div class="gb-acct-card__item-title">"${f.claim}"</div>
          <div class="gb-acct-card__item-detail">↳ ${f.finding}</div>
          ${f.source_url ? `<a class="gb-acct-card__item-link" href="${f.source_url}" target="_blank" rel="noopener noreferrer">📄 ${f.source}</a>` : ''}
        </div>
      </div>`).join('');

    const financeHTML = (figure.financial_ties || []).slice(0, 3).map(f => `
      <div class="gb-acct-card__item">
        <span class="gb-acct-card__item-badge gb-acct-card__item-badge--financial">financial</span>
        <div>
          <div class="gb-acct-card__item-title">${f.entity}</div>
          <div class="gb-acct-card__item-detail">${f.relationship}${f.amount ? ` — ${f.amount}` : ''}</div>
          <div class="gb-acct-card__item-detail" style="color:#6b7280">${f.relevance}</div>
          ${f.source_url ? `<a class="gb-acct-card__item-link" href="${f.source_url}" target="_blank" rel="noopener noreferrer">📄 ${f.source}</a>` : ''}
        </div>
      </div>`).join('');

    const sections = [
      legalHTML   ? `<div class="gb-acct-card__section"><div class="gb-acct-card__section-title">⚖️ Verified Legal Proceedings</div>${legalHTML}</div>` : '',
      factHTML    ? `<div class="gb-acct-card__section"><div class="gb-acct-card__section-title">🔎 Documented Contradictions</div>${factHTML}</div>` : '',
      financeHTML ? `<div class="gb-acct-card__section"><div class="gb-acct-card__section-title">💰 Financial Ties to This Topic</div>${financeHTML}</div>` : '',
    ].filter(Boolean).join('');

    el.innerHTML = `
      <button class="gb-acct-card__trigger" aria-expanded="false">
        <span>🏛️</span>
        <span class="gb-acct-card__trigger-label">Public Record — ${figure.name}</span>
        <span class="gb-acct-card__trigger-role">${figure.role || ''}</span>
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
      <div class="gb-popover__meta">${result.tactics.length} manipulation ${result.tactics.length === 1 ? 'tactic' : 'tactics'} detected</div>
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

  function showReflectionModal({ manipulation, toxicity, falseClaims, credibility, postText, contextCards, onProceed, onCancel }) {
    removeModal();

    const hasToxic       = toxicity?.toxic;
    const hasSensitive   = toxicity?.sensitive;
    const hasManipulation = manipulation?.is_manipulative;
    const hasLowCred     = credibility?.score != null && credibility.score < 4;

    const hasFalseClaimsFlag = falseClaims?.length > 0;

    let emoji = '💭', headline = 'Before you share…', subline = 'GlassBox found some things worth knowing.';
    if (hasToxic)             { emoji = '🤔'; headline = 'Quick thought before you post'; subline = 'This language may have more impact than you expect.'; }
    else if (hasFalseClaimsFlag) { emoji = '🔎'; headline = 'This contradicts verified records'; subline = 'GlassBox found claims that conflict with official findings.'; }
    else if (hasLowCred)      { emoji = '⚠️'; subline = 'The linked source has a low credibility rating.'; }
    else if (hasManipulation) { emoji = '🔍'; headline = 'Heads up'; subline = 'This content uses patterns associated with manipulation.'; }

    const findings = [];
    if (hasLowCred)      findings.push({ icon: '⚠️', text: `Source rated ${credibility.score}/10 credibility`, detail: credibility.label });
    if (hasToxic)        findings.push({ icon: '🚫', text: 'Contains potentially harmful language', detail: null });
    else if (hasSensitive) findings.push({ icon: '💬', text: 'Contains language with historical or social weight', detail: null });
    if (hasManipulation) findings.push({ icon: '🎭', text: `${manipulation.tactics.length} manipulation ${manipulation.tactics.length === 1 ? 'tactic' : 'tactics'} detected`,
                                         detail: manipulation.tactics.slice(0, 2).map(t => t.label).join(', ') });
    if (hasFalseClaimsFlag) falseClaims.slice(0, 2).forEach(fc =>
      findings.push({ icon: '🔎', text: fc.verdict, detail: `Source: ${fc.source}` }));

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
      <div id="gb-modal-cards-slot" style="margin-bottom:4px"></div>
      <div class="gb-modal__actions">
        <button class="gb-modal__btn gb-modal__btn--secondary" data-action="cancel">Cancel</button>
        <button class="gb-modal__btn gb-modal__btn--proceed"   data-action="proceed">Post anyway</button>
      </div>
      <div style="font-size:10px;color:#374151;margin-top:12px;text-align:center">GlassBox &bull; Helping you think before you post.</div>`;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Inject context cards — cards were pre-fetched with the full text
    if (contextCards?.length) {
      const slot = modal.querySelector('#gb-modal-cards-slot');
      if (slot) contextCards.slice(0, 1).forEach(c => slot.appendChild(renderContextCard(c)));
    }

    overlay.addEventListener('click', e => {
      e.stopPropagation(); // prevent clicks inside modal from reaching Twitter's global handlers
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

      if (settings.showManipulationIndicators) {
        let indicatorResult = null;

        if (manipulation?.is_manipulative) {
          const levels = { low: ['low','medium','high'], medium: ['medium','high'], high: ['high'] };
          if ((levels[settings.manipulationThreshold] || levels.medium).includes(manipulation.level)) {
            indicatorResult = manipulation;
          }
        } else if (toxicity?.toxic || toxicity?.sensitive) {
          // Toxicity detected but no manipulation pattern matched — still show a tag
          indicatorResult = {
            level: toxicity.toxic ? 'high' : 'medium',
            tactics: [{
              tactic: 'dehumanization',
              label: toxicity.toxic ? 'Harmful Language' : 'Sensitive Language',
              icon: toxicity.toxic ? '🚫' : '⚠️',
              description: 'Language that may be harmful or demean groups of people',
            }],
          };
        }

        if (indicatorResult) row.appendChild(createManipulationIndicator(indicatorResult));
      }

      // Psycholinguistic score — show resonance indicator when low (< 35%) or high affect
      const resonance = computeResonanceScore(text, toxicity);
      if (resonance.resonance < 35 || resonance.affect > 55) {
        row.appendChild(createResonanceIndicator(resonance));
      }

      if (row.children.length) actionBar.appendChild(row);
    }

    const postHash = hashString(text.slice(0, 100));
    const isManipulativeOrToxic = manipulation?.is_manipulative || toxicity?.toxic || toxicity?.sensitive || false;

    // Fact-check — detect claims that contradict verified public records
    const falseClaims = await detectFalseClaims(text);
    if (falseClaims.length && textEl) {
      falseClaims.slice(0, 2).forEach(fc => {
        const banner = renderFactCheckBanner(fc);
        textEl.parentElement?.insertBefore(banner, textEl.nextSibling);
      });
    }

    // Context cards — always show for flagged content; show by topic match for clean content
    if (settings.showContextCards && textEl) {
      const isFlag = isManipulativeOrToxic || falseClaims.length > 0;
      const cardsToShow = isFlag ? await findBestCard(text) : await findMatchingCards(text);
      if (cardsToShow.length) {
        const cardContainer = document.createElement('div');
        cardContainer.setAttribute('data-glassbox', 'card-container');
        cardsToShow.slice(0, 1).forEach(c => cardContainer.appendChild(renderContextCard(c)));
        textEl.parentElement?.insertBefore(cardContainer, textEl.nextSibling);
      }
    }

    // User context links — show saved links + "Add Context" button on flagged posts
    const isAnyFlag = isManipulativeOrToxic || falseClaims.length > 0;
    if (isAnyFlag && textEl) {
      const userCtx = await loadUserContext(postHash);
      if (userCtx.length) {
        textEl.parentElement?.insertBefore(renderUserContextCard(userCtx), textEl.nextSibling);
      }
      // Add the "Add Context" button to the annotation row
      const annotRow = postEl.querySelector('[data-glassbox="annotation-row"]');
      if (annotRow) annotRow.appendChild(createAddContextButton(postHash, textEl));
    }

    // Public figure accountability card
    if (textEl) {
      const figure = await findPublicFigure(postEl);
      if (figure) {
        textEl.parentElement?.insertBefore(renderAccountabilityCard(figure), textEl.nextSibling);
      }
    }

    // Record view
    recordPostView({
      platform: 'twitter',
      source_domain: primaryCred?.domain || null,
      credibility_score: primaryCred?.score || null,
      manipulation_detected: isAnyFlag,
      tactics_used: manipulation?.tactics?.map(t => t.tactic) || [],
      user_engaged: false,
      engagement_type: 'view',
      post_text_hash: postHash,
    });
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
    try {
      await annotatePost(tweetEl, { getTextEl, getActionBar });
    } catch (err) {
      console.warn('[GlassBox] annotatePost error:', err);
    }
  }

  // ── Compose box intercept ──────────────────────────────────────────────────

  function hookComposeBtn(btn) {
    if (btn.dataset.gbHooked) return;
    btn.dataset.gbHooked = '1';

    // NOTE: handler must be synchronous so e.preventDefault() fires BEFORE
    // the event propagates to Twitter's own listeners. Any async work happens
    // AFTER we've already blocked the event.
    // Use pointerdown — fires before mousedown/click, so we block before
    // Twitter can initiate the submit action on its own listeners.
    btn.addEventListener('pointerdown', e => {
      if (btn.dataset.gbProceed) return;

      const composeEl = document.querySelector(SEL.composeArea);
      const text = composeEl?.textContent?.trim() || '';
      if (text.length < 5) return;

      // analyzeToxicity is fully synchronous — run it immediately
      const toxicity = analyzeToxicity(text);

      // Quick synchronous false-claim check — catches factual falsehoods with polite language
      const COMPOSE_CLAIM_PATTERNS = [
        /\bvaccines? (cause|caused|causes) autism\b/i,
        /\bautism (from|caused by) vaccines?\b/i,
        /\b(the |2020 )?election was stolen\b/i,
        /\b(stolen|rigged) election\b/i,
        /\b2020 was stolen\b/i,
        /\b(there'?s? (no|no such thing as) genocide|not (a )?genocide|wasn'?t genocide)\b/i,
        /\b(climate change|global warming) (is|are) (a )?(hoax|fake|fraud|scam)\b/i,
        /\bno scientific consensus (on|about) climate\b/i,
        /\bmmiwg.{0,30}(not|no|never|wasn.t|isn.t)\b/i,
      ];
      const hasFalseClaim = COMPOSE_CLAIM_PATTERNS.some(p => p.test(text));

      if (!toxicity.toxic && !toxicity.sensitive && !hasFalseClaim) return;

      // Block the event NOW, before Twitter's handler sees it
      e.preventDefault();
      e.stopImmediatePropagation();

      // Async work (settings check + full manipulation scan) runs after blocking
      (async () => {
        try {
        const settings = await getCachedSettings();
        if (!settings.prePostReflection) {
          // User has reflection off — let the post go through
          btn.dataset.gbProceed = '1';
          btn.click();
          return;
        }

        const [manipulation, contextCards, falseClaims] = await Promise.all([
          detectManipulation(text),
          findBestCard(text),
          detectFalseClaims(text),
        ]);

        // Merge fact-check cards into contextCards if no topic card matched
        const allCards = contextCards.length ? contextCards
          : falseClaims.length && falseClaims[0].topic_card_id
            ? (await loadCards()).filter(c => c.id === falseClaims[0].topic_card_id)
            : contextCards;

        // Record that a post attempt was intercepted
        recordPostView({
          platform: 'twitter',
          source_domain: null,
          credibility_score: null,
          manipulation_detected: manipulation?.is_manipulative || toxicity.toxic || toxicity.sensitive,
          tactics_used: manipulation?.tactics?.map(t => t.tactic) || [],
          user_engaged: false,
          engagement_type: 'attempted_post',
          post_text_hash: hashString(text.slice(0, 100)),
        });

        showReflectionModal({
          manipulation, toxicity, falseClaims,
          credibility: null,
          postText: truncate(text, 120),
          contextCards: allCards,
          onProceed: () => {
            recordPostView({
              platform: 'twitter',
              source_domain: null,
              credibility_score: null,
              manipulation_detected: manipulation?.is_manipulative || toxicity.toxic || toxicity.sensitive || hasFalseClaim,
              tactics_used: manipulation?.tactics?.map(t => t.tactic) || [],
              user_engaged: true,
              engagement_type: 'share',
              post_text_hash: hashString(text.slice(0, 100)),
            });
            btn.dataset.gbProceed = '1';
            btn.click();
          },
          onCancel:  () => {},
        });
        } catch (err) {
          // If anything crashes, unblock the button so the user isn't stuck
          console.error('[GlassBox] Modal error:', err);
          btn.dataset.gbProceed = '1';
          btn.click();
        }
      })();
    }, true); // capture phase
  }

  let _composeObserver = null;
  function watchComposeBox() {
    const check = () => {
      SEL.submitBtns.forEach(sel =>
        document.querySelectorAll(sel).forEach(btn => hookComposeBtn(btn))
      );
    };
    check();
    _composeObserver = new MutationObserver(check);
    _composeObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Feed observer ──────────────────────────────────────────────────────────

  let _feedObserver = null;
  function watchFeed() {
    const debouncedScan = debounce(() => {
      document.querySelectorAll(SEL.tweet).forEach(el => {
        if (!processedPosts.has(el)) processTweet(el);
      });
    }, 300);

    _feedObserver = new MutationObserver(mutations => {
      let found = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches?.(SEL.tweet)) { processTweet(node); found = true; }
          node.querySelectorAll?.(SEL.tweet).forEach(el => { processTweet(el); found = true; });
        }
      }
      if (!found) debouncedScan();
    });
    _feedObserver.observe(document.body, { childList: true, subtree: true });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  async function init() {
    const settings = await getSettings();
    if (!settings.enabled) return;

    // Process tweets already in DOM
    document.querySelectorAll(SEL.tweet).forEach(el => processTweet(el));

    watchFeed();
    watchComposeBox();

    // Register teardown so the NEXT injection can cleanly replace this one
    window.__glassboxTeardown = () => {
      _feedObserver?.disconnect();
      _composeObserver?.disconnect();
      document.querySelectorAll('[data-glassbox]').forEach(el => el.remove());
      document.querySelectorAll('[data-gb-hooked]').forEach(el => el.removeAttribute('data-gb-hooked'));
      document.querySelectorAll('[data-gb-proceed]').forEach(el => el.removeAttribute('data-gb-proceed'));
      delete window.__glassboxTeardown;
    };

    console.info('[GlassBox] Twitter injector active. ✓');
  }

  init();

})();
