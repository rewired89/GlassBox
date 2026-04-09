/**
 * GlassBox API Server
 * ───────────────────────────────────────────────────────────────────────────────
 * Deployed backend powering the GlassBox browser extension.
 * Handles AI-driven post analysis (text + images), public figure research,
 * and the admin dashboard for managing accountability cards.
 *
 * Deploy to Railway: connect repo, set env vars, done.
 * Local dev: cp .env.example .env && npm install && npm run dev
 */

import express      from 'express';
import cors         from 'cors';
import rateLimit    from 'express-rate-limit';
import Anthropic    from '@anthropic-ai/sdk';
import Database     from 'better-sqlite3';
import crypto       from 'crypto';
import path         from 'path';
import fs           from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ─────────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3001;
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'glassbox-admin-change-me';
const DATA_DIR   = process.env.DATA_DIR   || path.join(__dirname, 'data');
const DB_PATH    = path.join(DATA_DIR, 'glassbox.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('[warn] ANTHROPIC_API_KEY not set — analysis endpoints will fail');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// ── Context cards (loaded from sibling data/ directory or backend/data/) ───────
let CONTEXT_CARDS = [];
const cardPaths = [
  path.join(__dirname, '..', 'data', 'context-cards.json'),
  path.join(__dirname, 'data', 'context-cards.json'),
];
for (const p of cardPaths) {
  if (fs.existsSync(p)) {
    try { CONTEXT_CARDS = JSON.parse(fs.readFileSync(p, 'utf8')).cards || []; break; }
    catch { /* skip */ }
  }
}

// ── Database ────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS figures (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    handle          TEXT UNIQUE NOT NULL COLLATE NOCASE,
    name            TEXT NOT NULL,
    role            TEXT,
    jurisdiction    TEXT DEFAULT 'US',
    biography       TEXT DEFAULT '{}',
    legal           TEXT DEFAULT '[]',
    fact_checks     TEXT DEFAULT '[]',
    financial_ties  TEXT DEFAULT '[]',
    mirror_triggers TEXT DEFAULT '[]',
    mirror_note     TEXT,
    research_status TEXT DEFAULT 'pending',
    raw_research    TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analysis_cache (
    hash       TEXT PRIMARY KEY,
    platform   TEXT,
    result     TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_figures_handle ON figures(handle);
`);

// ── Helpers ─────────────────────────────────────────────────────────────────────
const sha = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 16);

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.query.key;
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Invalid admin key' });
  next();
}

function rowToFigure(row) {
  if (!row) return null;
  return {
    id:                      row.id,
    handle:                  row.handle,
    name:                    row.name,
    role:                    row.role,
    jurisdiction:            row.jurisdiction,
    biography:               JSON.parse(row.biography  || '{}'),
    legal_proceedings:       JSON.parse(row.legal      || '[]'),
    fact_check_discrepancies:JSON.parse(row.fact_checks|| '[]'),
    financial_ties:          JSON.parse(row.financial_ties || '[]'),
    mirror_triggers:         JSON.parse(row.mirror_triggers || '[]'),
    mirror_note:             row.mirror_note,
    research_status:         row.research_status,
    updated_at:              row.updated_at,
  };
}

function findFigure(handle) {
  if (!handle) return null;
  const h = handle.replace(/^@/, '').toLowerCase();
  return rowToFigure(db.prepare('SELECT * FROM figures WHERE lower(handle) = ?').get(h));
}

// ── Claude: analyze a post ──────────────────────────────────────────────────────
async function claudeAnalyze(text, imageUrls = [], figure = null) {
  const figCtx = figure ? `
Author context: ${figure.name} (${figure.role || 'public figure'})
Legal record: ${figure.legal_proceedings?.length || 0} verified proceedings on file
Mirror note: ${figure.mirror_note || 'none'}` : '';

  // Build content array — images first (up to 3), then text prompt
  const content = [];

  for (const url of (imageUrls || []).slice(0, 3)) {
    // Only include https image URLs (MV3 CSP safe)
    if (/^https:\/\/.+\.(jpg|jpeg|png|gif|webp)/i.test(url)) {
      content.push({ type: 'image', source: { type: 'url', url } });
    }
  }

  content.push({
    type: 'text',
    text: `You are a non-partisan fact-checking AI for a media literacy browser extension. Analyze this social media post with the same standards regardless of political affiliation.
${figCtx}

POST TEXT:
"""${text.slice(0, 2000)}"""

${imageUrls?.length ? `Images are attached above. Describe any concerning visual content (dehumanizing imagery, manipulated photos, misleading visual framing).` : ''}

Return ONLY valid JSON — no markdown, no explanation:
{
  "flagged": boolean,
  "flag_reason": "specific factual reason why flagged, or null",
  "flag_categories": ["array from: misinformation | hate_speech | dehumanization | election_integrity | climate_denial | vaccine_misinformation | historical_denial | immigration_fearmongering | indigenous_rights_denial"],
  "resonance_score": 0-100,
  "resonance_label": "Empathetic|Neutral|Dismissive|Hostile",
  "resonance_affect": 0-100,
  "context_card_topic": "one of: mmiwg_indigenous_women | native_american_indigeneity | climate_change_consensus | immigration_history | vaccine_safety | election_integrity | lgbtq_history | systemic_racism | harmful_language_impact — or null",
  "fact_checks": [
    { "claim": "exact claim from post", "verdict": "what verified evidence shows", "source": "authoritative source name", "source_url": "URL or null" }
  ],
  "image_concerns": "string describing problematic imagery, or null"
}

SCORING GUIDE:
• 70–100 resonance: empathetic, constructive, hedged opinions ("I think/believe"), community focus
• 50–69: neutral, factual, no strong emotional charge
• 30–49: dismissive, generalizing, sarcastic
• 0–29: hostile, dehumanizing, absolutist, attack-focused

ONLY flag when:
1. A specific factual claim directly contradicts overwhelming documented evidence (courts, scientific consensus of 97%+, official government reports, or established historical record)
2. Language explicitly dehumanizes a group of people (compares to animals, vermin, disease, etc.)
3. Denies well-documented historical atrocities or genocide findings

Do NOT flag: opinions, policy disagreements, criticism of governments/leaders, satire if clearly labeled, emotional expression without false factual claims.`,
  });

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1200,
    messages: [{ role: 'user', content }],
  });

  const raw = resp.content[0].text.trim();
  try { return JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude returned non-JSON: ' + raw.slice(0, 200));
  }
}

// ── Claude: research a public figure ───────────────────────────────────────────
async function claudeResearch(name, handles) {
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a public records researcher for an accountability journalism tool.

Research: ${name} (handles: ${handles.map(h => '@' + h.replace(/^@/, '')).join(', ')})

Return ONLY valid JSON — no markdown:
{
  "name": "full legal name",
  "role": "current or most recent official position/title",
  "jurisdiction": "US|CA|GB|AU|IN|FR|DE|BR|etc",
  "biography": {
    "birth_place": "city, country",
    "birth_year": number or null,
    "is_immigrant": boolean,
    "parents_immigrant": boolean,
    "migration_note": "factual note about immigration background if relevant to public positions, or null",
    "source_url": "Wikipedia or official biographical URL"
  },
  "legal_proceedings": [
    {
      "case": "Case name and court",
      "type": "criminal|civil|administrative",
      "status": "convicted|settled|dismissed|ongoing",
      "date": "YYYY-MM-DD",
      "summary": "2-3 sentence factual summary of what happened and outcome",
      "source": "Court or source name",
      "source_url": "Official court record or reliable news URL"
    }
  ],
  "fact_check_discrepancies": [
    {
      "claim": "Specific public claim this person has made",
      "finding": "What verified evidence actually shows — factual, sourced",
      "source": "Authoritative source (court, official report, peer-reviewed study)",
      "source_url": "URL"
    }
  ],
  "financial_ties": [
    {
      "entity": "Company or organization name",
      "relationship": "Describe the financial relationship",
      "amount": "Dollar amount or description if known publicly",
      "relevance": "Why this matters to their public statements/positions",
      "source": "Source name (FEC, ProPublica, court filing, etc.)",
      "source_url": "URL"
    }
  ],
  "mirror_triggers": ["topic keywords from their posts that would make biographical contrast relevant, e.g.: immigration, climate, indigenous, welfare, crime"],
  "mirror_note": "1-2 sentence factual biographical contrast, format: 'Public records indicate [Name] [relevant biographical fact].' — only include if there is a genuine documented contrast. null if not applicable."
}

IMPORTANT RULES:
- Only include information you are highly confident is accurate
- For legal proceedings: only real cases with real case numbers or documented sources
- For fact checks: only claims they publicly made AND that are directly contradicted by documented evidence
- If uncertain about any field, use null or []
- mirror_note should only reference documented facts, not inferences`,
    }],
  });

  const raw = resp.content[0].text.trim();
  try { return JSON.parse(raw); }
  catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude returned non-JSON for research');
  }
}

// ── Express app ─────────────────────────────────────────────────────────────────
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting — 30 analysis requests/min per IP
const analysisLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit reached — try again in a minute' },
});

// Admin rate limiting — stricter
const adminLimit = rateLimit({ windowMs: 60_000, max: 60 });

// ── Public routes ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const figCount = db.prepare('SELECT COUNT(*) AS n FROM figures').get().n;
  res.json({ status: 'ok', version: '2.0.0', figures: figCount, cards: CONTEXT_CARDS.length });
});

// Main analysis endpoint — called by the extension for every post
app.post('/api/analyze', analysisLimit, async (req, res) => {
  const { text, imageUrls = [], handle = null, platform = 'unknown' } = req.body;
  if (!text || text.trim().length < 10) return res.status(400).json({ error: 'text required (min 10 chars)' });

  const cacheKey = sha(text.slice(0, 600) + (handle || '') + (imageUrls.length > 0 ? '1' : '0'));

  // Return cached result if fresh (< 2 hours)
  const cached = db.prepare(`
    SELECT result FROM analysis_cache
    WHERE hash = ? AND datetime(created_at) > datetime('now', '-2 hours')
  `).get(cacheKey);
  if (cached) return res.json(JSON.parse(cached.result));

  // Look up figure in DB
  const figure = findFigure(handle);

  try {
    const ai = await claudeAnalyze(text, imageUrls, figure);

    // Find matching context card
    const cardTopic = ai.context_card_topic;
    const contextCard = cardTopic
      ? CONTEXT_CARDS.find(c => c.id === cardTopic)?.card || null
      : null;

    const LABEL_COLOR = { Empathetic: '#22c55e', Neutral: '#9ca3af', Dismissive: '#f59e0b', Hostile: '#ef4444' };

    const result = {
      flagged:          ai.flagged            || false,
      flag_reason:      ai.flag_reason        || null,
      flag_categories:  ai.flag_categories    || [],
      resonance: {
        score:  ai.resonance_score  ?? 50,
        affect: ai.resonance_affect ?? 0,
        label:  ai.resonance_label  || 'Neutral',
        color:  LABEL_COLOR[ai.resonance_label] || '#9ca3af',
      },
      context_card:     contextCard,
      context_card_id:  cardTopic,
      fact_checks:      ai.fact_checks        || [],
      image_concerns:   ai.image_concerns     || null,
      figure: figure ? {
        name:                    figure.name,
        role:                    figure.role,
        handle:                  figure.handle,
        mirror_note:             figure.mirror_note,
        mirror_triggers:         figure.mirror_triggers,
        legal_proceedings:       figure.legal_proceedings,
        fact_check_discrepancies:figure.fact_check_discrepancies,
        financial_ties:          figure.financial_ties,
        biography:               figure.biography,
      } : null,
    };

    db.prepare('INSERT OR REPLACE INTO analysis_cache (hash, platform, result) VALUES (?, ?, ?)')
      .run(cacheKey, platform, JSON.stringify(result));

    res.json(result);
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: 'Analysis failed', detail: err.message });
  }
});

// Get a single figure by handle (public)
app.get('/api/figures/:handle', (req, res) => {
  const fig = findFigure(req.params.handle);
  if (!fig) return res.status(404).json({ error: 'Figure not found' });
  res.json(fig);
});

// ── Admin routes ─────────────────────────────────────────────────────────────────

// List all figures
app.get('/api/admin/figures', requireAdmin, adminLimit, (req, res) => {
  const rows = db.prepare('SELECT * FROM figures ORDER BY updated_at DESC').all();
  res.json(rows.map(rowToFigure));
});

// Add a new figure and start research
app.post('/api/admin/figures', requireAdmin, adminLimit, async (req, res) => {
  const { name, handles } = req.body;
  if (!name?.trim() || !handles?.length) {
    return res.status(400).json({ error: 'name (string) and handles (array) required' });
  }
  const primaryHandle = handles[0].replace(/^@/, '').toLowerCase();

  // Upsert with pending status
  db.prepare(`
    INSERT INTO figures (handle, name, research_status)
    VALUES (?, ?, 'researching')
    ON CONFLICT(handle) DO UPDATE SET name=excluded.name, research_status='researching', updated_at=datetime('now')
  `).run(primaryHandle, name.trim());

  res.json({ status: 'researching', handle: primaryHandle });

  // Run research in background (don't await)
  setImmediate(() => runResearch(name.trim(), handles, primaryHandle));
});

// Re-research an existing figure
app.post('/api/admin/figures/:handle/research', requireAdmin, adminLimit, (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  const row = db.prepare('SELECT * FROM figures WHERE lower(handle)=?').get(h);
  if (!row) return res.status(404).json({ error: 'Figure not found' });

  db.prepare(`UPDATE figures SET research_status='researching', updated_at=datetime('now') WHERE lower(handle)=?`).run(h);
  res.json({ status: 'researching', handle: h });

  setImmediate(() => runResearch(row.name, [h], h));
});

// Update figure data manually
app.put('/api/admin/figures/:handle', requireAdmin, adminLimit, (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  const { name, role, biography, legal_proceedings, fact_check_discrepancies, financial_ties, mirror_triggers, mirror_note } = req.body;

  db.prepare(`
    UPDATE figures SET
      name             = COALESCE(?, name),
      role             = COALESCE(?, role),
      biography        = COALESCE(?, biography),
      legal            = COALESCE(?, legal),
      fact_checks      = COALESCE(?, fact_checks),
      financial_ties   = COALESCE(?, financial_ties),
      mirror_triggers  = COALESCE(?, mirror_triggers),
      mirror_note      = COALESCE(?, mirror_note),
      research_status  = 'done',
      updated_at       = datetime('now')
    WHERE lower(handle) = ?
  `).run(
    name || null,
    role || null,
    biography        ? JSON.stringify(biography)         : null,
    legal_proceedings? JSON.stringify(legal_proceedings) : null,
    fact_check_discrepancies ? JSON.stringify(fact_check_discrepancies) : null,
    financial_ties   ? JSON.stringify(financial_ties)    : null,
    mirror_triggers  ? JSON.stringify(mirror_triggers)   : null,
    mirror_note !== undefined ? mirror_note : null,
    h,
  );

  const fig = findFigure(h);
  if (!fig) return res.status(404).json({ error: 'Figure not found' });
  res.json(fig);
});

// Delete a figure
app.delete('/api/admin/figures/:handle', requireAdmin, adminLimit, (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  db.prepare('DELETE FROM figures WHERE lower(handle) = ?').run(h);
  res.json({ deleted: true, handle: h });
});

// Get research status (poll from admin UI)
app.get('/api/admin/figures/:handle/status', requireAdmin, adminLimit, (req, res) => {
  const h = req.params.handle.replace(/^@/, '').toLowerCase();
  const row = db.prepare('SELECT handle, name, research_status, updated_at FROM figures WHERE lower(handle)=?').get(h);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ handle: row.handle, name: row.name, status: row.research_status, updated_at: row.updated_at });
});

// Admin dashboard
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Background research runner ──────────────────────────────────────────────────
async function runResearch(name, handles, primaryHandle) {
  try {
    const data = await claudeResearch(name, handles);
    db.prepare(`
      UPDATE figures SET
        name            = ?,
        role            = ?,
        jurisdiction    = ?,
        biography       = ?,
        legal           = ?,
        fact_checks     = ?,
        financial_ties  = ?,
        mirror_triggers = ?,
        mirror_note     = ?,
        raw_research    = ?,
        research_status = 'done',
        updated_at      = datetime('now')
      WHERE lower(handle) = ?
    `).run(
      data.name            || name,
      data.role            || null,
      data.jurisdiction    || 'US',
      JSON.stringify(data.biography              || {}),
      JSON.stringify(data.legal_proceedings      || []),
      JSON.stringify(data.fact_check_discrepancies || []),
      JSON.stringify(data.financial_ties         || []),
      JSON.stringify(data.mirror_triggers        || []),
      data.mirror_note     || null,
      JSON.stringify(data),
      primaryHandle,
    );
    console.log(`[research] ✓ ${name} (@${primaryHandle})`);
  } catch (err) {
    console.error(`[research] ✗ ${name} (@${primaryHandle}):`, err.message);
    db.prepare(`UPDATE figures SET research_status='error', updated_at=datetime('now') WHERE lower(handle)=?`)
      .run(primaryHandle);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nGlassBox API  →  http://localhost:${PORT}`);
  console.log(`Admin dashboard →  http://localhost:${PORT}/admin`);
  console.log(`Context cards loaded: ${CONTEXT_CARDS.length}`);
  console.log(`Figures in DB: ${db.prepare('SELECT COUNT(*) AS n FROM figures').get().n}\n`);
});
