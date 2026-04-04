/**
 * GlassBox Credibility Detector
 * Finds links in a post element and looks up domain credibility scores.
 */

import { extractDomain, extractLinksFromElement } from '../../lib/utils.js';

/**
 * Find all external links in a post element and return credibility info
 * by messaging the background service worker.
 *
 * @param {Element} postEl
 * @returns {Promise<Array<{domain, badge}>>}
 */
export async function getPostCredibility(postEl) {
  const links = extractLinksFromElement(postEl);
  if (links.length === 0) return [];

  const domains = [...new Set(links.map(extractDomain).filter(Boolean))];
  // Filter out Twitter's own t.co redirect domain and social media domains
  const externalDomains = domains.filter(
    (d) =>
      !['t.co', 'twitter.com', 'x.com', 'youtu.be', 'bit.ly', 'ow.ly'].includes(d)
  );

  if (externalDomains.length === 0) return [];

  const results = await Promise.all(
    externalDomains.map((domain) =>
      getBadgeFromBackground(domain).then((badge) => ({ domain, badge }))
    )
  );

  return results.filter((r) => r.badge !== null);
}

/**
 * Get badge data from background service worker.
 */
function getBadgeFromBackground(domain) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_BADGE', payload: { domain } }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

/**
 * Find the lowest credibility score from a list of credibility results.
 */
export function getLowestScore(credibilityResults) {
  const scored = credibilityResults.filter(
    (r) => r.badge && r.badge.score != null
  );
  if (scored.length === 0) return null;
  return scored.reduce(
    (min, r) => (r.badge.score < min.badge.score ? r : min),
    scored[0]
  );
}

/**
 * Get a summary for display: the primary (lowest) credibility info.
 */
export function getPrimaryCredibilityInfo(credibilityResults) {
  const worst = getLowestScore(credibilityResults);
  if (!worst) return null;
  return worst.badge;
}
