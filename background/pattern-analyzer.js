/**
 * GlassBox Pattern Analyzer
 * Aggregates user behavior patterns and generates discrepancy reports.
 */

import { getAllPostViews, getSelfValues } from '../lib/storage.js';

/**
 * Analyze the user's behavior over the last N days and return a pattern report.
 */
export async function generatePatternReport(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const allViews = await getAllPostViews();
  const views = allViews.filter((v) => v.timestamp >= cutoff);

  if (views.length === 0) {
    return null;
  }

  const total = views.length;
  const engaged = views.filter((v) => v.user_engaged);
  const shared = views.filter((v) => v.engagement_type === 'share');

  // Credibility distribution
  const scored = views.filter((v) => v.credibility_score != null);
  const highCred = scored.filter((v) => v.credibility_score >= 7);
  const lowCred = scored.filter((v) => v.credibility_score < 4);
  const sharedLowCred = shared.filter((v) => v.credibility_score != null && v.credibility_score < 4);

  // Manipulation stats
  const manipulative = views.filter((v) => v.manipulation_detected);
  const engagedManip = engaged.filter((v) => v.manipulation_detected);

  // Tactic frequency
  const tacticCounts = {};
  views.forEach((v) => {
    (v.tactics_used || []).forEach((t) => {
      tacticCounts[t] = (tacticCounts[t] || 0) + 1;
    });
  });

  const topTactics = Object.entries(tacticCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([tactic, count]) => ({ tactic, count }));

  // Confirmation bias indicator
  // (Simplified: if user engages almost exclusively with one credibility tier)
  const engagedHighPct =
    engaged.length > 0 && highCred.length > 0
      ? Math.round((engaged.filter((v) => v.credibility_score >= 7).length / engaged.length) * 100)
      : null;

  const sharedUncheckedPct =
    shared.length > 0
      ? Math.round((shared.filter((v) => v.credibility_score == null).length / shared.length) * 100)
      : null;

  // Patterns
  const patterns = [];

  if (scored.length > 0 && lowCred.length / scored.length > 0.3) {
    patterns.push({
      type: 'low_credibility_consumption',
      description: `${Math.round((lowCred.length / scored.length) * 100)}% of posts you viewed came from low-credibility sources`,
      severity: 'medium',
    });
  }

  if (shared.length > 0 && sharedLowCred.length / shared.length > 0.5) {
    patterns.push({
      type: 'sharing_low_credibility',
      description: `${Math.round((sharedLowCred.length / shared.length) * 100)}% of what you shared came from sources rated below 4/10`,
      severity: 'high',
    });
  }

  if (manipulative.length > 0 && engaged.length > 0) {
    const manipEngagePct = Math.round((engagedManip.length / engaged.length) * 100);
    if (manipEngagePct > 40) {
      patterns.push({
        type: 'engaging_manipulation',
        description: `${manipEngagePct}% of posts you engaged with contained detected manipulation tactics`,
        severity: 'medium',
      });
    }
  }

  return {
    days,
    generated_at: Date.now(),
    summary: {
      total_views: total,
      engaged: engaged.length,
      shared: shared.length,
      manipulative_encountered: manipulative.length,
    },
    credibility: {
      high_pct: scored.length ? Math.round((highCred.length / scored.length) * 100) : 0,
      low_pct: scored.length ? Math.round((lowCred.length / scored.length) * 100) : 0,
      shared_low_cred: sharedLowCred.length,
      shared_total: shared.length,
    },
    top_tactics: topTactics,
    patterns,
    engagement_stats: {
      high_cred_engage_pct: engagedHighPct,
      shared_unchecked_pct: sharedUncheckedPct,
    },
  };
}

/**
 * Detect discrepancies between user's self-stated values and actual behavior.
 */
export async function detectDiscrepancies() {
  const values = await getSelfValues();
  if (values.length === 0) return [];

  const report = await generatePatternReport(30);
  if (!report) return [];

  const discrepancies = [];

  // If user stated "I value factual information" but frequently shares low-cred content
  const factValues = values.filter((v) =>
    /fact|truth|accurate|evidence|research/i.test(v.value)
  );

  if (factValues.length > 0 && report.credibility.shared_low_cred > 2) {
    discrepancies.push({
      value: factValues[0].value,
      contradiction: `You shared ${report.credibility.shared_low_cred} posts from low-credibility sources this month`,
      severity: 'medium',
    });
  }

  // If user stated "I respect everyone" but engaged with dehumanizing content
  const respectValues = values.filter((v) =>
    /respect|dignity|equal|human/i.test(v.value)
  );

  if (respectValues.length > 0) {
    const dehumanTactic = report.top_tactics.find((t) => t.tactic === 'dehumanization');
    if (dehumanTactic && dehumanTactic.count > 0) {
      discrepancies.push({
        value: respectValues[0].value,
        contradiction: `You encountered ${dehumanTactic.count} posts with dehumanizing language and engaged with some`,
        severity: 'high',
      });
    }
  }

  return discrepancies;
}
