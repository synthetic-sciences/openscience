---
name: citations
description: Resolves, verifies and formats references, every citation confirmed against Crossref, OpenAlex, arXiv or PubMed before it enters the bibliography, BibTeX built from resolved metadata, and existing .bib files audited for fabricated or mismatched entries. Use when adding citations to a draft, building or repairing a .bib, checking a manuscript's references, or whenever a claim needs a source attached. Not for finding what to read (use literature-review).
summary: "Resolve every reference against Crossref/OpenAlex/arXiv/PubMed before it enters the .bib."
category: core
role: support
allowed-tools: [Read, Write, Edit, Bash, webfetch, research_search]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Citations

A citation is a claim that a specific document says a specific thing. Language models
produce plausible references that do not exist, and reviewers now check. The rule is
simple and absolute: nothing enters the bibliography that was not resolved from a live
record, and nothing is cited for a claim that was not read.

## Non-negotiables

1. **Resolve before you cite.** Every entry comes from a record fetched now: a DOI at
   Crossref, a work at OpenAlex, an arXiv id, a PMID. Author names, year, title, venue,
   pages and DOI are copied from that record, never recalled or completed from memory.
2. **Read before you attribute.** Cite a paper for a finding only after reading the passage
   (abstract at minimum; the result section for numbers). A title is not evidence of what a
   paper found.
3. **One canonical identifier per entry.** Prefer the DOI; arXiv id for preprints without
   one; PMID as a secondary field. The key is `firstauthorYEARkeyword` and is stable once
   used in the text.
4. **Prefer the published version** over the preprint when both exist, and say so if the
   text relied on the preprint's numbers.
5. **Never pad.** A claim needs the one or two sources that establish it, not five that
   mention the topic.
6. **Report what could not be resolved** instead of leaving a best guess in the file.

## Workflow

- [ ] Collect the claims that need sources, or the entries to audit.
- [ ] Resolve each to a record (`references/apis.md` has the exact requests).
- [ ] Read enough of each source to confirm it supports the claim as worded.
- [ ] Write the BibTeX from the record; run `scripts/validate_bib.py` on the file.
- [ ] Return the list of resolved, corrected and unresolved items.

**Resolving.** Search by title first: Crossref `works?query.bibliographic=<title>&rows=3`
or OpenAlex `works?search=<title>&per-page=3`; accept a hit only if the title matches
closely and the first author agrees. With a DOI in hand, fetch
`https://api.crossref.org/works/<doi>` for the authoritative metadata, or
`https://doi.org/<doi>` with `Accept: application/x-bibtex` for a ready entry to tidy. For
arXiv, `http://export.arxiv.org/api/query?id_list=<id>` returns title, authors and date;
check Crossref for a published version of the same title before citing the preprint.
For biomedical literature, PubMed E-utilities (`esearch` then `esummary`) give the PMID,
DOI and journal.

**Auditing an existing .bib.** For every entry: does the DOI resolve, and does the resolved
title match the entry's title? Do the authors and year agree? Is the venue the real one?
Mark each entry `verified`, `corrected` (write the fix), or `unresolved` (leave the entry,
flag it in the report). Duplicates under different keys are merged toward the key used in
the text.

**Formatting.** Use `@article`, `@inproceedings`, `@misc` (preprints, with `eprint`,
`archivePrefix = {arXiv}`, `primaryClass`), `@book`, `@techreport`. Protect capitals in
titles with braces only where needed (`{BERT}`, `{Transformer}`). Keep `doi` and `url`
fields; drop `abstract` and `keywords`. Sort by key. Let the venue's `.bst` or biblatex
style decide the appearance; do not hand-format.

## In-text use

- Cite where the claim is made, not at the end of the paragraph.
- Distinguish "X showed" (their result) from "see X" (background) from "following X"
  (method reused). The wording is part of the attribution.
- Numbers quoted from a source keep the source's units, precision and conditions; if the
  text converts them, it says so.
- When the same source appears under two names (preprint and published), cite one.

## Before you hand it over

- Every `\cite` key exists in the .bib; every .bib entry is cited or removed.
- `scripts/validate_bib.py <file>.bib` reports no unresolved DOIs and no title mismatches.
- The report to the user lists unresolved items plainly. A manuscript with three honest
  gaps is better than one with three fabrications.
