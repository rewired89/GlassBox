/**
 * GlassBox Storage Layer
 * Wraps IndexedDB for local pattern tracking and Chrome Storage for settings.
 */

const DB_NAME = 'glassbox';
const DB_VERSION = 1;

const STORES = {
  POST_VIEWS: 'post_views',
  SELF_VALUES: 'self_values',
  DISCREPANCIES: 'behavior_discrepancies',
  CARD_INTERACTIONS: 'card_interactions',
};

// ─── IndexedDB ────────────────────────────────────────────────────────────────

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORES.POST_VIEWS)) {
        const store = db.createObjectStore(STORES.POST_VIEWS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('timestamp', 'timestamp');
        store.createIndex('platform', 'platform');
        store.createIndex('source_domain', 'source_domain');
      }

      if (!db.objectStoreNames.contains(STORES.SELF_VALUES)) {
        db.createObjectStore(STORES.SELF_VALUES, {
          keyPath: 'id',
          autoIncrement: true,
        });
      }

      if (!db.objectStoreNames.contains(STORES.DISCREPANCIES)) {
        db.createObjectStore(STORES.DISCREPANCIES, {
          keyPath: 'id',
          autoIncrement: true,
        });
      }

      if (!db.objectStoreNames.contains(STORES.CARD_INTERACTIONS)) {
        const cardStore = db.createObjectStore(STORES.CARD_INTERACTIONS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        cardStore.createIndex('card_id', 'card_id');
        cardStore.createIndex('timestamp', 'timestamp');
      }
    };

    request.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function transaction(storeName, mode = 'readonly') {
  return openDB().then((db) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    return { tx, store };
  });
}

function idbPut(storeName, data) {
  return transaction(storeName, 'readwrite').then(({ store }) =>
    new Promise((resolve, reject) => {
      const req = store.put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })
  );
}

function idbGetAll(storeName) {
  return transaction(storeName).then(({ store }) =>
    new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })
  );
}

function idbGetAllByIndex(storeName, indexName, value) {
  return transaction(storeName).then(({ store }) =>
    new Promise((resolve, reject) => {
      const index = store.index(indexName);
      const req = index.getAll(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })
  );
}

function idbCountByIndex(storeName, indexName, value) {
  return transaction(storeName).then(({ store }) =>
    new Promise((resolve, reject) => {
      const index = store.index(indexName);
      const req = index.count(value);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    })
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Record a post view event.
 * @param {Object} params
 * @param {string} params.platform
 * @param {string} params.source_domain
 * @param {number} params.credibility_score
 * @param {boolean} params.manipulation_detected
 * @param {string[]} params.tactics_used
 * @param {boolean} params.user_engaged
 * @param {string} params.engagement_type - 'like' | 'share' | 'comment' | 'view'
 * @param {string} params.post_text_hash - anonymized hash for dedup
 */
export function recordPostView(params) {
  return idbPut(STORES.POST_VIEWS, {
    ...params,
    timestamp: Date.now(),
  });
}

/**
 * Record a card interaction.
 * @param {string} cardId
 * @param {string} action - 'expand' | 'dismiss' | 'source_click'
 */
export function recordCardInteraction(cardId, action) {
  return idbPut(STORES.CARD_INTERACTIONS, {
    card_id: cardId,
    action,
    timestamp: Date.now(),
  });
}

/**
 * Get all post views in the last N days.
 * @param {number} days
 */
export async function getPostViewsInLastDays(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const all = await idbGetAll(STORES.POST_VIEWS);
  return all.filter((p) => p.timestamp >= cutoff);
}

/**
 * Get lifetime post views.
 */
export function getAllPostViews() {
  return idbGetAll(STORES.POST_VIEWS);
}

/**
 * Get all card interactions for a given card.
 */
export function getCardInteractions(cardId) {
  return idbGetAllByIndex(STORES.CARD_INTERACTIONS, 'card_id', cardId);
}

/**
 * Save user's self-stated values (set during onboarding).
 */
export async function saveSelfValues(values) {
  const db = await openDB();
  const tx = db.transaction(STORES.SELF_VALUES, 'readwrite');
  const store = tx.objectStore(STORES.SELF_VALUES);

  // Clear existing and replace
  await new Promise((res, rej) => {
    const req = store.clear();
    req.onsuccess = res;
    req.onerror = rej;
  });

  for (const value of values) {
    await new Promise((res, rej) => {
      const req = store.put({ value, added_date: Date.now() });
      req.onsuccess = res;
      req.onerror = rej;
    });
  }
}

export function getSelfValues() {
  return idbGetAll(STORES.SELF_VALUES);
}

// ─── Chrome Storage (settings) ────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: true,
  showCredibilityBadges: true,
  showManipulationIndicators: true,
  showContextCards: true,
  prePostReflection: true,
  manipulationThreshold: 'medium', // 'low' | 'medium' | 'high'
  credibilityMinScore: 4,
  antiechoChamberpct: 20,
  onboardingComplete: false,
  selfValues: [],
};

export async function getSettings() {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve(DEFAULT_SETTINGS);
      return;
    }
    chrome.storage.sync.get('glassbox_settings', (result) => {
      resolve({ ...DEFAULT_SETTINGS, ...(result.glassbox_settings || {}) });
    });
  });
}

export async function saveSettings(settings) {
  const current = await getSettings();
  const merged = { ...current, ...settings };
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      resolve(merged);
      return;
    }
    chrome.storage.sync.set({ glassbox_settings: merged }, () => resolve(merged));
  });
}

// ─── Stats helpers ─────────────────────────────────────────────────────────────

/**
 * Compute dashboard stats for the last N days.
 */
export async function computeStats(days = 30) {
  const views = await getPostViewsInLastDays(days);

  const total = views.length;
  const engaged = views.filter((v) => v.user_engaged).length;
  const shared = views.filter((v) => v.engagement_type === 'share').length;
  const manipulative = views.filter((v) => v.manipulation_detected).length;

  const scored = views.filter((v) => v.credibility_score != null);
  const highCred = scored.filter((v) => v.credibility_score >= 7).length;
  const midCred = scored.filter(
    (v) => v.credibility_score >= 4 && v.credibility_score < 7
  ).length;
  const lowCred = scored.filter((v) => v.credibility_score < 4).length;

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

  return {
    total,
    engaged,
    shared,
    manipulative,
    credibility: {
      high: highCred,
      mixed: midCred,
      low: lowCred,
      highPct: scored.length ? Math.round((highCred / scored.length) * 100) : 0,
      midPct: scored.length ? Math.round((midCred / scored.length) * 100) : 0,
      lowPct: scored.length ? Math.round((lowCred / scored.length) * 100) : 0,
    },
    topTactics,
    days,
  };
}
