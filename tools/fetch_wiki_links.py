"""Add localized Wikipedia article titles to data/events.json.

For every event's English article, looks up its interlanguage links and stores
them under "wikiLang", e.g. {"de": "Schlacht_bei_Marathon", ...}.

Usage:  python tools/fetch_wiki_links.py
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

LANGS = ["zh", "ja", "ko", "ru", "de", "fr", "es", "it", "pt", "tr", "ar"]
PATH = os.path.join(os.path.dirname(__file__), "..", "data", "events.json")
API = "https://en.wikipedia.org/w/api.php?"


def query(titles):
    """Langlinks for a batch of titles, following the API's continuation."""
    params = {"action": "query", "format": "json", "redirects": 1, "prop": "langlinks",
              "lllimit": "max", "titles": "|".join(titles)}
    merged = None
    while True:
        req = urllib.request.Request(API + urllib.parse.urlencode(params),
                                     headers={"User-Agent": "european-spatiotemporal-geography/1.0"})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    res = json.load(r)
                break
            except urllib.error.HTTPError as e:
                if e.code != 429 or attempt == 4:
                    raise
                time.sleep(5 * (attempt + 1))  # rate limited: back off
        time.sleep(1)
        if merged is None:
            merged = res
        else:
            for pid, page in res["query"]["pages"].items():
                merged["query"]["pages"][pid].setdefault("langlinks", []).extend(page.get("langlinks", []))
        if "continue" not in res:
            return merged
        params.update(res["continue"])


def main():
    with open(PATH, encoding="utf-8") as f:
        data = json.load(f)
    by_title = {urllib.parse.unquote(e["wiki"]).replace("_", " "): e for e in data["events"]}
    titles = list(by_title)
    for i in range(0, len(titles), 5):
        batch = titles[i:i + 5]
        res = query(batch)
        # map redirect/normalized targets back to the requested titles
        alias = {t: t for t in batch}
        for key in ("normalized", "redirects"):
            for m in res["query"].get(key, []):
                alias[m["to"]] = alias.get(m["from"], m["from"])
        for page in res["query"]["pages"].values():
            event = by_title.get(alias.get(page["title"], page["title"]))
            if not event:
                continue
            links = {ll["lang"]: ll["*"].replace(" ", "_") for ll in page.get("langlinks", []) if ll["lang"] in LANGS}
            event["wikiLang"] = dict(sorted(links.items()))
    missing = {lang: sum(lang not in e.get("wikiLang", {}) for e in data["events"]) for lang in LANGS}
    print("events without a localized article:", missing)
    with open(PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
