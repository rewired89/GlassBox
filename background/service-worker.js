/**
 * GlassBox Service Worker
 * - Routes credibility badge lookups to the credibility DB
 * - Stores post view data in chrome.storage.local (accessible from popup)
 * - Computes dashboard stats
 */

import { getBadge, lookupDomain } from './credibility-db.js';

const STORAGE_KEY_VIEWS = 'gb_post_views';
const MAX_DAYS_STORED   = 90;

// ─── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'GET_BADGE':
      getBadge(payload.domain).then(sendResponse);
      return true;

    case 'LOOKUP_DOMAIN':
      lookupDomain(payload.domain).then(info => sendResponse({ domain: payload.domain, info }));
      return true;

    case 'RECORD_POST_VIEW':
      storePostView(payload).then(() => sendResponse({ ok: true }));
      return true;

    case 'RECORD_CARD_INTERACTION':
      // Lightweight — just acknowledge for now; Phase 2 will track card stats
      sendResponse({ ok: true });
      return false;

    case 'GET_STATS':
      getStats(payload?.days || 30).then(sendResponse);
      return true;

    case 'PING':
      sendResponse({ ok: true });
      return false;

    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

// ─── Post View Storage ─────────────────────────────────────────────────────────

async function storePostView(data) {
  const result = await chrome.storage.local.get(STORAGE_KEY_VIEWS);
  const views  = result[STORAGE_KEY_VIEWS] || [];

  views.push(data);

  // Trim to last MAX_DAYS_STORED days to keep storage size bounded
  const cutoff  = Date.now() - MAX_DAYS_STORED * 24 * 60 * 60 * 1000;
  const trimmed = views.filter(v => v.timestamp >= cutoff);

  await chrome.storage.local.set({ [STORAGE_KEY_VIEWS]: trimmed });
}

// ─── Stats Computation ─────────────────────────────────────────────────────────

async function getStats(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await chrome.storage.local.get(STORAGE_KEY_VIEWS);
  const views  = (result[STORAGE_KEY_VIEWS] || []).filter(v => v.timestamp >= cutoff);

  const total       = views.length;
  const engaged     = views.filter(v => v.user_engaged).length;
  const shared      = views.filter(v => v.engagement_type === 'share').length;
  const manipulative = views.filter(v => v.manipulation_detected).length;

  const scored  = views.filter(v => v.credibility_score != null);
  const highCred = scored.filter(v => v.credibility_score >= 7).length;
  const midCred  = scored.filter(v => v.credibility_score >= 4 && v.credibility_score < 7).length;
  const lowCred  = scored.filter(v => v.credibility_score < 4).length;

  const tacticCounts = {};
  views.forEach(v => {
    (v.tactics_used || []).forEach(t => {
      tacticCounts[t] = (tacticCounts[t] || 0) + 1;
    });
  });

  const topTactics = Object.entries(tacticCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([tactic, count]) => ({ tactic, count }));

  return {
    total, engaged, shared, manipulative,
    credibility: {
      high: highCred, mixed: midCred, low: lowCred,
      highPct: scored.length ? Math.round(highCred / scored.length * 100) : 0,
      midPct:  scored.length ? Math.round(midCred  / scored.length * 100) : 0,
      lowPct:  scored.length ? Math.round(lowCred  / scored.length * 100) : 0,
    },
    topTactics,
    days,
  };
}

// ─── Install ───────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'popup/dashboard.html?onboarding=1' });
  }
});

// ─── Weekly pattern alarm ──────────────────────────────────────────────────────

chrome.alarms.create('weekly-report', { periodInMinutes: 60 * 24 * 7 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'weekly-report') getStats(7); // future: trigger notification
});
