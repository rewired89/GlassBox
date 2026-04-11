/**
 * GlassBox API Server v2.1
 * ───────────────────────────────────────────────────────────────────────────
 * Storage: PostgreSQL when DATABASE_URL is set (persistent on Railway),
 *          JSON files otherwise (local dev / fallback).
 * Zero native build-tool dependencies.
 */

import express   from 'express';
import cors      from 'cors';
import rateLimit from 'express-rate-limit';
import Anthropic from '@anthropic-ai/sdk';
import crypto    from 'crypto';
import path      from 'path';
import fs        from 'fs';
import pg        from 'pg';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT      || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'glassbox-admin-change-me';
const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, 'data');
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY not set — /api/analyze will fail');
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'missing' });

// ── JSON file fallback (used when no DATABASE_URL) ────────────────────────────
const FIGURES_FILE = path.join(DATA_DIR, 'figures.json');
const CACHE_FILE   = path.join(DATA_DIR, 'cache.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const _json = {
  figures: readJSON(FIGURES_FILE, {}),
  cache:   readJSON(CACHE_FILE,   {}),
  saveFigures() { writeJSON(FIGURES_FILE, this.figures); },
  saveCache()   { writeJSON(CACHE_FILE,   this.cache);   },
};

// ── PostgreSQL setup ──────────────────────────────────────────────────────────
let pool = null;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log('[store] No DATABASE_URL — using JSON files (data resets on redeploy)');
    console.log('[store] Add a PostgreSQL database in Railway for persistent storage.');
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS figures (
      handle     TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS analysis_cache (
      hash   TEXT PRIMARY KEY,
      result JSONB NOT NULL,
      ts     BIGINT NOT NULL
    );
  `);
  console.log('[store] PostgreSQL connected ✓');
}

// ── Store API (all async) ─────────────────────────────────────────────────────
const store = {
  async getFigure(handle) {
    const h = handle.toLowerCase();
    if (pool) {
      const r = await pool.query('SELECT data FROM figures WHERE handle=$1', [h]);
      return r.rows[0]?.data || null;
    }
    return _json.figures[h] || null;
  },

  async listFigures() {
    if (pool) {
      const r = await pool.query('SELECT data FROM figures ORDER BY updated_at DESC');
      return r.rows.map(row => row.data);
    }
    return Object.values(_json.figures)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  },

  async setFigure(handle, data) {
    const h = handle.toLowerCase();
    const d = { ...data, updated_at: new Date().toISOString() };
    if (pool) {
      await pool.query(
        `INSERT INTO figures (handle, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (handle) DO UPDATE
           SET data = EXCLUDED.data, updated_at = NOW()`,
        [h, JSON.stringify(d)]
      );
    } else {
      _json.figures[h] = d;
      _json.saveFigures();
    }
  },

  async updateFigure(handle, patch) {
    const h   = handle.toLowerCase();
    const now = new Date().toISOString();
    if (pool) {
      // Merge patch into existing JSONB row (shallow merge at top level)
      await pool.query(
        `INSERT INTO figures (handle, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (handle) DO UPDATE
           SET data = figures.data || $2::jsonb, updated_at = NOW()`,
        [h, JSON.stringify({ ...patch, updated_at: now })]
      );
    } else {
      _json.figures[h] = { ..._json.figures[h], ...patch, updated_at: now };
      _json.saveFigures();
    }
  },

  async deleteFigure(handle) {
    const h = handle.toLowerCase();
    if (pool) {
      await pool.query('DELETE FROM figures WHERE handle=$1', [h]);
    } else {
      delete _json.figures[h];
      _json.saveFigures();
    }
  },

  async getCache(hash) {
    if (pool) {
      const r = await pool.query(
        'SELECT result, ts FROM analysis_cache WHERE hash=$1', [hash]
      );
      if (!r.rows[0]) return null;
      if (Date.now() - Number(r.rows[0].ts) > CACHE_TTL_MS) {
        await pool.query('DELETE FROM analysis_cache WHERE hash=$1', [hash]);
        return null;
      }
      return r.rows[0].result;
    }
    const e = _json.cache[hash];
    if (!e || Date.now() - e.ts > CACHE_TTL_MS) { delete _json.cache[hash]; return null; }
    return e.result;
  },

  async setCache(hash, result) {
    const ts = Date.now();
    if (pool) {
      await pool.query(
        `INSERT INTO analysis_cache (hash, result, ts)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (hash) DO UPDATE
           SET result = EXCLUDED.result, ts = EXCLUDED.ts`,
        [hash, JSON.stringify(result), ts]
      );
    } else {
      _json.cache[hash] = { result, ts };
      const keys = Object.keys(_json.cache);
      if (keys.length > 500) {
        const now = Date.now();
        keys.forEach(k => { if (now - _json.cache[k].ts > CACHE_TTL_MS) delete _json.cache[k]; });
      }
      _json.saveCache();
    }
  },
};

// ── Context cards ──────────────────────────────────────────────────────────────
let CONTEXT_CARDS = [];
for (const p of [path.join(__dirname, '..', 'data', 'context-cards.json'), path.join(__dirname, 'data', 'context-cards.json')]) {
  if (fs.existsSync(p)) {
    try { CONTEXT_CARDS = JSON.parse(fs.readFileSync(p, 'utf8')).cards || []; break; }
    catch { /* skip */ }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const sha = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}

// ── Claude: analyze a post ────────────────────────────────────────────────────
async function claudeAnalyze(text, imageUrls, figure) {
  const figCtx = figure ? `\nAuthor: ${figure.name} (${figure.role || 'public figure'})
Legal record: ${(figure.legal_proceedings || []).length} proceedings on file
Mirror note: ${figure.mirror_note || 'none'}` : '';

  const content = [];
  for (const url of (imageUrls || []).slice(0, 3)) {
    if (/^https:\/\/.+\.(jpg|jpeg|png|gif|webp)/i.test(url)) {
      content.push({ type: 'image', source: { type: 'url', url } });
    }
  }

  content.push({ type: 'text', text: `You are a non-partisan fact-checking AI for a media literacy browser extension. Apply the same standards regardless of political affiliation.
${figCtx}

POST TEXT:
"""${text.slice(0, 2000)}"""

${(imageUrls || []).length ? 'Images attached above — note any concerning visual content.' : ''}

Return ONLY valid JSON — no markdown, no explanation:
{
  "flagged": boolean,
  "flag_reason": "specific factual reason, or null",
  "flag_categories": ["array from: misinformation|hate_speech|dehumanization|election_integrity|climate_denial|vaccine_misinformation|historical_denial|immigration_fearmongering|indigenous_rights_denial"],
  "resonance_score": 0-100,
  "resonance_label": "Empathetic|Neutral|Dismissive|Hostile",
  "resonance_affect": 0-100,
  "context_card_topic": "one of: mmiwg_indigenous_women|native_american_indigeneity|climate_change_consensus|immigration_history|vaccine_safety|election_integrity|lgbtq_history|systemic_racism|harmful_language_impact — or null",
  "fact_checks": [{ "claim": "exact claim", "verdict": "what evidence shows", "source": "source name", "source_url": "url or null" }],
  "image_concerns": "description or null"
}

Resonance guide: 70-100=empathetic/constructive, 50-69=neutral/factual, 30-49=dismissive/sarcastic, 0-29=hostile/dehumanizing.
Only flag: specific false factual claims contradicted by overwhelming documented evidence, or explicit dehumanization of groups. Do NOT flag opinions, policy disagreements, or criticism.` });

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 1200,
    messages: [{ role: 'user', content }],
  });
  const raw = resp.content[0].text.trim();
  try { return JSON.parse(raw); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Non-JSON response'); }
}

// ── Claude: research a public figure ─────────────────────────────────────────
async function claudeResearch(name, handles) {
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 4096,
    messages: [{ role: 'user', content: `You are a public records researcher for an accountability journalism tool.

Research: ${name} (handles: ${handles.map(h => '@' + h.replace(/^@/, '')).join(', ')})

Return ONLY valid JSON — no markdown:
{
  "name": "full legal name",
  "role": "current or most recent official title",
  "jurisdiction": "US|CA|GB|AU|IN|FR|etc",
  "biography": {
    "birth_place": "city, country",
    "birth_year": number or null,
    "is_immigrant": boolean,
    "parents_immigrant": boolean,
    "migration_note": "factual immigration background if relevant to their public positions, or null",
    "source_url": "Wikipedia or official bio URL"
  },
  "legal_proceedings": [{
    "case": "Case name and court",
    "type": "criminal|civil|administrative",
    "status": "convicted|settled|dismissed|ongoing",
    "date": "YYYY-MM-DD",
    "summary": "2-3 sentence factual summary",
    "source": "court or source name",
    "source_url": "official URL"
  }],
  "fact_check_discrepancies": [{
    "claim": "specific public claim they made",
    "finding": "what verified evidence shows",
    "source": "authoritative source",
    "source_url": "URL"
  }],
  "financial_ties": [{
    "entity": "company or organization",
    "relationship": "description",
    "amount": "amount if publicly known",
    "relevance": "why relevant to their public statements",
    "source": "source name",
    "source_url": "URL"
  }],
  "mirror_triggers": ["topic keywords where biographical contrast is relevant, e.g. immigration, climate, indigenous"],
  "mirror_note": "1-2 sentence factual biographical contrast: 'Public records indicate [Name] [fact].' — null if not applicable"
}

Rules: only include information you are highly confident is accurate and verifiable. Use null or [] when uncertain.` }],
  });
  const raw = resp.content[0].text.trim();
  try { return JSON.parse(raw); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Non-JSON research response'); }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const analysisLimit = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false });
const adminLimit    = rateLimit({ windowMs: 60_000, max: 60 });

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.redirect('/admin'));

app.get('/api/health', async (req, res) => {
  const figCount = pool
    ? (await pool.query('SELECT COUNT(*) FROM figures')).rows[0].count
    : Object.keys(_json.figures).length;
  res.json({
    status: 'ok', version: '2.1.0',
    figures: Number(figCount), cards: CONTEXT_CARDS.length,
    storage: pool ? 'postgresql' : 'json-files',
  });
});

// Analyze a post
app.post('/api/analyze', analysisLimit, async (req, res) => {
  const { text, imageUrls = [], handle = null } = req.body;
  if (!text || text.trim().length < 10) return res.status(400).json({ error: 'text required' });

  const cacheKey = sha(text.slice(0, 600) + (handle || '') + String((imageUrls || []).length));
  const cached = await store.getCache(cacheKey);
  if (cached) return res.json(cached);

  const figure = handle ? await store.getFigure(handle) : null;

  try {
    const ai = await claudeAnalyze(text, imageUrls, figure);
    const contextCard = ai.context_card_topic
      ? (CONTEXT_CARDS.find(c => c.id === ai.context_card_topic)?.card || null)
      : null;

    const COLORS = { Empathetic: '#22c55e', Neutral: '#9ca3af', Dismissive: '#f59e0b', Hostile: '#ef4444' };
    const result = {
      flagged:         ai.flagged           || false,
      flag_reason:     ai.flag_reason       || null,
      flag_categories: ai.flag_categories   || [],
      resonance: {
        score:  ai.resonance_score  ?? 50,
        affect: ai.resonance_affect ?? 0,
        label:  ai.resonance_label  || 'Neutral',
        color:  COLORS[ai.resonance_label]  || '#9ca3af',
      },
      context_card:    contextCard,
      context_card_id: ai.context_card_topic || null,
      fact_checks:     ai.fact_checks        || [],
      image_concerns:  ai.image_concerns     || null,
      figure: figure ? {
        name:                     figure.name,
        role:                     figure.role,
        handle:                   figure.handle,
        mirror_note:              figure.mirror_note,
        mirror_triggers:          figure.mirror_triggers,
        legal_proceedings:        figure.legal_proceedings,
        fact_check_discrepancies: figure.fact_check_discrepancies,
        financial_ties:           figure.financial_ties,
        biography:                figure.biography,
      } : null,
    };

    await store.setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

// Get figure (public)
app.get('/api/figures/:handle', async (req, res) => {
  const fig = await store.getFigure(req.params.handle);
  if (!fig) return res.status(404).json({ error: 'Not found' });
  res.json(fig);
});

// ── Admin routes ───────────────────────────────────────────────────────────────

app.get('/api/admin/figures', requireAdmin, adminLimit, async (req, res) => {
  res.json(await store.listFigures());
});

app.post('/api/admin/figures', requireAdmin, adminLimit, async (req, res) => {
  const { name, handles } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  // Normalise handles: strip @, whitespace, lowercase — filter blanks
  const cleanHandles = (handles || [])
    .map(h => h.replace(/^@/, '').trim().toLowerCase())
    .filter(Boolean);

  // If no valid handles supplied, derive a slug from the name
  const primaryHandle = cleanHandles[0] || name.trim().toLowerCase().replace(/\s+/g, '');

  if (!primaryHandle) return res.status(400).json({ error: 'Could not determine a handle — please provide one' });

  console.log(`[add] name="${name.trim()}" handle="${primaryHandle}" allHandles=${JSON.stringify(cleanHandles)}`);

  await store.setFigure(primaryHandle, {
    handle: primaryHandle, name: name.trim(),
    role: null, jurisdiction: 'US',
    biography: {}, legal_proceedings: [], fact_check_discrepancies: [],
    financial_ties: [], mirror_triggers: [], mirror_note: null,
    research_status: 'researching',
  });

  res.json({ status: 'researching', handle: primaryHandle });
  setImmediate(() => runResearch(name.trim(), handles, primaryHandle));
});

app.post('/api/admin/figures/:handle/research', requireAdmin, adminLimit, async (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  const fig = await store.getFigure(h);
  if (!fig) return res.status(404).json({ error: 'Not found' });
  await store.updateFigure(h, { research_status: 'researching' });
  res.json({ status: 'researching', handle: h });
  setImmediate(() => runResearch(fig.name, [h], h));
});

app.put('/api/admin/figures/:handle', requireAdmin, adminLimit, async (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  const { name, role, biography, legal_proceedings, fact_check_discrepancies, financial_ties, mirror_triggers, mirror_note } = req.body;
  await store.updateFigure(h, {
    ...(name               != null && { name }),
    ...(role               != null && { role }),
    ...(biography          != null && { biography }),
    ...(legal_proceedings  != null && { legal_proceedings }),
    ...(fact_check_discrepancies != null && { fact_check_discrepancies }),
    ...(financial_ties     != null && { financial_ties }),
    ...(mirror_triggers    != null && { mirror_triggers }),
    ...(mirror_note        != null && { mirror_note }),
    research_status: 'done',
  });
  res.json(await store.getFigure(h));
});

app.delete('/api/admin/figures/:handle', requireAdmin, adminLimit, async (req, res) => {
  await store.deleteFigure(req.params.handle);
  res.json({ deleted: true });
});

app.get('/api/admin/figures/:handle/status', requireAdmin, adminLimit, async (req, res) => {
  const fig = await store.getFigure(req.params.handle);
  if (!fig) return res.status(404).json({ error: 'Not found' });
  res.json({ handle: fig.handle, name: fig.name, status: fig.research_status, updated_at: fig.updated_at });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Research runner ───────────────────────────────────────────────────────────
async function runResearch(name, handles, primaryHandle) {
  try {
    const data = await claudeResearch(name, handles);
    await store.updateFigure(primaryHandle, {
      name:                     data.name                     || name,
      role:                     data.role                     || null,
      jurisdiction:             data.jurisdiction             || 'US',
      biography:                data.biography                || {},
      legal_proceedings:        data.legal_proceedings        || [],
      fact_check_discrepancies: data.fact_check_discrepancies || [],
      financial_ties:           data.financial_ties           || [],
      mirror_triggers:          data.mirror_triggers          || [],
      mirror_note:              data.mirror_note              || null,
      research_status: 'done',
    });
    console.log(`[research] ✓ ${name} (@${primaryHandle})`);
  } catch (err) {
    console.error(`[research] ✗ ${name}:`, err.message);
    await store.updateFigure(primaryHandle, { research_status: 'error' });
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  await initDb();
  app.listen(PORT, () => {
    console.log(`\nGlassBox API  →  http://localhost:${PORT}`);
    console.log(`Admin         →  http://localhost:${PORT}/admin`);
    console.log(`Storage: ${pool ? 'PostgreSQL' : 'JSON files'}\n`);
  });
})();
