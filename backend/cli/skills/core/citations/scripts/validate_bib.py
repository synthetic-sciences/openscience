#!/usr/bin/env python3
"""Audit a BibTeX file against Crossref.

    python validate_bib.py references.bib [--mailto you@example.org] [--offline]

For every entry: required fields present, DOI resolves, and the resolved title matches the
entry's title. Prints one line per entry (verified / corrected / unresolved / offline) and
exits non-zero when any entry is unresolved. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request

REQUIRED = {
    "article": ["author", "title", "journal", "year"],
    "inproceedings": ["author", "title", "booktitle", "year"],
    "book": ["author", "title", "publisher", "year"],
    "misc": ["author", "title", "year"],
    "techreport": ["author", "title", "institution", "year"],
    "phdthesis": ["author", "title", "school", "year"],
}

ENTRY = re.compile(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", re.MULTILINE)


def parse(text: str):
    """Yield (type, key, fields) for each entry. Brace-balanced field parsing."""
    for match in ENTRY.finditer(text):
        kind, key = match.group(1).lower(), match.group(2)
        depth, i = 1, match.end()
        start = i
        while i < len(text) and depth:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        body = text[start : i - 1]
        fields = {}
        for field in re.finditer(r"(\w+)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|\"[^\"]*\"|[^,\n]+)", body):
            value = field.group(2).strip().strip("{}\"").strip()
            fields[field.group(1).lower()] = value
        yield kind, key, fields


def normalize(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower().replace("{", "").replace("}", "")).strip()


def similar(a: str, b: str) -> float:
    ta, tb = set(normalize(a).split()), set(normalize(b).split())
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def crossref(doi: str, mailto: str | None):
    url = f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='')}"
    if mailto:
        url += f"?mailto={urllib.parse.quote(mailto)}"
    request = urllib.request.Request(url, headers={"User-Agent": "openscience-citations/1.0"})
    for delay in (0, 1.0, 3.0):
        if delay:
            time.sleep(delay)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read())["message"]
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            if error.code != 429:
                raise
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("bib")
    parser.add_argument("--mailto", default=None)
    parser.add_argument("--offline", action="store_true", help="check fields only; skip Crossref")
    args = parser.parse_args()
    text = open(args.bib, encoding="utf-8").read()
    unresolved = 0
    seen: dict[str, str] = {}
    for kind, key, fields in parse(text):
        problems = [field for field in REQUIRED.get(kind, ["title", "year"]) if field not in fields]
        title = fields.get("title", "")
        if normalize(title) in seen:
            problems.append(f"duplicate of {seen[normalize(title)]}")
        else:
            seen[normalize(title)] = key
        doi = fields.get("doi", "").replace("https://doi.org/", "").strip()
        status = "verified"
        note = ""
        if args.offline or not doi:
            status = "offline" if args.offline else "unresolved"
            if not doi and not args.offline:
                note = "no DOI; resolve one or cite as @misc with eprint"
        else:
            record = crossref(doi, args.mailto)
            if record is None:
                status, note = "unresolved", "DOI does not resolve at Crossref"
            else:
                resolved = (record.get("title") or [""])[0]
                score = similar(title, resolved)
                year = str((record.get("issued", {}).get("date-parts") or [[""]])[0][0])
                if score < 0.6:
                    status, note = "unresolved", f"title mismatch: Crossref has '{resolved[:80]}'"
                elif fields.get("year") and year and fields["year"].strip() != year:
                    status, note = "corrected", f"year {fields['year']} -> {year}"
        if problems:
            note = (note + "; " if note else "") + "missing " + ", ".join(problems)
            if status == "verified":
                status = "corrected"
        if status == "unresolved":
            unresolved += 1
        print(f"{status:10s} {key:32s} {note}")
    print(f"\n{unresolved} unresolved")
    return 1 if unresolved else 0


if __name__ == "__main__":
    sys.exit(main())
