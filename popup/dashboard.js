/**
 * GlassBox Dashboard + Settings
 * Reads post view data directly from chrome.storage.local —
 * the same store the content script writes to.
 */

import { getSettings, saveSettings } from '../lib/storage.js';
import { getTacticLabel, getTacticIcon } from '../lib/utils.js';

const STORAGE_KEY = 'gb_post_views';

// ─── Stats computation ─────────────────────────────────────────────────────────

async function getStats(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const views  = (result[STORAGE_KEY] || []).filter(v => v.timestamp >= cutoff);

  const total        = views.length;
  const manipulative = views.filter(v => v.manipulation_detected).length;
  const shared       = views.filter(v => v.engagement_type === 'share').length;

  const scored   = views.filter(v => v.credibility_score != null);
  const highCred = scored.filter(v => v.credibility_score >= 7).length;
  const midCred  = scored.filter(v => v.credibility_score >= 4 && v.credibility_score < 7).length;
  const lowCred  = scored.filter(v => v.credibility_score < 4).length;

  const tacticCounts = {};
  views.forEach(v => (v.tactics_used || []).forEach(t => {
    tacticCounts[t] = (tacticCounts[t] || 0) + 1;
  }));

  const topTactics = Object.entries(tacticCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([tactic, count]) => ({ tactic, count }));

  return {
    total, manipulative, shared,
    credibility: {
      highPct: scored.length ? Math.round(highCred / scored.length * 100) : 0,
      midPct:  scored.length ? Math.round(midCred  / scored.length * 100) : 0,
      lowPct:  scored.length ? Math.round(lowCred  / scored.length * 100) : 0,
    },
    topTactics,
  };
}

// ─── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('tab--active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('panel--active'));
    tab.classList.add('tab--active');
    tab.setAttribute('aria-selected', 'true');
    document.getElementById(`panel-${tab.dataset.tab}`)?.classList.add('panel--active');
  });
});

// ─── Master toggle ─────────────────────────────────────────────────────────────

const masterToggle = document.getElementById('master-toggle');
const toggleLabel  = document.getElementById('toggle-label');

masterToggle.addEventListener('change', async () => {
  const enabled = masterToggle.checked;
  toggleLabel.textContent = enabled ? 'On' : 'Off';
  await saveSettings({ enabled });
});

// ─── Dashboard ─────────────────────────────────────────────────────────────────

const periodSelect     = document.getElementById('period-select');
const dashboardContent = document.getElementById('dashboard-content');

async function loadDashboard(days = 30) {
  dashboardContent.innerHTML = '<div class="loading">Loading your data</div>';

  const stats = await getStats(days);

  if (stats.total === 0) {
    dashboardContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📊</div>
        <div class="empty-state__title">No data yet</div>
        <div class="empty-state__text">
          Browse Twitter/X and GlassBox will start tracking<br>
          your information patterns here automatically.
        </div>
      </div>`;
    return;
  }

  const { highPct, midPct, lowPct } = stats.credibility;

  const tacticsHTML = stats.topTactics.length
    ? `<div class="section-title">Top Manipulation Tactics Encountered</div>
       <div class="tactic-list">
         ${stats.topTactics.map(t => `
           <div class="tactic-item">
             <div class="tactic-item__name">
               <span>${getTacticIcon(t.tactic)}</span>
               <span>${getTacticLabel(t.tactic)}</span>
             </div>
             <span class="tactic-item__count">${t.count}</span>
           </div>`).join('')}
       </div>`
    : '';

  dashboardContent.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-card__value">${stats.total}</div>
        <div class="stat-card__label">Posts Seen</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__value" style="color:#ef4444">${stats.manipulative}</div>
        <div class="stat-card__label">Flagged</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__value" style="color:#f59e0b">${stats.shared}</div>
        <div class="stat-card__label">Shared</div>
      </div>
    </div>

    <div class="section-title">Source Credibility Mix</div>
    <div class="cred-bar-wrap">
      <div class="cred-bar">
        <div class="cred-bar__segment" style="width:${highPct}%;background:#22c55e"></div>
        <div class="cred-bar__segment" style="width:${midPct}%;background:#f59e0b"></div>
        <div class="cred-bar__segment" style="width:${lowPct}%;background:#ef4444"></div>
      </div>
      <div class="cred-legend">
        <div class="cred-legend__item"><div class="cred-legend__dot" style="background:#22c55e"></div>High ${highPct}%</div>
        <div class="cred-legend__item"><div class="cred-legend__dot" style="background:#f59e0b"></div>Mixed ${midPct}%</div>
        <div class="cred-legend__item"><div class="cred-legend__dot" style="background:#ef4444"></div>Low ${lowPct}%</div>
      </div>
    </div>

    ${tacticsHTML}
  `;
}

periodSelect.addEventListener('change', () => loadDashboard(parseInt(periodSelect.value, 10)));

// ─── Settings ─────────────────────────────────────────────────────────────────

const settingFields = {
  'setting-credibility':  'showCredibilityBadges',
  'setting-manipulation': 'showManipulationIndicators',
  'setting-cards':        'showContextCards',
  'setting-reflection':   'prePostReflection',
  'setting-threshold':    'manipulationThreshold',
  'setting-min-cred':     'credibilityMinScore',
};

async function loadSettings() {
  const s = await getSettings();
  masterToggle.checked    = s.enabled !== false;
  toggleLabel.textContent = s.enabled !== false ? 'On' : 'Off';
  document.getElementById('setting-credibility').checked  = s.showCredibilityBadges !== false;
  document.getElementById('setting-manipulation').checked = s.showManipulationIndicators !== false;
  document.getElementById('setting-cards').checked        = s.showContextCards !== false;
  document.getElementById('setting-reflection').checked   = s.prePostReflection !== false;
  document.getElementById('setting-threshold').value      = s.manipulationThreshold || 'medium';
  document.getElementById('setting-min-cred').value       = String(s.credibilityMinScore || 4);
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const newSettings = {};
  for (const [elId, key] of Object.entries(settingFields)) {
    const el = document.getElementById(elId);
    newSettings[key] = el.type === 'checkbox' ? el.checked
      : el.type === 'number' ? Number(el.value) : el.value;
  }
  await saveSettings(newSettings);
  const ind = document.getElementById('save-indicator');
  ind.classList.add('save-indicator--visible');
  setTimeout(() => ind.classList.remove('save-indicator--visible'), 2000);
});

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  await loadDashboard(30);
}

init();
