#!/usr/bin/env python3
"""
GlassBox Entity Seeder
======================
Developer tool — run this script locally to generate or update
data/public-figures.json entity_index entries from Wikipedia's
free REST API and Wikidata.

Requires: pip install requests

Usage:
    python scripts/seed-entities.py                     # update all
    python scripts/seed-entities.py --handle elonmusk   # update one
    python scripts/seed-entities.py --dry-run            # preview only

Output: prints JSON entries you can copy into data/public-figures.json
        under the "entity_index" array.

Note: Wikipedia API is free, CORS-enabled, no API key required.
      Wikidata API is also free and returns structured birth data.
"""

import json
import sys
import time
import argparse
import requests
from urllib.parse import quote

WIKIPEDIA_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{}"
WIKIDATA_SPARQL   = "https://query.wikidata.org/sparql"
HEADERS           = {"User-Agent": "GlassBox/1.0 (https://github.com/rewired89/glassbox; accountability-research)"}

# ── Handle → Wikipedia title mapping ────────────────────────────────────────
HANDLE_TO_WIKI = {
    "elonmusk":         "Elon Musk",
    "barackobama":      "Barack Obama",
    "realdonaldtrump":  "Donald Trump",
    "joebiden":         "Joe Biden",
    "kamalaharris":     "Kamala Harris",
    "aoc":              "Alexandria Ocasio-Cortez",
    "berniesanders":    "Bernie Sanders",
    "hillaryclinton":   "Hillary Clinton",
    "tedcruz":          "Ted Cruz",
    "marcorubioff":     "Marco Rubio",
    "nikkihaley":       "Nikki Haley",
    "vivekgramaswamy":  "Vivek Ramaswamy",
    "repmtg":           "Marjorie Taylor Greene",
    "mattgaetz":        "Matt Gaetz",
    "benshapiro":       "Ben Shapiro",
    "jordanbpeterson":  "Jordan Peterson",
    "tuckercarlson":    "Tucker Carlson",
    "joerogan":         "Joe Rogan",
    "jeffbezos":        "Jeff Bezos",
    "billgates":        "Bill Gates",
    "sundarpichai":     "Sundar Pichai",
    "tim_cook":         "Tim Cook",
    "markzuckerberg":   "Mark Zuckerberg",
    "justintrudeau":    "Justin Trudeau",
    "ppollievre":       "Pierre Poilievre",
    "jagmeetsingh":     "Jagmeet Singh",
    "jkenney":          "Jason Kenney",
    "narendramodi":     "Narendra Modi",
    "borisjohnson":     "Boris Johnson",
    "rishisunak":       "Rishi Sunak",
    "nigel_farage":     "Nigel Farage",
    "marine_lepen":     "Marine Le Pen",
    "ericzemmour":      "Éric Zemmour",
    "geertwilders":     "Geert Wilders",
    "jaibolsonaro":     "Jair Bolsonaro",
    "netanyahu":        "Benjamin Netanyahu",
    "cobratate":        "Andrew Tate",
    "gretathunberg":    "Greta Thunberg",
    "randpaul":         "Rand Paul",
    "stevebannon":      "Steve Bannon",
    "candaceowens":     "Candace Owens",
    "repjimjordan":     "Jim Jordan",
    "senatedems":       None,   # institutional, skip
    "seanhannity":      "Sean Hannity",
    "ingrahamangle":    "Laura Ingraham",
    "dannybongino":     "Dan Bongino",
    "rogerjstonejr":    "Roger Stone",
    "genflynn":         "Michael Flynn",
    "maximebernier":    "Maxime Bernier",
    "thegwenbery":      None,
}

def fetch_wikipedia_summary(title):
    """Fetch page summary from Wikipedia REST API."""
    try:
        url = WIKIPEDIA_SUMMARY.format(quote(title))
        r = requests.get(url, headers=HEADERS, timeout=10)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        print(f"  ⚠ Wikipedia error for '{title}': {e}", file=sys.stderr)
        return None

def parse_birth_info(summary):
    """Extract birth info from Wikipedia summary description."""
    desc = summary.get("description", "")
    extract = summary.get("extract", "")
    return {
        "wikipedia_description": desc,
        "extract_snippet": extract[:300] + "..." if len(extract) > 300 else extract,
        "wikipedia_url": summary.get("content_urls", {}).get("desktop", {}).get("page", ""),
    }

def generate_entry(handle, wiki_title):
    """Fetch Wikipedia data and generate a schema entry skeleton."""
    if not wiki_title:
        return None

    print(f"  Fetching: {wiki_title} (@{handle})", file=sys.stderr)
    summary = fetch_wikipedia_summary(wiki_title)
    if not summary:
        return None

    info = parse_birth_info(summary)

    entry = {
        "id": handle.lower().replace(" ", "_"),
        "name": summary.get("title", wiki_title),
        "handles": [handle],
        "role": info["wikipedia_description"] or "Public figure",
        "jurisdiction": "US",  # TODO: update manually
        "biography": {
            "_note": "Auto-generated skeleton — verify and complete manually",
            "birth_place": "TODO — see Wikipedia",
            "birth_year": None,
            "is_immigrant": False,
            "parents_immigrant": False,
            "migration_note": "TODO — verify from Wikipedia and official sources",
            "source_url": info["wikipedia_url"],
        },
        "mirror_triggers": [],
        "mirror_note": "TODO — write factual biographical context sentence",
        "_wikipedia_extract": info["extract_snippet"],
    }
    return entry

def main():
    parser = argparse.ArgumentParser(description="GlassBox Entity Seeder")
    parser.add_argument("--handle", help="Seed a single handle only")
    parser.add_argument("--dry-run", action="store_true", help="Print without writing")
    args = parser.parse_args()

    targets = {}
    if args.handle:
        h = args.handle.lower().lstrip("@")
        if h not in HANDLE_TO_WIKI:
            print(f"Unknown handle: {h}. Add it to HANDLE_TO_WIKI first.", file=sys.stderr)
            sys.exit(1)
        targets = {h: HANDLE_TO_WIKI[h]}
    else:
        targets = HANDLE_TO_WIKI

    results = []
    for handle, wiki_title in targets.items():
        if not wiki_title:
            print(f"  Skipping @{handle} (no Wikipedia title configured)", file=sys.stderr)
            continue
        entry = generate_entry(handle, wiki_title)
        if entry:
            results.append(entry)
        time.sleep(0.5)  # be polite to Wikipedia API

    print("\n// ── Generated entity_index entries ──────────────────────────")
    print("// Copy these into data/public-figures.json → entity_index array")
    print("// Then manually fill in: birth_place, birth_year, is_immigrant,")
    print("//   migration_note, mirror_triggers, mirror_note")
    print()
    print(json.dumps(results, indent=2, ensure_ascii=False))
    print(f"\n// Generated {len(results)} entries", file=sys.stderr)

if __name__ == "__main__":
    main()
