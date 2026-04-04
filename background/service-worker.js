/**
 * GlassBox Service Worker
 * Handles background processing, credibility lookups, and message routing.
 */

import { getBadge, lookupDomain } from './credibility-db.js';
import { generatePatternReport } from './pattern-analyzer.js';

// ─── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'LOOKUP_DOMAIN':
      handleDomainLookup(payload.domain).then(sendResponse);
      return true; // async

    case 'GET_BADGE':
      getBadge(payload.domain).then(sendResponse);
      return true;

    case 'GET_PATTERN_REPORT':
      generatePatternReport(payload.days || 30).then(sendResponse);
      return true;

    case 'PING':
      sendResponse({ ok: true });
      return false;

    default:
      sendResponse({ error: 'Unknown message type' });
      return false;
  }
});

async function handleDomainLookup(domain) {
  try {
    const info = await lookupDomain(domain);
    return { domain, info };
  } catch (err) {
    return { domain, info: null, error: err.message };
  }
}

// ─── Install / Update ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open onboarding on first install
    chrome.tabs.create({ url: 'popup/dashboard.html?onboarding=1' });
  }
});

// ─── Alarm for periodic pattern analysis ──────────────────────────────────────

chrome.alarms.create('weekly-report', { periodInMinutes: 60 * 24 * 7 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'weekly-report') {
    await generatePatternReport(7);
    // In a future version, push a notification to the user
  }
});
