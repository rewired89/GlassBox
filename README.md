# GlassBox

**AI-powered transparency and accountability for social media.**

GlassBox is a browser extension that places verified public records, fact-checks, and tone analysis directly inside your Twitter/X feed — right next to the tweets that need context. No searching. No tab-switching. No misinformation going unchallenged.

---

## What it does

When you browse Twitter/X, GlassBox silently analyzes every post you see and, where relevant, inserts one or more cards directly below the tweet:

### Public Record Card
For politicians and public figures tracked in the GlassBox database, a collapsible **Public Record** card appears showing:
- Verified legal proceedings (court cases, settlements, convictions)
- Documented contradictions between public claims and public record
- Financial ties and conflicts of interest
- Sex offender registry matches (NSOPW.gov)
- Criminal convictions
- Biographical context (immigration history, background relevant to their rhetoric)

### Fact-Check Banner
When a tweet contains a specific claim that contradicts overwhelming documented evidence, a fact-check banner appears inline showing:
- The exact claim made
- What verified sources show
- A link to the primary source

### Tone Score
Every analyzed post gets a **resonance score** showing the emotional tone:

| Score | Label | Meaning |
|-------|-------|---------|
| 70–100 | Empathetic | Constructive, respectful, fact-based |
| 50–69 | Neutral | Informational, balanced |
| 30–49 | Dismissive | Condescending or indifferent, opinion-driven |
| 0–29 | Hostile | Aggressive or dehumanizing |

Clicking the score expands a plain-English description. This helps users recognize *how* someone is talking — because manipulation uses tone as much as it uses false information. Saying something is your personal opinion is valid; the score just makes that visible.

---

## Why this exists

The goal is simple: **informed consent**.

When you read a tweet from a politician claiming "there's no inflation" or "crime is at a record high", you deserve to know in that moment — without searching — what the actual public record shows. Not to tell you what to think. To give you the information to think for yourself.

GlassBox is non-partisan. It applies the same standards to every person in the database regardless of political affiliation. A false claim is a false claim. A hostile tone is hostile regardless of which side it comes from.

Public Record cards are built from:
- Federal court records (CourtListener / PACER)
- National Sex Offender Public Website (NSOPW.gov)
- Claude AI research on publicly available information
- Wikipedia and official biography sources

---

## How to install

### Chrome / Edge / Brave
1. Download or clone this repository
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the `GlassBox` folder
5. Open the extension popup → Settings → enter the API URL:
   `https://glassbox-production-3db2.up.railway.app`
6. Open Twitter/X — cards will appear automatically on tracked figures

### Firefox
1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file inside the `GlassBox` folder

> Chrome Web Store and Firefox AMO submissions in progress.

---

## Admin dashboard

The admin dashboard lets you add public figures for tracking:

```
https://glassbox-production-3db2.up.railway.app/admin
```

Features:
- Add any person by name and social handles — AI research runs automatically
- **🏛️ Seed Politicians** — bulk-adds 30 US politicians in one click
- Re-search button refreshes outdated records
- All figures stored in PostgreSQL and shared across all extension users

---

## Architecture

```
Browser Extension (Chrome MV3 / Firefox)
  └── content/glassbox.js      Content script — injects cards into Twitter DOM
  └── popup/dashboard.html     Extension popup — stats + settings

Backend (Node.js + Express — Railway)
  └── POST /api/analyze        Analyzes post text, looks up author in DB
  └── GET  /api/figures/:h     Public figure lookup by any handle or alias
  └── POST /api/admin/figures  Add figure + trigger AI research
  └── POST /api/admin/seed     Bulk-import politicians list

Storage
  └── PostgreSQL (Railway)     Persistent figures + analysis cache
  └── JSON fallback            Local dev without a database

AI & Data Sources
  └── Claude (Anthropic)       Post analysis + public records research
  └── CourtListener / PACER    Federal court docket search
  └── NSOPW.gov                National sex offender registry
```

---

## Running locally

```bash
# Clone the repo
git clone https://github.com/rewired89/GlassBox.git
cd GlassBox

# Set up the backend
cd backend
npm install

# Create a .env file with:
# ANTHROPIC_API_KEY=sk-ant-...
# ADMIN_KEY=your-secret-key

npm run dev          # starts on http://localhost:3001

# Load the extension
# Open chrome://extensions → Enable Developer mode → Load unpacked → select GlassBox/
# In the popup → Settings → set API URL to http://localhost:3001
```

---

## Environment variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key — required for AI analysis |
| `ADMIN_KEY` | Secret key to protect the admin dashboard |
| `DATABASE_URL` | PostgreSQL URL (auto-injected by Railway PostgreSQL plugin) |
| `PORT` | Server port (auto-set by Railway) |

---

## Contributing

Pull requests are welcome. Priority areas:
- Expanding the database beyond US federal politicians
- Additional platforms: Threads, Bluesky, TikTok, YouTube comments
- More data sources for public records research
- Translations and internationalization

---

## Contact

Built by **Rewired89**.

Questions, feedback, or partnership inquiries: **nyxsystemsllc@gmail.com**

---

*GlassBox is a transparency tool, not a political tool. It reports what public records show. What you do with that information is your decision.*
