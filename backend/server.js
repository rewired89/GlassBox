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
  // Look up by primary handle OR any alias stored in data.all_handles
  async getFigure(handle) {
    const h = handle.toLowerCase();
    if (pool) {
      const r = await pool.query(
        `SELECT data FROM figures
         WHERE handle = $1
            OR data->'all_handles' ? $1`,
        [h]
      );
      return r.rows[0]?.data || null;
    }
    if (_json.figures[h]) return _json.figures[h];
    // scan aliases in JSON fallback
    return Object.values(_json.figures).find(f =>
      Array.isArray(f.all_handles) && f.all_handles.includes(h)
    ) || null;
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
    // Accept Twitter CDN (format= query param), Reddit, Imgur, and standard extension URLs
    const looksLikeImage =
      /^https:\/\/pbs\.twimg\.com\//.test(url) ||
      /^https:\/\/i\.redd\.it\//.test(url) ||
      /^https:\/\/preview\.redd\.it\//.test(url) ||
      /[?&]format=(jpg|jpeg|png|gif|webp)/i.test(url) ||
      /^https:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url);
    if (looksLikeImage) {
      content.push({ type: 'image', source: { type: 'url', url } });
    }
  }

  content.push({ type: 'text', text: `You are a non-partisan fact-checking AI for a media literacy browser extension. Apply the same standards regardless of political affiliation. Your job is to detect manipulation of rhetoric and power — not to police personal opinions or frustration.
${figCtx}

POST TEXT:
"""${text.slice(0, 2000)}"""

${(imageUrls || []).length ? 'Images attached above — note any concerning visual content.' : ''}

Return ONLY valid JSON — no markdown, no explanation:
{
  "flagged": boolean,
  "flag_reason": "specific factual reason, or null",
  "flag_categories": ["array from: misinformation|hate_speech|dehumanization|election_integrity|climate_denial|vaccine_misinformation|historical_denial|immigration_fearmongering|indigenous_rights_denial|false_moral_authority|ingroup_outgroup_bias|statistical_distortion|appeal_to_ignorance|gender_supremacy|subordination_rhetoric|pseudo_science|anecdotal_generalization|government_religious_nationalism"],
  "resonance_score": 0-100,
  "resonance_label": "Empathetic|Neutral|Dismissive|Hostile",
  "resonance_affect": 0-100,
  "context_card_topic": "one of: mmiwg_indigenous_women|native_american_indigeneity|climate_change_consensus|immigration_history|vaccine_safety|election_integrity|lgbtq_history|systemic_racism|harmful_language_impact — or null",
  "fact_checks": [{ "claim": "exact claim", "verdict": "what evidence shows", "source": "source name", "source_url": "url or null" }],
  "image_concerns": "description or null",
  "news_verification_score": null,
  "news_verification_label": null,
  "news_sources_checked": [],
  "manipulation_tactic": { "name": "string", "description": "string", "tactic_severity": 0-100, "book_title": "string", "book_author": "string", "mirror_test": "string — one question asking how the argument changes if roles were reversed", "evidence_integrity": "string or null — null if the claim has supporting evidence, otherwise: 'No peer-reviewed data or verified public record supports this claim.'" },
  "ai_generated": { "detected": false, "confidence": "none", "signals": [] }
}

Resonance scoring — use the FULL 0–100 range. Do NOT cluster scores. Be precise:
• 0–10:  Explicit dehumanization ("immigrants are vermin/disease/subhuman"), direct incitement, coordinated hate. This is the worst possible content.
• 11–29: Hostile — deliberate fear-mongering with false or misleading claims, content engineered to provoke tribal rage, personal attacks as the primary message.
• 30–49: Dismissive — condescending framing, intellectually dishonest rhetoric, manipulative dog-whistles, strong us-vs-them language without direct violence.
• 50–69: Neutral — factual or opinionated but not manipulative. Blunt disagreement or criticism is fine here.
• 70–100: Empathetic/constructive — respectful, good-faith, solution-oriented, fact-based even when critical or passionate.

CRITICAL — Government actors and institutional religious nationalism:
A government or law enforcement account (e.g. @DHSgov, @WhiteHouse, @StateDept, any official .gov handle) posting scripture, religious doctrine, or phrases that define national identity through religion (e.g. "One nation under God", "God's plan for America", "Christian nation") is NOT neutral. It is institutional religious nationalism — the use of state power to impose a religious framework on a pluralistic country. This violates the constitutional principle of separation of church and state and functions as False Moral Authority at the highest level of institutional power. Score these posts in the 20–38 range and flag as false_moral_authority + government_religious_nationalism + ingroup_outgroup_bias.

CRITICAL — Protect legitimate hypocrisy calling:
Calling out hypocrisy — pointing out that someone's actions contradict their own stated values — is legitimate accountability, NOT manipulation. Examples:
- "I don't understand how Christians can support someone who acts so un-Christian" → This is accountability. Score 52–65 (Neutral). Do NOT flag as hostile or ad hominem.
- "How can you call yourself pro-life and support policies that kill people?" → Accountability. Neutral range.
- "These people claim to love America but want to destroy democracy" → Depends on evidence. If grounded in documented actions, Neutral to Empathetic.
The key distinction: hypocrisy calling PUNCHES UP at contradictions in power. Manipulation PUNCHES DOWN at identity or existence. Frustration and bluntness are not manipulation — they are honest reactions to documented behavior.

CRITICAL — Differentiate weaponized religion from genuine faith:
Genuine religious expression: a private individual sharing a prayer, a scripture for personal comfort, a church posting about community events. Score these Neutral to Empathetic.
Weaponized religion: invoking God, scripture, or "Christian values" to justify exclusion, discriminatory policy, national ownership by one demographic, or to claim divine authorization for political positions. Score these 20–40 and flag false_moral_authority.
Key signals of weaponization: speaker holds institutional/political power, religion is used to define who belongs in the nation, scripture is deployed to silence opposition or justify harm to a group.

Calibration anchors — use these to calibrate, not cluster:
NOTE on display: the resonance_score you return is INVERTED for display. A score of 20 shows to the user as 80% (very bad). A score of 80 shows as 20% (mostly fine). So score BAD content LOW and GOOD content HIGH.

Government + religion examples (score low = displays as high/bad):
"@DHSgov: 'Trust in the Lord... One nation under God.'" → score 15 (displays as 85% — very bad: False Moral Authority + government_religious_nationalism)
"The Bible tells us to respect the law. That's why we enforce the border." (government official) → score 20 (displays as 80%)
"God chose America and God chose this president." (political figure) → score 10 (displays as 90%)

Hypocrisy calling examples (score mid = displays as mid/neutral):
"I will never understand how millions of Christians follow the most un-Christlike person imaginable." → score 55 (displays as 45% — frustration at hypocrisy, not manipulation)
"How can you say you love America and then try to destroy its institutions?" → score 58 (displays as 42%)

Genuine faith examples (score high = displays as low/fine):
"Praying for everyone affected by this tragedy. God bless." → score 82 (displays as 18% — good content)
"This scripture gives me strength today." → score 85 (displays as 15%)
"immigrants are an invasion of vermin" → 5
"[politician] is trying to make investigating fraud illegal" (false fearful claim) → 20
"This policy will destroy the country" (vague hyperbole, no evidence) → 27
"That idea is ridiculous" (dismissive, no facts) → 38
"I disagree strongly with this approach because..." → 57
"Here's the evidence for why this policy is harmful" → 76
"Thank you for sharing this — this is what matters" → 88

News verification guide (for news_verification_score / news_verification_label / news_sources_checked):
- ONLY populate these fields if the post tells a specific news story, references a real-world event or incident, or makes verifiable factual claims about something that happened.
- Leave all three as null / [] for pure opinions, jokes, rants, personal statements, or content with no checkable facts.
- Score 0–99 (never 100): 0=fully confirmed by multiple credible sources, 1–29=mostly verified with minor gaps, 30–69=partially verifiable, 70–98=mostly unverifiable or contradicted, 99=completely unverifiable (99 not 100 because a 1% chance remains that an obscure source exists).
- Label: "Verified" for 0–29, "Partially Verified" for 30–69, "Unverified, possibly fake" for 70–99.
- news_sources_checked: list the names of sources or databases you consulted or would consult to verify (e.g. "Reuters", "AP News", "PubMed", "Snopes").

Manipulation tactic guide (for manipulation_tactic):
- ONLY populate if one dominant rhetorical manipulation tactic is clearly central to the post — not incidental.
- Return null for constructive criticism, blunt-but-honest posts, posts defending documented victims of harm, or legitimate hypocrisy calling (pointing out contradictions between someone's stated values and their actions).
- tactic_severity: 0–100 measuring how deliberately and severely the tactic is deployed. High = obvious, intentional, high-impact manipulation. Low = mild or incidental. Use the full range:
  • 85–100: Deliberate institutional or political manipulation (government using religion, dehumanization by public figures, state-backed propaganda)
  • 65–84: Clear and intentional manipulation by a high-follower or media account
  • 40–64: Moderate — tactic is present but may be partially incidental or low-reach
  • 10–39: Mild — tactic is present but does not appear to be the primary intent
  Government Religious Nationalism by an official .gov or law enforcement account → severity 88–95
  Dehumanizing language by a high-reach political figure → severity 85–92
  Fear-mongering with verifiably false statistics → severity 75–85
- When detected, return: {"name":"<tactic>","description":"<1 sentence plain-English explanation of how it is used in THIS specific post>","book_title":"<book>","book_author":"<author>","mirror_test":"<one question: how would this argument change if the subject and target groups were reversed?>","evidence_integrity":"<null if evidence exists, otherwise: 'No peer-reviewed data or verified public record supports this claim.'>"}
- Use EXACTLY these tactic names and paired book recommendations:
  "Semantic Deflection" (argues about word choice or framing to avoid addressing the real issue) → "Thank You for Arguing" by Jay Heinrichs
  "Fear-Mongering" (exaggerates threats to provoke panic rather than inform) → "The True Believer" by Eric Hoffer
  "Emotional Manipulation" (exploits feelings as a substitute for evidence) → "Influence" by Robert Cialdini
  "Conspiracy Framing" (presents unverified speculation as hidden truth) → "Calling Bullshit" by Carl T. Bergstrom & Jevin D. West
  "Dehumanizing Language" (reduces people to sub-human categories to strip them of moral consideration) → "Less Than Human" by David Livingstone Smith
  "Ad Hominem" (attacks the person to avoid engaging with their argument) → "How to Win Every Argument" by Madsen Pirie
  "Missing Context" (omits facts that would change the audience's conclusion) → "Manufacturing Consent" by Noam Chomsky & Edward S. Herman
  "Bandwagon" (claims popularity as proof of truth) → "Extraordinary Popular Delusions" by Charles Mackay
  "False Dichotomy" (presents only two options when more exist) → "The Art of Thinking Clearly" by Rolf Dobelli
  "Cherry-Picked Data" (selects only evidence that supports the conclusion) → "Bad Science" by Ben Goldacre
  "Slippery Slope" (claims one step inevitably leads to extreme outcomes without evidence) → "How Minds Change" by David McRaney
  "False Moral Authority" (invokes divine command, sacred tradition, or ancestry to justify discrimination or exclusion) → "The Rape of the Mind" by Joost Meerloo
  "In-Group/Out-Group Bias" (frames a nation or community as belonging exclusively to one demographic while casting others as invaders or enemies) → "Thinking, Fast and Slow" by Daniel Kahneman
  "Statistical Distortion" (misrepresents numbers, crime rates, or demographic data in ways that contradict verified sources) → "How to Lie with Statistics" by Darrell Huff
  "Appeal to Ignorance" (uses the absence of disproof as evidence of truth — 'you can't prove it's wrong') → "Calling Bullshit" by Carl T. Bergstrom & Jevin D. West
  "Gender Supremacy Rhetoric" (frames one gender as inherently superior or entitled to the submission or service of another) → "Invisible Women" by Caroline Criado Perez
  "Pseudo-Science / False Appeal to Nature" (misuses evolutionary or biological framing to justify removing autonomy or rights from a group) → "Inferior" by Angela Saini
  "Anecdotal Generalization" (uses a single personal experience or opinion to make sweeping factual claims about an entire group's rights or character) → "Thinking, Fast and Slow" by Daniel Kahneman
  "Subordination Rhetoric" (argues for the removal of women's rights or autonomy as natural, divine, or socially beneficial) → "The Second Sex" by Simone de Beauvoir
  "Government Religious Nationalism" (a state institution or official uses scripture, religious doctrine, or divine framing to define national identity, justify policy, or claim divine authorization — violating the constitutional separation of church and state) → "The Rape of the Mind" by Joost Meerloo

AI-generated content detection (ai_generated field):
- Examine every image attached to this request for signs of AI generation.
- detected: true if any image appears AI-generated or digitally manipulated.
- confidence: "high" = clear AI artifacts; "medium" = likely AI; "low" = uncertain; "none" = natural photo or no images.
- signals: up to 3 specific observations (e.g. "anatomically impossible hand placement", "uniform noise-free skin texture consistent with diffusion models", "subject placed in implausible real-world scenario", "Midjourney/DALL-E watermark pattern", "lighting direction inconsistent with scene shadows", "public figure shown in fabricated context").
- If no images were provided, return detected:false, confidence:"none", signals:[].
- Return detected:false for clearly genuine photographs even if the scene looks staged.` });

  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content }],
  });
  const raw = resp.content[0].text.trim();
  try { return JSON.parse(raw); }
  catch { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('Non-JSON response'); }
}

// ── CourtListener: federal court records ──────────────────────────────────────
async function lookupCourtListener(name) {
  try {
    const q = encodeURIComponent(name);
    const r = await fetch(
      `https://www.courtlistener.com/api/rest/v3/search/?q=${q}&type=o&order_by=score+desc&stat_Precedential=on`,
      { headers: { 'User-Agent': 'GlassBox-AccountabilityTool/2.0' }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results || []).slice(0, 5).map(c => ({
      case:       c.caseName || c.case_name || '',
      court:      c.court    || '',
      date:       c.dateFiled || c.date_filed || '',
      status:     'documented',
      summary:    c.snippet  || '',
      source:     'CourtListener / PACER',
      source_url: c.absolute_url ? `https://www.courtlistener.com${c.absolute_url}` : null,
    })).filter(c => c.case);
  } catch { return []; }
}

// ── NSOPW: National Sex Offender Public Website ───────────────────────────────
async function lookupNSOPW(name) {
  try {
    const parts  = name.trim().split(/\s+/);
    const first  = parts[0]  || '';
    const last   = parts.slice(-1)[0] || '';
    const r = await fetch('https://www.nsopw.gov/api/Search/GetSearchResults', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'GlassBox-AccountabilityTool/2.0' },
      body:    JSON.stringify({ firstName: first, lastName: last, territories: ['all'] }),
      signal:  AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const hits = (d.results || []).slice(0, 3);
    if (!hits.length) return null;
    return {
      registered:   true,
      matches:      hits.map(h => ({
        name:        `${h.firstName || ''} ${h.lastName || ''}`.trim(),
        jurisdiction: h.territory || '',
        offense:     h.primaryOffense || h.offense || 'Registered sex offense',
        registry_url: h.url || null,
      })),
      source:       'NSOPW.gov (National Sex Offender Public Website)',
      source_url:   'https://www.nsopw.gov',
      disclaimer:   'Match based on name only — verify identity before drawing conclusions.',
    };
  } catch { return null; }
}

// ── Claude: research a person's public records ────────────────────────────────
async function claudeResearch(name, handles) {
  const resp = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 4096,
    messages: [{ role: 'user', content: `You are a public records researcher for a safety and accountability tool.

Research: ${name} (social handles: ${handles.map(h => '@' + h.replace(/^@/, '')).join(', ')})

Search for ALL of the following from public records only. Include findings for public figures AND private individuals if records exist.

Return ONLY valid JSON — no markdown:
{
  "name": "full legal name",
  "role": "public title or occupation if known, or null",
  "jurisdiction": "US|CA|GB|AU|etc or null",
  "biography": {
    "birth_place": "city, state/country or null",
    "birth_year": number or null,
    "is_immigrant": boolean,
    "parents_immigrant": boolean,
    "migration_note": "factual note if relevant, or null",
    "source_url": "Wikipedia or official bio URL or null"
  },
  "sex_offender_registry": {
    "registered": boolean,
    "jurisdiction": "state or null",
    "offense": "offense description or null",
    "conviction_date": "YYYY or null",
    "registry_url": "official registry URL or null"
  },
  "criminal_convictions": [{
    "offense": "exact offense",
    "severity": "felony|misdemeanor",
    "conviction_date": "YYYY-MM-DD or YYYY",
    "sentence": "sentence details",
    "jurisdiction": "county, state or federal",
    "case_number": "case number if known",
    "source": "court name",
    "source_url": "official court URL or news source"
  }],
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
    "relevance": "why relevant",
    "source": "source name",
    "source_url": "URL"
  }],
  "mirror_triggers": ["keywords where biographical contrast is relevant"],
  "mirror_note": "1-2 sentence factual note or null"
}

CRITICAL RULES:
- Only include information you are highly confident is accurate and from verifiable public records
- For sex offender registry: check nsopw.gov, state registries (megan's law, etc.)
- For criminal records: check court documents, news archives, official sources
- Use null or [] when no verifiable information found — never fabricate
- A private individual with a public criminal record should have that record included` }],
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

// Minimal Claude connectivity test — no auth required
app.get('/api/test-claude', async (req, res) => {
  try {
    const r = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 30,
      messages: [{ role: 'user', content: 'Say "ok" and nothing else.' }],
    });
    res.json({ ok: true, reply: r.content[0]?.text || '(empty)', model: 'claude-opus-4-5' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Debug endpoint — shows env var status without exposing values
app.get('/api/debug', (req, res) => {
  res.json({
    anthropic_key:  process.env.ANTHROPIC_API_KEY ? `set (${process.env.ANTHROPIC_API_KEY.slice(0,8)}…)` : 'MISSING',
    database_url:   process.env.DATABASE_URL      ? 'set' : 'not set (using JSON)',
    admin_key:      process.env.ADMIN_KEY          ? 'set' : 'using default',
    port:           PORT,
    node_version:   process.version,
    storage:        pool ? 'postgresql' : 'json-files',
  });
});

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
  const hasText = text && text.trim().length >= 10;

  // No text but we have a handle — return just the figure card, skip Claude
  if (!hasText) {
    if (!handle) return res.status(400).json({ error: 'text required' });
    const figure = await store.getFigure(handle);
    if (!figure) return res.status(400).json({ error: 'text required' });
    return res.json({
      flagged: false, flag_reason: null, flag_categories: [],
      resonance: { score: 50, affect: 0, label: 'Neutral', color: '#9ca3af' },
      context_card: null, context_card_id: null, fact_checks: [], image_concerns: null,
      figure: {
        name: figure.name, role: figure.role, handle: figure.handle,
        mirror_note: figure.mirror_note, mirror_triggers: figure.mirror_triggers,
        sex_offender_registry: figure.sex_offender_registry,
        criminal_convictions: figure.criminal_convictions,
        legal_proceedings: figure.legal_proceedings,
        fact_check_discrepancies: figure.fact_check_discrepancies,
        financial_ties: figure.financial_ties, biography: figure.biography,
      },
    });
  }

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
    const nvScore = ai.news_verification_score;
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
      news_verification: (nvScore !== null && nvScore !== undefined) ? {
        score:           nvScore,
        label:           ai.news_verification_label ||
                           (nvScore < 30 ? 'Verified' : nvScore < 70 ? 'Partially Verified' : 'Unverified, possibly fake'),
        sources_checked: ai.news_sources_checked || [],
      } : null,
      manipulation_tactic: ai.manipulation_tactic || null,
      ai_generated: (ai.ai_generated?.detected)
        ? { detected: true, confidence: ai.ai_generated.confidence || 'medium', signals: ai.ai_generated.signals || [] }
        : null,
      figure: figure ? {
        name:                     figure.name,
        role:                     figure.role,
        handle:                   figure.handle,
        mirror_note:              figure.mirror_note,
        mirror_triggers:          figure.mirror_triggers,
        sex_offender_registry:    figure.sex_offender_registry,
        criminal_convictions:     figure.criminal_convictions,
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
    handle: primaryHandle,
    all_handles: cleanHandles,   // all aliases — used for lookup
    name: name.trim(),
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

// Bulk-seed pre-defined politicians list
app.post('/api/admin/seed', requireAdmin, adminLimit, async (req, res) => {
  const listPath = path.join(__dirname, 'data', 'politicians.json');
  if (!fs.existsSync(listPath)) return res.status(404).json({ error: 'politicians.json not found' });
  const politicians = JSON.parse(fs.readFileSync(listPath, 'utf8'));
  const results = [];
  for (const p of politicians) {
    const cleanHandles = p.handles.map(h => h.replace(/^@/, '').trim().toLowerCase()).filter(Boolean);
    const primary = cleanHandles[0];
    if (!primary) continue;
    const existing = await store.getFigure(primary);
    if (existing) { results.push({ name: p.name, status: 'already_exists' }); continue; }
    await store.setFigure(primary, {
      handle: primary, all_handles: cleanHandles, name: p.name,
      role: null, jurisdiction: 'US',
      biography: {}, legal_proceedings: [], fact_check_discrepancies: [],
      financial_ties: [], mirror_triggers: [], mirror_note: null,
      research_status: 'researching',
    });
    setImmediate(() => runResearch(p.name, cleanHandles, primary));
    results.push({ name: p.name, handle: primary, status: 'queued' });
  }
  res.json({ total: politicians.length, results });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Research runner ───────────────────────────────────────────────────────────
async function runResearch(name, handles, primaryHandle) {
  try {
    // Run Claude research + public safety lookups in parallel
    const [data, courtRecords, nsopwResult] = await Promise.all([
      claudeResearch(name, handles),
      lookupCourtListener(name),
      lookupNSOPW(name),
    ]);

    // Merge CourtListener records into legal_proceedings (deduplicated by case name)
    const existingCases = new Set((data.legal_proceedings || []).map(p => p.case?.toLowerCase()));
    const mergedProceedings = [
      ...(data.legal_proceedings || []),
      ...courtRecords.filter(c => !existingCases.has(c.case?.toLowerCase())),
    ];

    await store.updateFigure(primaryHandle, {
      name:                     data.name                     || name,
      role:                     data.role                     || null,
      jurisdiction:             data.jurisdiction             || null,
      biography:                data.biography                || {},
      sex_offender_registry:    data.sex_offender_registry    || nsopwResult || null,
      criminal_convictions:     data.criminal_convictions     || [],
      legal_proceedings:        mergedProceedings,
      fact_check_discrepancies: data.fact_check_discrepancies || [],
      financial_ties:           data.financial_ties           || [],
      mirror_triggers:          data.mirror_triggers          || [],
      mirror_note:              data.mirror_note              || null,
      research_status: 'done',
    });
    console.log(`[research] ✓ ${name} (@${primaryHandle}) — legal:${mergedProceedings.length} court:${courtRecords.length} nsopw:${nsopwResult ? 'HIT' : 'none'}`);
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
