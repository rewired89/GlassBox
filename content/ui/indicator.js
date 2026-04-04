/**
 * GlassBox Indicator
 * Renders a small inline badge for manipulation or credibility signals.
 */

import { formatCredibility, getTacticLabel, getTacticIcon } from '../../lib/utils.js';

/**
 * Create a credibility badge element.
 *
 * @param {Object} badge - Badge data from credibility-db.js
 * @param {Function} onExpand - Callback when user clicks badge
 * @returns {HTMLElement}
 */
export function createCredibilityBadge(badge, onExpand) {
  const btn = document.createElement('button');
  btn.setAttribute('data-glassbox', 'credibility-badge');
  btn.className = `gb-badge gb-badge--${badge.tier}`;
  btn.setAttribute('aria-label', `Source credibility: ${badge.label} — ${badge.score}/10`);

  if (badge.tier === 'satire') {
    btn.textContent = `🎭 Satire`;
  } else if (badge.score != null) {
    const cred = formatCredibility(badge.score);
    btn.innerHTML = `<span>✓ ${cred.label}</span>`;
  } else {
    btn.textContent = `? Unrated`;
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (onExpand) onExpand(badge, btn);
  });

  return btn;
}

/**
 * Create a manipulation indicator element.
 *
 * @param {Object} analysisResult - Result from detectManipulation()
 * @param {Function} onExpand - Callback when user clicks
 * @returns {HTMLElement}
 */
export function createManipulationIndicator(analysisResult, onExpand) {
  const { level, tactics } = analysisResult;
  const primaryTactic = tactics[0];

  const btn = document.createElement('button');
  btn.setAttribute('data-glassbox', 'manipulation-indicator');
  btn.className = `gb-indicator gb-indicator--${level}`;

  const icon = primaryTactic ? primaryTactic.icon : '⚠️';
  const label = primaryTactic
    ? `${icon} ${primaryTactic.label}`
    : '⚠️ Manipulation detected';

  btn.textContent = label;
  btn.setAttribute('aria-label', `Manipulation detected: ${label}`);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (onExpand) onExpand(analysisResult, btn);
  });

  return btn;
}

/**
 * Create a fact-check available indicator.
 * (Placeholder for Phase 2 fact-check API integration)
 *
 * @returns {HTMLElement}
 */
export function createFactCheckIndicator(onExpand) {
  const btn = document.createElement('button');
  btn.setAttribute('data-glassbox', 'fact-check-indicator');
  btn.className = 'gb-indicator';
  btn.textContent = '🔍 Context available';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (onExpand) onExpand();
  });

  return btn;
}

/**
 * Render a credibility popover anchored near `anchorEl`.
 *
 * @param {Object} badge
 * @param {HTMLElement} anchorEl
 * @returns {HTMLElement} popover element (already appended to body)
 */
export function showCredibilityPopover(badge, anchorEl) {
  removePopover();

  const pop = document.createElement('div');
  pop.setAttribute('data-glassbox', 'popover');
  pop.className = 'gb-popover';

  const scoreColor = badge.tier === 'high' ? '#22c55e'
    : badge.tier === 'medium' ? '#f59e0b'
    : badge.tier === 'low' ? '#ef4444'
    : badge.tier === 'very-low' ? '#fca5a5'
    : badge.tier === 'satire' ? '#a855f7'
    : '#9ca3af';

  let scoreDisplay = badge.score != null
    ? `<div class="gb-popover__score" style="color:${scoreColor}">${badge.score}/10</div>`
    : `<div class="gb-popover__score" style="color:#a855f7">Satire</div>`;

  let strengthsHTML = '';
  if (badge.strengths && badge.strengths.length > 0) {
    strengthsHTML = `
      <div class="gb-popover__section">
        <div class="gb-popover__section-title">Strengths</div>
        <ul class="gb-popover__list">
          ${badge.strengths.map((s) => `<li>${s}</li>`).join('')}
        </ul>
      </div>`;
  }

  let considerationsHTML = '';
  if (badge.considerations && badge.considerations.length > 0) {
    considerationsHTML = `
      <div class="gb-popover__section">
        <div class="gb-popover__section-title">Considerations</div>
        <ul class="gb-popover__list">
          ${badge.considerations.map((c) => `<li>${c}</li>`).join('')}
        </ul>
      </div>`;
  }

  pop.innerHTML = `
    <div class="gb-popover__header">
      <div class="gb-popover__title">Source Credibility</div>
      <button class="gb-popover__close" aria-label="Close">✕</button>
    </div>
    ${scoreDisplay}
    <div class="gb-popover__meta">
      ${badge.label} &bull; ${badge.bias || 'Unknown bias'} &bull; ${badge.fact_check_record || ''}
    </div>
    <hr class="gb-popover__divider">
    ${strengthsHTML}
    ${considerationsHTML}
    <div class="gb-popover__meta" style="margin-top:10px">
      Ratings from NewsGuard, MBFC, Ad Fontes Media
    </div>
  `;

  pop.querySelector('.gb-popover__close').addEventListener('click', removePopover);

  document.body.appendChild(pop);
  positionPopover(pop, anchorEl);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick, { once: true, capture: true });
  }, 0);

  return pop;
}

/**
 * Render a manipulation popover.
 */
export function showManipulationPopover(analysisResult, anchorEl) {
  removePopover();

  const pop = document.createElement('div');
  pop.setAttribute('data-glassbox', 'popover');
  pop.className = 'gb-popover';

  const tacticsHTML = analysisResult.tactics
    .slice(0, 4)
    .map(
      (t) => `
      <li>
        <span>${t.icon}</span>
        <div>
          <strong style="color:#e7e9ea">${t.label}</strong>
          <div style="font-size:11px;color:#9ca3af;margin-top:2px">${t.description}</div>
        </div>
      </li>`
    )
    .join('');

  pop.innerHTML = `
    <div class="gb-popover__header">
      <div class="gb-popover__title">⚠️ Manipulation Detected</div>
      <button class="gb-popover__close" aria-label="Close">✕</button>
    </div>
    <div class="gb-popover__meta">
      ${analysisResult.tactics.length} tactic${analysisResult.tactics.length !== 1 ? 's' : ''} detected
      &bull; ${Math.round(analysisResult.confidence * 100)}% confidence
    </div>
    <hr class="gb-popover__divider">
    <ul class="gb-popover__list" style="gap:8px;display:flex;flex-direction:column">
      ${tacticsHTML}
    </ul>
    <div class="gb-popover__meta" style="margin-top:10px;font-style:italic">
      GlassBox uses pattern matching. Some results may be incorrect.
    </div>
  `;

  pop.querySelector('.gb-popover__close').addEventListener('click', removePopover);

  document.body.appendChild(pop);
  positionPopover(pop, anchorEl);

  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick, { once: true, capture: true });
  }, 0);

  return pop;
}

function positionPopover(pop, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;

  let top = rect.bottom + scrollY + 6;
  let left = rect.left + scrollX;

  // Prevent overflow off right edge
  const popWidth = 300;
  if (left + popWidth > window.innerWidth - 16) {
    left = window.innerWidth - popWidth - 16;
  }

  // Prevent overflow off bottom — flip above
  const popHeight = 250; // estimate
  if (rect.bottom + popHeight > window.innerHeight) {
    top = rect.top + scrollY - popHeight - 6;
  }

  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

function handleOutsideClick(e) {
  if (!e.target.closest('[data-glassbox="popover"]')) {
    removePopover();
  }
}

export function removePopover() {
  const existing = document.querySelector('[data-glassbox="popover"]');
  if (existing) existing.remove();
  document.removeEventListener('click', handleOutsideClick, { capture: true });
}
