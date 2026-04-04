# GlassBox

**Manipulation immunity across social media.**

GlassBox is a browser extension that injects into Twitter/X (with more platforms coming) to help users identify bias patterns, detect misinformation, and make more informed decisions about what they consume and share.

## Phase 1 Features (MVP)

| Feature | Status |
|---|---|
| Twitter/X content injection | ✅ |
| Domain credibility scoring | ✅ |
| Manipulation tactic detection | ✅ |
| Context cards (7 topics) | ✅ |
| Pre-post reflection modal | ✅ |
| Local pattern tracking (IndexedDB) | ✅ |
| Dashboard popup | ✅ |
| Settings panel | ✅ |

## Project Structure

```
glassbox/
├── manifest.json              Chrome Manifest V3
├── background/
│   ├── service-worker.js      Message router + alarms
│   ├── credibility-db.js      Domain credibility lookups
│   └── pattern-analyzer.js    Behavior pattern aggregation
├── content/
│   ├── injectors/
│   │   ├── common.js          Platform-agnostic annotation engine
│   │   └── twitter.js         Twitter/X DOM injector
│   ├── ui/
│   │   ├── styles.css         All GlassBox UI styles
│   │   ├── indicator.js       Credibility badges + manipulation indicators
│   │   ├── modal.js           Pre-post reflection modal
│   │   └── card.js            Context cards (expandable)
│   └── detectors/
│       ├── manipulation.js    Pattern-based manipulation detection
│       ├── toxicity.js        Toxicity signal detection
│       └── credibility.js     Post credibility via link analysis
├── popup/
│   ├── dashboard.html         Extension popup UI
│   ├── dashboard.js           Dashboard + settings logic
│   └── settings.js            Settings helpers
├── lib/
│   ├── storage.js             IndexedDB + Chrome Storage layer
│   └── utils.js               Shared utilities
└── data/
    ├── credibility-scores.json  25+ domain ratings
    ├── manipulation-patterns.json  11 tactic patterns
    └── context-cards.json       7 context card topics
```

## Installing in Chrome (Developer Mode)

1. Clone this repo
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `GlassBox` folder

## Detection Logic

### Credibility Scoring
- Maintains a database of 25+ news domains with scores from NewsGuard, MBFC, Ad Fontes Media
- Extracts links from posts, resolves domains, shows inline badges
- Color coded: green (≥7.5), amber (5–7.5), red (2.5–5), dark red (<2.5)

### Manipulation Detection (Phase 1: Pattern-based)
11 tactic categories detected via keyword + regex matching:
- Emotional Appeals, Fear-Mongering, False Dichotomy, Ad Hominem
- Appeal to Authority, Bandwagon, Slippery Slope, Dehumanization
- Cherry-Picked Data, Missing Context, Conspiracy Framing

### Context Cards
7 topic cards with timelines, irony highlights, empathy angles, and sources:
- Indigenous American history
- Climate change scientific consensus
- Immigration history and crime data
- Vaccine safety
- Election integrity
- LGBTQ+ medical consensus
- Systemic racism data

### Pre-Post Reflection
Intercepts Twitter's submit button (capture phase) when:
- Toxic or sensitive language detected
- High-level manipulation detected
- Content links to very low credibility source (<3/10)

## Privacy

- **All processing is local** — no post text is sent to external servers
- Pattern data stored in IndexedDB on your device
- Settings synced via `chrome.storage.sync` (Chrome's own encrypted storage)
- No advertising, no data selling, ever

## Roadmap

**Phase 2:**
- Facebook, Reddit, YouTube support
- Perspective API integration for toxicity
- Fact-check API integration (AP, PolitiFact)
- 50+ context card topics
- Pattern mirroring monthly reports
- Feed reranking algorithm

**Phase 3:**
- Mobile browser support (Firefox Android, Kiwi)
- Safari extension
- Community card contributions
- Pro tier with unlimited fact-checks
