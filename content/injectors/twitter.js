/**
 * GlassBox Twitter/X.com Injector
 * Main content script for Twitter/X.
 *
 * Twitter's DOM structure (as of 2026):
 * - Tweets are `article[data-testid="tweet"]`
 * - Tweet text is `div[data-testid="tweetText"]`
 * - Action bar is `div[role="group"]` (the like/retweet/share row)
 * - Compose area: `div[data-testid="tweetTextarea_0"]`
 * - Submit button: `button[data-testid="tweetButtonInline"]` or `button[data-testid="tweetButton"]`
 */

import { annotatePost, observeNewPosts } from './common.js';
import { getSettings } from '../../lib/storage.js';

// ─── Twitter DOM Selectors ─────────────────────────────────────────────────────

const SELECTORS = {
  tweet: 'article[data-testid="tweet"]',
  tweetText: 'div[data-testid="tweetText"]',
  actionBar: 'div[role="group"][aria-label]',
  composeArea: 'div[data-testid="tweetTextarea_0"]',
  submitBtn: [
    'button[data-testid="tweetButtonInline"]',
    'button[data-testid="tweetButton"]',
    'button[data-testid="sendDmButton"]',
  ],
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getTextEl(tweetEl) {
  return tweetEl.querySelector(SELECTORS.tweetText);
}

function getActionBar(tweetEl) {
  // The action bar (like/retweet row) sits below the tweet
  return tweetEl.querySelector(SELECTORS.actionBar);
}

function getSubmitBtns(tweetEl) {
  // Submit buttons are in the compose box, not inside individual tweets.
  // We handle compose separately — return empty array for feed tweets.
  return [];
}

function isTweet(node) {
  return (
    node.matches && node.matches(SELECTORS.tweet)
  );
}

// ─── Feed Injection ─────────────────────────────────────────────────────────────

async function processTweet(tweetEl) {
  await annotatePost(tweetEl, {
    getTextEl,
    getActionBar,
    getSubmitBtns,
  });
}

async function processAllVisible() {
  const tweets = document.querySelectorAll(SELECTORS.tweet);
  for (const tweet of tweets) {
    await processTweet(tweet);
  }
}

// ─── Compose Box Monitoring ─────────────────────────────────────────────────────

/**
 * Monitor the compose text area and intercept submit buttons.
 * This is separate from feed tweets.
 */
function watchComposeBox() {
  const composeObserver = new MutationObserver(() => {
    const submitBtns = SELECTORS.submitBtn.flatMap((sel) =>
      Array.from(document.querySelectorAll(sel))
    );

    submitBtns.forEach((btn) => {
      if (btn.dataset.gbComposeHooked) return;
      btn.dataset.gbComposeHooked = '1';
      hookComposeSubmit(btn);
    });
  });

  composeObserver.observe(document.body, { childList: true, subtree: true });
}

async function hookComposeSubmit(btn) {
  const settings = await getSettings();
  if (!settings.prePostReflection) return;

  btn.addEventListener(
    'click',
    async (e) => {
      // Grab compose text
      const composeEl = document.querySelector(SELECTORS.composeArea);
      const text = composeEl ? (composeEl.textContent || '') : '';

      if (!text || text.length < 5) return;
      if (btn.dataset.gbComposeProceed) return;

      const [{ detectManipulation }, { analyzeToxicity }] = await Promise.all([
        import('../detectors/manipulation.js'),
        import('../detectors/toxicity.js'),
      ]);

      const [manipulation, toxicity] = await Promise.all([
        detectManipulation(text),
        Promise.resolve(analyzeToxicity(text)),
      ]);

      const shouldShow =
        (toxicity.toxic || toxicity.sensitive) ||
        (manipulation.is_manipulative && manipulation.level !== 'low');

      if (!shouldShow) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const { showReflectionModal } = await import('../ui/modal.js');
      const { truncate } = await import('../../lib/utils.js');

      showReflectionModal({
        manipulation,
        toxicity,
        credibility: null,
        postText: truncate(text, 120),
        onProceed: () => {
          btn.dataset.gbComposeProceed = '1';
          btn.click();
        },
        onCancel: () => {},
        onLearnMore: () => {},
      });
    },
    true // capture
  );
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────────

async function init() {
  const settings = await getSettings();
  if (!settings.enabled) return;

  // Process tweets already in the DOM
  await processAllVisible();

  // Watch for new tweets (infinite scroll)
  observeNewPosts(isTweet, processTweet);

  // Watch compose box for submit hooks
  watchComposeBox();

  console.info('[GlassBox] Twitter injector active.');
}

// Run after page is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
