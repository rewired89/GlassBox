/**
 * GlassBox Dashboard + Settings
 * Self-contained — no external imports.
 * Reads from chrome.storage.local (same key the content script writes to).
 */

const STORAGE_KEY = 'gb_post_views';

const DEFAULT_SETTINGS = {
  enabled: true,
  showCredibilityBadges: true,
  showManipulationIndicators: true,
  showContextCards: true,
  prePostReflection: true,
  manipulationThreshold: 'medium',
  credibilityMinScore: 4,
};

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
const TACTIC_ICONS = {
  emotional_appeal: '😡', fear_mongering: '😨', false_dichotomy: '⚖️',
  ad_hominem: '🎯', appeal_to_authority: '🎓', bandwagon: '🐑',
  slippery_slope: '🎿', dehumanization: '🚫', cherry_picking: '🍒',
  missing_context: '📋', conspiracy: '🕵️',
};
function getTacticLabel(k) { return TACTIC_LABELS[k] || k; }
function getTacticIcon(k)  { return TACTIC_ICONS[k]  || '⚠️'; }

// ─── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get('glassbox_settings', r =>
      resolve({ ...DEFAULT_SETTINGS, ...(r.glassbox_settings || {}) })
    );
  });
}

function saveSettings(patch) {
  return getSettings().then(current => {
    const merged = { ...current, ...patch };
    return new Promise(resolve =>
      chrome.storage.sync.set({ glassbox_settings: merged }, () => resolve(merged))
    );
  });
}

// ─── Stats computation ─────────────────────────────────────────────────────────

async function getStats(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const views  = (result[STORAGE_KEY] || []).filter(v => v.timestamp >= cutoff);

  const total        = views.length;
  const manipulative = views.filter(v => v.manipulation_detected).length;
  const shared       = views.filter(v => v.engagement_type === 'share').length;
  const flagged      = views.filter(v => v.engagement_type === 'attempted_post').length;

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

  return { total, manipulative, shared, flagged, topTactics,
    credibility: {
      highPct: scored.length ? Math.round(highCred / scored.length * 100) : 0,
      midPct:  scored.length ? Math.round(midCred  / scored.length * 100) : 0,
      lowPct:  scored.length ? Math.round(lowCred  / scored.length * 100) : 0,
    },
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
          Browse Twitter/X with GlassBox active and<br>
          your stats will appear here automatically.
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
        <div class="stat-card__value" style="color:#ef4444">${stats.flagged}</div>
        <div class="stat-card__label">Flagged</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__value" style="color:#f59e0b">${stats.shared}</div>
        <div class="stat-card__label">Posted Anyway</div>
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
  document.getElementById('setting-api-url').value        = s.apiUrl || '';
  if (s.apiUrl) checkApiStatus(s.apiUrl);
}

async function checkApiStatus(url) {
  const el = document.getElementById('api-status');
  if (!url) { el.textContent = ''; return; }
  el.textContent = 'Checking…';
  el.style.color = 'var(--text-muted)';
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    el.textContent = `✓ Connected — ${d.figures} figures, ${d.cards} cards`;
    el.style.color = 'var(--green)';
  } catch {
    el.textContent = '✗ Could not reach API — check the URL';
    el.style.color = 'var(--red)';
  }
}

document.getElementById('setting-api-url').addEventListener('blur', e => {
  const url = e.target.value.trim();
  if (url) checkApiStatus(url);
});

document.getElementById('save-settings').addEventListener('click', async () => {
  const newSettings = {};
  for (const [elId, key] of Object.entries(settingFields)) {
    const el = document.getElementById(elId);
    newSettings[key] = el.type === 'checkbox' ? el.checked
      : el.type === 'number' ? Number(el.value) : el.value;
  }
  newSettings.apiUrl = document.getElementById('setting-api-url').value.trim();
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
