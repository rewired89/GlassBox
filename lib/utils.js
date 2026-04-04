/**
 * GlassBox Utility Functions
 */

/**
 * Extract the root domain from a URL string.
 * e.g. "https://www.nytimes.com/2024/..." → "nytimes.com"
 */
export function extractDomain(url) {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname;
    // Strip www. and any other common subdomains
    return hostname.replace(/^(www\.|m\.|mobile\.|amp\.)+/, '');
  } catch {
    return null;
  }
}

/**
 * Extract all hrefs from an element's links.
 */
export function extractLinksFromElement(el) {
  const anchors = Array.from(el.querySelectorAll('a[href]'));
  return anchors
    .map((a) => a.href)
    .filter((href) => href && href.startsWith('http'));
}

/**
 * Get all readable text from an element, excluding nested GB UI elements.
 */
export function getTextContent(el) {
  const clone = el.cloneNode(true);
  // Remove any GlassBox injected elements
  clone.querySelectorAll('[data-glassbox]').forEach((n) => n.remove());
  return clone.textContent || '';
}

/**
 * Debounce a function call.
 */
export function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * Throttle a function call.
 */
export function throttle(fn, interval) {
  let lastCall = 0;
  return function (...args) {
    const now = Date.now();
    if (now - lastCall >= interval) {
      lastCall = now;
      return fn.apply(this, args);
    }
  };
}

/**
 * Simple non-cryptographic hash of a string (for post deduplication).
 * Returns a hex string.
 */
export function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16);
}

/**
 * Truncate text to a given character limit with ellipsis.
 */
export function truncate(text, maxLen = 280) {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '…';
}

/**
 * Format a credibility score as a color-coded string.
 * Returns { color, label }
 */
export function formatCredibility(score) {
  if (score == null) return { color: '#888', label: 'Unknown', tier: 'unknown' };
  if (score >= 7.5) return { color: '#22c55e', label: `${score.toFixed(1)}/10`, tier: 'high' };
  if (score >= 5.0) return { color: '#f59e0b', label: `${score.toFixed(1)}/10`, tier: 'medium' };
  if (score >= 2.5) return { color: '#ef4444', label: `${score.toFixed(1)}/10`, tier: 'low' };
  return { color: '#7f1d1d', label: `${score.toFixed(1)}/10`, tier: 'very-low' };
}

/**
 * Format a relative timestamp.
 */
export function timeAgo(ts) {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Safely create an element with attributes and text.
 */
export function createElement(tag, attrs = {}, text = '') {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (text) el.textContent = text;
  return el;
}

/**
 * Returns true if the element is visible in the viewport.
 */
export function isInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

/**
 * Wait for an element matching `selector` to appear in `root`.
 * Resolves with the element. Times out after `timeout` ms.
 */
export function waitForElement(selector, root = document, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const existing = root.querySelector(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = root.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(root, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForElement: "${selector}" not found within ${timeout}ms`));
    }, timeout);
  });
}

/**
 * Map tactic key → human readable label.
 */
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

export function getTacticLabel(key) {
  return TACTIC_LABELS[key] || key;
}

const TACTIC_ICONS = {
  emotional_appeal: '😡',
  fear_mongering: '😨',
  false_dichotomy: '⚖️',
  ad_hominem: '🎯',
  appeal_to_authority: '🎓',
  bandwagon: '🐑',
  slippery_slope: '🎿',
  dehumanization: '🚫',
  cherry_picking: '🍒',
  missing_context: '📋',
  conspiracy: '🕵️',
};

export function getTacticIcon(key) {
  return TACTIC_ICONS[key] || '⚠️';
}
