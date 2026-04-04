/**
 * GlassBox Credibility Database
 * Loads and queries the domain credibility scores.
 */

let domainData = null;

async function loadData() {
  if (domainData) return domainData;
  const url = chrome.runtime.getURL('data/credibility-scores.json');
  const res = await fetch(url);
  const json = await res.json();
  domainData = json.domains || {};
  return domainData;
}

/**
 * Look up credibility data for a domain.
 * @param {string} domain - e.g. "nytimes.com"
 * @returns {Object|null}
 */
export async function lookupDomain(domain) {
  const data = await loadData();

  // Exact match
  if (data[domain]) return data[domain];

  // Try stripping subdomains progressively
  const parts = domain.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (data[candidate]) return data[candidate];
  }

  return null;
}

/**
 * Get all known domains with their scores.
 */
export async function getAllDomains() {
  const data = await loadData();
  return Object.entries(data).map(([domain, info]) => ({ domain, ...info }));
}

/**
 * Score tier: 'high' | 'medium' | 'low' | 'very-low' | 'satire' | 'unknown'
 */
export function getScoreTier(score) {
  if (score == null) return 'unknown';
  if (score >= 7.5) return 'high';
  if (score >= 5.0) return 'medium';
  if (score >= 2.5) return 'low';
  return 'very-low';
}

/**
 * Returns an inline badge object for a domain.
 */
export async function getBadge(domain) {
  const info = await lookupDomain(domain);
  if (!info) return null;

  const isSatire = info.score === null && info.bias === 'Satire';

  return {
    domain,
    label: info.label || domain,
    score: info.score,
    bias: info.bias,
    tier: isSatire ? 'satire' : getScoreTier(info.score),
    strengths: info.strengths || [],
    considerations: info.considerations || [],
    ownership: info.ownership,
    funding: info.funding || [],
    fact_check_record: info.fact_check_record,
  };
}
