/**
 * GlassBox Common Injector Utilities
 * Platform-agnostic helpers used by all injectors.
 */

import { getSettings } from '../../lib/storage.js';
import { getTextContent, hashString, debounce } from '../../lib/utils.js';
import { detectManipulation } from '../detectors/manipulation.js';
import { analyzeToxicity } from '../detectors/toxicity.js';
import { getPostCredibility, getPrimaryCredibilityInfo } from '../detectors/credibility.js';
import { injectContextCards } from '../ui/card.js';
import {
  createCredibilityBadge,
  createManipulationIndicator,
  showCredibilityPopover,
  showManipulationPopover,
  removePopover,
} from '../ui/indicator.js';
import { recordPostView } from '../../lib/storage.js';

// Track which posts have already been processed to avoid duplicate injection
const processedPosts = new WeakSet();

// Cache settings to avoid repeated async reads
let cachedSettings = null;
let settingsLastLoaded = 0;
const SETTINGS_TTL = 10000; // 10 seconds

async function getSettingsCached() {
  const now = Date.now();
  if (!cachedSettings || now - settingsLastLoaded > SETTINGS_TTL) {
    cachedSettings = await getSettings();
    settingsLastLoaded = now;
  }
  return cachedSettings;
}

/**
 * Analyze and annotate a single post element.
 *
 * @param {Element} postEl - The post DOM element
 * @param {Object} options
 * @param {Function} options.getTextEl    - Returns the element containing post text
 * @param {Function} options.getActionBar - Returns the element to inject badges into
 * @param {Function} options.getSubmitBtns - Returns submit/share button elements
 */
export async function annotatePost(postEl, { getTextEl, getActionBar, getSubmitBtns }) {
  if (processedPosts.has(postEl)) return;
  processedPosts.add(postEl);

  const settings = await getSettingsCached();
  if (!settings.enabled) return;

  const textEl = getTextEl(postEl);
  const text = textEl ? getTextContent(textEl) : '';

  if (!text || text.trim().length < 20) return;

  // Run detectors in parallel
  const [manipulation, credibilityResults] = await Promise.all([
    settings.showManipulationIndicators
      ? detectManipulation(text)
      : Promise.resolve(null),
    settings.showCredibilityBadges
      ? getPostCredibility(postEl)
      : Promise.resolve([]),
  ]);

  const toxicity = settings.showManipulationIndicators
    ? analyzeToxicity(text)
    : null;

  const primaryCred = getPrimaryCredibilityInfo(credibilityResults);

  // Build annotation row
  const actionBar = getActionBar(postEl);
  if (actionBar) {
    const annotationRow = document.createElement('div');
    annotationRow.setAttribute('data-glassbox', 'annotation-row');
    annotationRow.className = 'gb-post-annotation';

    // Credibility badge
    if (settings.showCredibilityBadges && primaryCred) {
      const badge = createCredibilityBadge(primaryCred, (badge, btn) => {
        removePopover();
        showCredibilityPopover(badge, btn);
      });
      annotationRow.appendChild(badge);
    }

    // Manipulation indicator
    if (settings.showManipulationIndicators && manipulation && manipulation.is_manipulative) {
      const threshold = settings.manipulationThreshold || 'medium';
      const levels = { low: ['low', 'medium', 'high'], medium: ['medium', 'high'], high: ['high'] };
      if (levels[threshold].includes(manipulation.level)) {
        const indicator = createManipulationIndicator(manipulation, (result, btn) => {
          removePopover();
          showManipulationPopover(result, btn);
        });
        annotationRow.appendChild(indicator);
      }
    }

    if (annotationRow.children.length > 0) {
      actionBar.appendChild(annotationRow);
    }
  }

  // Context cards
  if (settings.showContextCards && textEl) {
    const cardContainer = document.createElement('div');
    cardContainer.setAttribute('data-glassbox', 'card-container');
    const cardCount = await injectContextCards(text, cardContainer);
    if (cardCount > 0) {
      // Inject after the text element
      textEl.parentElement?.insertBefore(cardContainer, textEl.nextSibling);
    }
  }

  // Wire up pre-post reflection on submit buttons
  if (settings.prePostReflection) {
    const submitBtns = getSubmitBtns ? getSubmitBtns(postEl) : [];
    submitBtns.forEach((btn) => {
      if (btn.dataset.gbHooked) return;
      btn.dataset.gbHooked = '1';
      interceptSubmit(btn, text, manipulation, toxicity, primaryCred);
    });
  }

  // Record post view
  recordPostView({
    platform: 'twitter',
    source_domain: primaryCred ? primaryCred.domain : null,
    credibility_score: primaryCred ? primaryCred.score : null,
    manipulation_detected: manipulation ? manipulation.is_manipulative : false,
    tactics_used: manipulation ? manipulation.tactics.map((t) => t.tactic) : [],
    user_engaged: false,
    engagement_type: 'view',
    post_text_hash: hashString(text.slice(0, 100)),
  }).catch(() => {});
}

/**
 * Intercept a submit/share button and show reflection modal if needed.
 */
function interceptSubmit(btn, text, manipulation, toxicity, credibility) {
  // Dynamic import to avoid loading modal unless needed
  btn.addEventListener(
    'click',
    async (e) => {
      const shouldShow = shouldShowReflection(manipulation, toxicity, credibility);
      if (!shouldShow) return;

      // Check if user already dismissed for this post
      if (btn.dataset.gbProceed) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const { showReflectionModal } = await import('../ui/modal.js');
      const { truncate } = await import('../../lib/utils.js');

      showReflectionModal({
        manipulation,
        toxicity,
        credibility,
        postText: truncate(text, 120),
        onProceed: () => {
          btn.dataset.gbProceed = '1';
          btn.click();
        },
        onCancel: () => {},
        onLearnMore: () => {
          // Phase 2: open full fact-check panel
          console.info('[GlassBox] Learn more clicked');
        },
      });
    },
    true // capture phase — runs before page's listeners
  );
}

function shouldShowReflection(manipulation, toxicity, credibility) {
  if (toxicity && (toxicity.toxic || toxicity.sensitive)) return true;
  if (manipulation && manipulation.level === 'high') return true;
  if (credibility && credibility.score != null && credibility.score < 3) return true;
  return false;
}

/**
 * Create a MutationObserver that calls `callback` for each new post element.
 *
 * @param {Function} isPost - Returns true if the node is a post
 * @param {Function} callback - Called with each new post element
 * @returns {MutationObserver}
 */
export function observeNewPosts(isPost, callback) {
  const debouncedScan = debounce(() => {
    document.querySelectorAll('[data-testid="tweet"]').forEach((el) => {
      if (!processedPosts.has(el)) callback(el);
    });
  }, 300);

  const observer = new MutationObserver((mutations) => {
    let found = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (isPost(node)) {
          callback(node);
          found = true;
        }
        // Check descendants
        const posts = node.querySelectorAll ? node.querySelectorAll('[data-testid="tweet"]') : [];
        if (posts.length > 0) {
          posts.forEach(callback);
          found = true;
        }
      }
    }
    if (!found) debouncedScan();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}
