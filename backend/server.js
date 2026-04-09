/**
 * GlassBox API Server v2
 * ───────────────────────────────────────────────────────────────────────────
 * Zero native dependencies — runs on any Node.js 20 host without build tools.
 * Data persisted as JSON files (figures.json + cache.json in DATA_DIR).
 */

import express      from 'express';
import cors         from 'cors';
import rateLimit    from 'express-rate-limit';
import Anthropic    from '@anthropic-ai/sdk';
import crypto       from 'crypto';
import path         from 'path';
import fs           from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
const PORT      = process.env.PORT      || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'glassbox-admin-change-me';
const DATA_DIR  = process.env.DATA_DIR  || path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY not set — /api/analyze will return errors');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'missing' });

// ── JSON file store (no native deps) ─────────────────────────────────────────
const FIGURES_FILE = path.join(DATA_DIR, 'figures.json');
const CACHE_FILE   = path.join(DATA_DIR, 'cache.json');
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// figures: { [handle]: { ...figureData } }
const store = {
  figures: readJSON(FIGURES_FILE, {}),
  cache:   readJSON(CACHE_FILE,   {}),

  saveFigures() { writeJSON(FIGURES_FILE, this.figures); },
  saveCache()   { writeJSON(CACHE_FILE,   this.cache);   },

  getFigure(handle) {
    return this.figures[handle.toLowerCase()] || null;
  },
  listFigures() {
    return Object.values(this.figures)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  },
  setFigure(handle, data) {
    this.figures[handle.toLowerCase()] = { ...data, updated_at: new Date().toISOString() };
    this.saveFigures();
  },
  updateFigure(handle, patch) {
    const h = handle.toLowerCase();
    this.figures[h] = { ...(this.figures[h] || {}), ...patch, updated_at: new Date().toISOString() };
    this.saveFigures();
  },
  deleteFigure(handle) {
    delete this.figures[handle.toLowerCase()];
    this.saveFigures();
  },

  getCache(hash) {
    const entry = this.cache[hash];
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) { delete this.cache[hash]; return null; }
    return entry.result;
  },
  setCache(hash, result) {
    this.cache[hash] = { result, ts: Date.now() };
    // Prune if over 500 entries
    const keys = Object.keys(this.cache);
    if (keys.length > 500) {
      const now = Date.now();
      keys.forEach(k => { if (now - this.cache[k].ts > CACHE_TTL_MS) delete this.cache[k]; });
    }
    this.saveCache();
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

// Root → redirect to admin
app.get('/', (req, res) => res.redirect('/admin'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', figures: Object.keys(store.figures).length, cards: CONTEXT_CARDS.length });
});

// Analyze a post
app.post('/api/analyze', analysisLimit, async (req, res) => {
  const { text, imageUrls = [], handle = null, platform = 'unknown' } = req.body;
  if (!text || text.trim().length < 10) return res.status(400).json({ error: 'text required' });

  const cacheKey = sha(text.slice(0, 600) + (handle || '') + String((imageUrls || []).length));
  const cached = store.getCache(cacheKey);
  if (cached) return res.json(cached);

  const figure = handle ? store.getFigure(handle) : null;

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

    store.setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

// Get figure (public)
app.get('/api/figures/:handle', (req, res) => {
  const fig = store.getFigure(req.params.handle);
  if (!fig) return res.status(404).json({ error: 'Not found' });
  res.json(fig);
});

// ── Admin routes ───────────────────────────────────────────────────────────────

app.get('/api/admin/figures', requireAdmin, adminLimit, (req, res) => {
  res.json(store.listFigures());
});

app.post('/api/admin/figures', requireAdmin, adminLimit, async (req, res) => {
  const { name, handles } = req.body;
  if (!name?.trim() || !handles?.length) return res.status(400).json({ error: 'name and handles required' });
  const primaryHandle = handles[0].replace(/^@/, '').toLowerCase();

  store.setFigure(primaryHandle, {
    handle: primaryHandle, name: name.trim(),
    role: null, jurisdiction: 'US',
    biography: {}, legal_proceedings: [], fact_check_discrepancies: [],
    financial_ties: [], mirror_triggers: [], mirror_note: null,
    research_status: 'researching',
  });

  res.json({ status: 'researching', handle: primaryHandle });
  setImmediate(() => runResearch(name.trim(), handles, primaryHandle));
});

app.post('/api/admin/figures/:handle/research', requireAdmin, adminLimit, (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  const fig = store.getFigure(h);
  if (!fig) return res.status(404).json({ error: 'Not found' });
  store.updateFigure(h, { research_status: 'researching' });
  res.json({ status: 'researching', handle: h });
  setImmediate(() => runResearch(fig.name, [h], h));
});

app.put('/api/admin/figures/:handle', requireAdmin, adminLimit, (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  const { name, role, biography, legal_proceedings, fact_check_discrepancies, financial_ties, mirror_triggers, mirror_note } = req.body;
  store.updateFigure(h, {
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
  res.json(store.getFigure(h));
});

app.delete('/api/admin/figures/:handle', requireAdmin, adminLimit, (req, res) => {
  store.deleteFigure(req.params.handle);
  res.json({ deleted: true });
});

app.get('/api/admin/figures/:handle/status', requireAdmin, adminLimit, (req, res) => {
  const fig = store.getFigure(req.params.handle);
  if (!fig) return res.status(404).json({ error: 'Not found' });
  res.json({ handle: fig.handle, name: fig.name, status: fig.research_status, updated_at: fig.updated_at });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Research runner ───────────────────────────────────────────────────────────
async function runResearch(name, handles, primaryHandle) {
  try {
    const data = await claudeResearch(name, handles);
    store.updateFigure(primaryHandle, {
      name:                     data.name                    || name,
      role:                     data.role                    || null,
      jurisdiction:             data.jurisdiction            || 'US',
      biography:                data.biography               || {},
      legal_proceedings:        data.legal_proceedings       || [],
      fact_check_discrepancies: data.fact_check_discrepancies || [],
      financial_ties:           data.financial_ties          || [],
      mirror_triggers:          data.mirror_triggers         || [],
      mirror_note:              data.mirror_note             || null,
      research_status: 'done',
    });
    console.log(`[research] ✓ ${name} (@${primaryHandle})`);
  } catch (err) {
    console.error(`[research] ✗ ${name}:`, err.message);
    store.updateFigure(primaryHandle, { research_status: 'error' });
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nGlassBox API  →  http://localhost:${PORT}`);
  console.log(`Admin         →  http://localhost:${PORT}/admin`);
  console.log(`Figures: ${Object.keys(store.figures).length}  |  Cards: ${CONTEXT_CARDS.length}\n`);
});
