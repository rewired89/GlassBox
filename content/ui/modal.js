/**
 * GlassBox Pre-Post Reflection Modal
 * Intercepts share/post actions and shows a reflection prompt.
 */

import { getTacticLabel, getTacticIcon } from '../../lib/utils.js';

/**
 * Show the pre-post reflection modal.
 *
 * @param {Object} params
 * @param {Object} params.manipulation - Result from detectManipulation()
 * @param {Object} params.toxicity    - Result from analyzeToxicity()
 * @param {Object} params.credibility - Primary credibility badge (or null)
 * @param {string} params.postText    - Preview of post text (truncated)
 * @param {Function} params.onProceed - Called when user clicks "Post anyway"
 * @param {Function} params.onCancel  - Called when user clicks "Cancel"
 * @param {Function} params.onLearnMore - Called when user clicks fact-check link
 * @returns {{ el: HTMLElement, remove: Function }}
 */
export function showReflectionModal({ manipulation, toxicity, credibility, postText, onProceed, onCancel, onLearnMore }) {
  // Remove any existing modal
  removeModal();

  const overlay = document.createElement('div');
  overlay.setAttribute('data-glassbox', 'modal-overlay');
  overlay.className = 'gb-modal-overlay';

  const modal = document.createElement('div');
  modal.setAttribute('data-glassbox', 'modal');
  modal.className = 'gb-modal';

  // Determine severity and messaging
  const hasToxic = toxicity && toxicity.toxic;
  const hasSensitive = toxicity && toxicity.sensitive;
  const hasManipulation = manipulation && manipulation.is_manipulative;
  const hasLowCred = credibility && credibility.score != null && credibility.score < 4;

  const findings = buildFindings({ manipulation, toxicity, credibility });

  // Choose headline
  let emoji = '💭';
  let headline = 'Before you share…';
  let subline = 'GlassBox found some things worth knowing.';

  if (hasToxic) {
    emoji = '🤔';
    headline = 'Quick thought before you post';
    subline = 'This language may have more impact than you expect.';
  } else if (hasLowCred) {
    emoji = '⚠️';
    headline = 'Before you share…';
    subline = 'The linked source has a low credibility rating.';
  } else if (hasManipulation) {
    emoji = '🔍';
    headline = 'Heads up';
    subline = 'This content contains patterns associated with manipulation.';
  }

  // Post text preview
  const previewHTML = postText
    ? `<div style="font-size:12px;color:#6b7280;background:#0f1117;border-radius:8px;padding:8px 10px;margin-bottom:14px;border-left:3px solid #374151;font-style:italic">"${postText}"</div>`
    : '';

  // Findings section
  const findingsHTML = findings.length > 0
    ? `<div class="gb-modal__findings">
        ${findings.map((f) => `
          <div class="gb-modal__finding">
            <span class="gb-modal__finding-icon">${f.icon}</span>
            <div>
              <div>${f.text}</div>
              ${f.detail ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">${f.detail}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`
    : '';

  // Tactic list
  const tactics = manipulation && manipulation.tactics ? manipulation.tactics.slice(0, 3) : [];
  const tacticsHTML = tactics.length > 0
    ? `<ul class="gb-modal__tactic-list">
        ${tactics.map((t) => `
          <li class="gb-modal__tactic-item">
            <span>${t.icon}</span>
            <span class="gb-modal__tactic-badge">${t.label}</span>
          </li>`).join('')}
      </ul>`
    : '';

  // Action buttons
  const hasLearnMore = hasLowCred || hasManipulation;

  modal.innerHTML = `
    <div class="gb-modal__emoji">${emoji}</div>
    <div class="gb-modal__headline">${headline}</div>
    <div class="gb-modal__subline">${subline}</div>
    ${previewHTML}
    ${findingsHTML}
    ${tacticsHTML}
    <div class="gb-modal__actions">
      ${hasLearnMore
        ? `<button class="gb-modal__btn gb-modal__btn--primary" data-action="learn">See details</button>`
        : ''}
      <button class="gb-modal__btn gb-modal__btn--secondary" data-action="cancel">Cancel</button>
      <button class="gb-modal__btn gb-modal__btn--proceed" data-action="proceed">Post anyway</button>
    </div>
    <div style="font-size:10px;color:#374151;margin-top:12px;text-align:center">
      GlassBox &bull; This detection may not be perfect.
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Wire up actions
  overlay.addEventListener('click', (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    e.preventDefault();
    e.stopPropagation();

    if (action === 'proceed') {
      removeModal();
      if (onProceed) onProceed();
    } else if (action === 'cancel') {
      removeModal();
      if (onCancel) onCancel();
    } else if (action === 'learn') {
      if (onLearnMore) onLearnMore();
    }
  });

  // Close on overlay click (outside modal)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      removeModal();
      if (onCancel) onCancel();
    }
  });

  // Trap focus inside modal
  trapFocus(modal);

  return {
    el: overlay,
    remove: removeModal,
  };
}

/**
 * Build the ordered list of findings to show in the modal.
 */
function buildFindings({ manipulation, toxicity, credibility }) {
  const findings = [];

  if (credibility && credibility.score != null && credibility.score < 5) {
    findings.push({
      icon: '⚠️',
      text: `Source rated ${credibility.score}/10 credibility`,
      detail: credibility.label
        ? `${credibility.label} — ${credibility.fact_check_record || ''}`
        : null,
    });
  }

  if (toxicity && toxicity.toxic) {
    findings.push({
      icon: '🚫',
      text: 'Contains potentially harmful language',
      detail: 'This language may be perceived as targeting individuals or groups.',
    });
  } else if (toxicity && toxicity.sensitive) {
    findings.push({
      icon: '💬',
      text: 'Contains language with historical or social weight',
      detail: null,
    });
  }

  if (manipulation && manipulation.is_manipulative) {
    findings.push({
      icon: '🎭',
      text: `${manipulation.tactics.length} manipulation tactic${manipulation.tactics.length !== 1 ? 's' : ''} detected`,
      detail: manipulation.tactics.slice(0, 2).map((t) => t.label).join(', '),
    });
  }

  return findings;
}

export function removeModal() {
  const existing = document.querySelector('[data-glassbox="modal-overlay"]');
  if (existing) existing.remove();
}

/**
 * Basic focus trap for accessibility.
 */
function trapFocus(modal) {
  const focusable = modal.querySelectorAll('button, a, input, [tabindex]:not([tabindex="-1"])');
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  first.focus();

  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
}
