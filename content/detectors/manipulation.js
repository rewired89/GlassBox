/**
 * GlassBox Manipulation Detector
 * Analyzes post text for manipulation tactics using pattern matching.
 * Phase 1: Keyword + regex based. Phase 2: NLP model.
 */

let patternsData = null;

async function loadPatterns() {
  if (patternsData) return patternsData;
  try {
    const url = chrome.runtime.getURL('data/manipulation-patterns.json');
    const res = await fetch(url);
    patternsData = await res.json();
  } catch (err) {
    console.warn('[GlassBox] Failed to load manipulation patterns:', err);
    patternsData = { tactics: {}, thresholds: { low: 0.3, medium: 0.6, high: 1.0 } };
  }
  return patternsData;
}

/**
 * Normalize text for matching: lowercase, collapse whitespace.
 */
function normalize(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Test a single tactic against normalized text.
 * Returns a match score (0 = no match, >0 = matched with weight).
 */
function testTactic(tactic, tacticKey, normalizedText) {
  const matches = [];

  // Keyword patterns (case-insensitive substring)
  for (const pattern of tactic.patterns || []) {
    if (normalizedText.includes(pattern.toLowerCase())) {
      matches.push(pattern);
    }
  }

  // Regex patterns
  for (const regexStr of tactic.regex_patterns || []) {
    try {
      const re = new RegExp(regexStr, 'i');
      if (re.test(normalizedText)) {
        matches.push(regexStr);
      }
    } catch {
      // Invalid regex — skip
    }
  }

  if (matches.length === 0) return null;

  return {
    tactic: tacticKey,
    label: tactic.label,
    icon: tactic.icon,
    description: tactic.description,
    matches,
    score: tactic.weight * Math.min(matches.length, 3), // cap at 3x to avoid overwhelming
  };
}

/**
 * Main detection function.
 *
 * @param {string} text - Post text content
 * @returns {Promise<{
 *   is_manipulative: boolean,
 *   score: number,
 *   level: 'none'|'low'|'medium'|'high',
 *   tactics: Array<{tactic, label, icon, description, matches, score}>,
 *   confidence: number
 * }>}
 */
export async function detectManipulation(text) {
  if (!text || text.length < 20) {
    return { is_manipulative: false, score: 0, level: 'none', tactics: [], confidence: 0 };
  }

  const data = await loadPatterns();
  const normalized = normalize(text);
  const { tactics, thresholds } = data;

  const detectedTactics = [];
  let totalScore = 0;

  for (const [tacticKey, tactic] of Object.entries(tactics)) {
    const result = testTactic(tactic, tacticKey, normalized);
    if (result) {
      detectedTactics.push(result);
      totalScore += result.score;
    }
  }

  // Normalize score to 0-3 range for leveling
  const normalizedScore = Math.min(totalScore, 5);

  let level = 'none';
  if (normalizedScore >= thresholds.high) level = 'high';
  else if (normalizedScore >= thresholds.medium) level = 'medium';
  else if (normalizedScore >= thresholds.low) level = 'low';

  // Confidence: higher with more tactic diversity
  const confidence = detectedTactics.length > 0
    ? Math.min(0.5 + detectedTactics.length * 0.15, 0.95)
    : 0;

  return {
    is_manipulative: level !== 'none',
    score: totalScore,
    level,
    tactics: detectedTactics.sort((a, b) => b.score - a.score),
    confidence,
  };
}

/**
 * Detect the primary manipulation tactic (highest score) for compact display.
 */
export async function getPrimaryTactic(text) {
  const result = await detectManipulation(text);
  if (!result.is_manipulative || result.tactics.length === 0) return null;
  return result.tactics[0];
}

/**
 * Quick sync check using only the highest-weight tactics (for pre-post reflection speed).
 * Does not require async data loading if patterns are already cached.
 */
export async function quickCheck(text) {
  const result = await detectManipulation(text);
  return {
    flagged: result.is_manipulative,
    level: result.level,
    topTactic: result.tactics[0] || null,
    count: result.tactics.length,
  };
}
