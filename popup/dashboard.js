/**
 * GlassBox Dashboard + Settings Script
 * Runs in the popup context.
 */

import { computeStats, getSettings, saveSettings } from '../lib/storage.js';
import { getTacticLabel, getTacticIcon } from '../lib/utils.js';

// ─── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.remove('tab--active');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('panel--active'));

    tab.classList.add('tab--active');
    tab.setAttribute('aria-selected', 'true');

    const panelId = `panel-${tab.dataset.tab}`;
    document.getElementById(panelId)?.classList.add('panel--active');
  });
});

// ─── Master toggle ─────────────────────────────────────────────────────────────

const masterToggle = document.getElementById('master-toggle');
const toggleLabel = document.getElementById('toggle-label');

masterToggle.addEventListener('change', async () => {
  const enabled = masterToggle.checked;
  toggleLabel.textContent = enabled ? 'On' : 'Off';
  await saveSettings({ enabled });
});

// ─── Dashboard ─────────────────────────────────────────────────────────────────

const periodSelect = document.getElementById('period-select');
const dashboardContent = document.getElementById('dashboard-content');

async function loadDashboard(days = 30) {
  dashboardContent.innerHTML = '<div class="loading">Loading your data</div>';

  try {
    const stats = await computeStats(days);

    if (stats.total === 0) {
      dashboardContent.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">📊</div>
          <div class="empty-state__title">No data yet</div>
          <div class="empty-state__text">
            Visit Twitter/X and GlassBox will start tracking<br>
            your information patterns here.
          </div>
        </div>`;
      return;
    }

    // Credibility bar widths
    const { highPct, midPct, lowPct } = stats.credibility;

    // Top tactics
    const tacticsHTML = stats.topTactics.length > 0
      ? `
        <div class="section-title">Top Manipulation Tactics</div>
        <div class="tactic-list">
          ${stats.topTactics.map((t) => `
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
          <div class="stat-card__label">Posts Viewed</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__value">${stats.engaged}</div>
          <div class="stat-card__label">Engaged</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__value">${stats.manipulative}</div>
          <div class="stat-card__label">Flagged</div>
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
          <div class="cred-legend__item">
            <div class="cred-legend__dot" style="background:#22c55e"></div>
            High ${highPct}%
          </div>
          <div class="cred-legend__item">
            <div class="cred-legend__dot" style="background:#f59e0b"></div>
            Mixed ${midPct}%
          </div>
          <div class="cred-legend__item">
            <div class="cred-legend__dot" style="background:#ef4444"></div>
            Low ${lowPct}%
          </div>
        </div>
      </div>

      ${tacticsHTML}
    `;
  } catch (err) {
    dashboardContent.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">⚠️</div>
        <div class="empty-state__title">Could not load data</div>
        <div class="empty-state__text">${err.message}</div>
      </div>`;
  }
}

periodSelect.addEventListener('change', () => {
  loadDashboard(parseInt(periodSelect.value, 10));
});

// ─── Settings ─────────────────────────────────────────────────────────────────

const settingFields = {
  'setting-credibility': 'showCredibilityBadges',
  'setting-manipulation': 'showManipulationIndicators',
  'setting-cards': 'showContextCards',
  'setting-reflection': 'prePostReflection',
  'setting-threshold': 'manipulationThreshold',
  'setting-min-cred': 'credibilityMinScore',
};

async function loadSettings() {
  const settings = await getSettings();

  masterToggle.checked = settings.enabled !== false;
  toggleLabel.textContent = settings.enabled !== false ? 'On' : 'Off';

  document.getElementById('setting-credibility').checked = settings.showCredibilityBadges !== false;
  document.getElementById('setting-manipulation').checked = settings.showManipulationIndicators !== false;
  document.getElementById('setting-cards').checked = settings.showContextCards !== false;
  document.getElementById('setting-reflection').checked = settings.prePostReflection !== false;
  document.getElementById('setting-threshold').value = settings.manipulationThreshold || 'medium';
  document.getElementById('setting-min-cred').value = String(settings.credibilityMinScore || 4);
}

document.getElementById('save-settings').addEventListener('click', async () => {
  const newSettings = {};

  for (const [elId, key] of Object.entries(settingFields)) {
    const el = document.getElementById(elId);
    if (el.type === 'checkbox') {
      newSettings[key] = el.checked;
    } else {
      newSettings[key] = el.type === 'number' ? Number(el.value) : el.value;
    }
  }

  await saveSettings(newSettings);

  const indicator = document.getElementById('save-indicator');
  indicator.classList.add('save-indicator--visible');
  setTimeout(() => indicator.classList.remove('save-indicator--visible'), 2000);
});

// ─── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  await loadSettings();
  await loadDashboard(30);
}

init();
