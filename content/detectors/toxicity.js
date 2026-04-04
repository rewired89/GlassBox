/**
 * GlassBox Toxicity Detector
 * Phase 1: Pattern-based toxicity signals.
 * Phase 2: Integrate Perspective API or local TF.js model.
 */

// High-signal toxicity patterns (not an exhaustive list — intentionally focuses
// on clear cases to minimize false positives in Phase 1)
const TOXICITY_PATTERNS = [
  // Explicit slurs are not enumerated here to avoid creating a slur list.
  // Phase 2 will use the Perspective API which handles this properly.

  // Dehumanizing comparisons
  /\b(animals?|vermin|cockroach|parasite|plague|infestation)\b/i,

  // Explicit violence wishes
  /\b(should (be|get) (killed|shot|hanged|executed|eliminated))\b/i,
  /\b(kill (all|every|those))\b/i,
  /\b(die (already|please|slowl))\b/i,

  // Harassment patterns
  /\b(go (kill|hang|shoot) yourself)\b/i,
  /\b(kys)\b/i,

  // Extreme xenophobia
  /\b(go back to (your country|where you came from|africa|mexico|china|the middle east))\b/i,

  // Strong derogatory combinations
  /\b(disgusting (people|humans|immigrants|foreigners))\b/i,
];

const SENSITIVE_LANGUAGE_PATTERNS = [
  // Language with historical weight
  /\b(go back to your country)\b/i,
  /\b(real Americans?)\b/i,
  /\b(these people)\b/i,
  /\b(you people)\b/i,
  /\b(those people)\b/i,
  /\b(they( are| 're) (all|just|only))\b/i,
];

/**
 * Analyze text for toxicity signals.
 *
 * @param {string} text
 * @returns {{
 *   toxic: boolean,
 *   score: number,       // 0-1
 *   sensitive: boolean,
 *   flags: string[]
 * }}
 */
export function analyzeToxicity(text) {
  if (!text || text.length < 5) {
    return { toxic: false, score: 0, sensitive: false, flags: [] };
  }

  const flags = [];
  let toxicMatches = 0;
  let sensitiveMatches = 0;

  for (const pattern of TOXICITY_PATTERNS) {
    if (pattern.test(text)) {
      toxicMatches++;
      flags.push('toxicity_pattern');
    }
  }

  for (const pattern of SENSITIVE_LANGUAGE_PATTERNS) {
    if (pattern.test(text)) {
      sensitiveMatches++;
      flags.push('sensitive_language');
    }
  }

  // Excessive caps and punctuation (emotional amplification)
  const words = text.split(/\s+/);
  const capsWords = words.filter((w) => w.length > 3 && w === w.toUpperCase());
  if (capsWords.length / words.length > 0.3) {
    flags.push('excessive_caps');
  }

  const exclamations = (text.match(/!/g) || []).length;
  if (exclamations > 3) {
    flags.push('excessive_punctuation');
  }

  const toxic = toxicMatches > 0;
  const score = Math.min(
    (toxicMatches * 0.4 + sensitiveMatches * 0.15) + (flags.includes('excessive_caps') ? 0.1 : 0),
    1.0
  );

  return {
    toxic,
    score,
    sensitive: sensitiveMatches > 0 || flags.includes('excessive_caps'),
    flags: [...new Set(flags)],
  };
}

/**
 * Returns a human-readable summary for UI display.
 */
export function getToxicitySummary(result) {
  if (result.toxic) {
    return 'Contains language that may be harmful or targeted at individuals or groups.';
  }
  if (result.sensitive) {
    return 'Contains language with historical or social weight that some people may find hurtful.';
  }
  return null;
}
