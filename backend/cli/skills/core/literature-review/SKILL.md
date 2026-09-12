---
name: literature-review
description: Finds, ranks and reads the literature on a question, the retrieval loop the lead runs itself over OpenAlex, arXiv, Crossref, PubMed and bioRxiv with a fixed budget, deduplication, ranking by topical fit, reading of the load-bearing papers and claim-level links, for related-work sections, prior-art checks, surveys and systematic reviews. Use for "find papers", "what is known about", related work, or a review; escalate to PRISMA screening only when a systematic review is requested. For one quick fact or definition use research-lookup.
summary: "Find, rank and read the literature on a question; related work, prior art, surveys."
category: core
role: workflow
allowed-tools: [Read, Write, webfetch, research_search, query_pubmed]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  adapted-from: alphaXiv OpenResearch orx-lit-review (MIT); K-Dense literature-review (MIT)
---

# Literature review

You are the retrieval ranker. Run the searches, look at every candidate, decide what is
worth reading, and read it before it becomes a claim. Never hand the loop to a worker: the
ranking is the judgement, and a worker without the conversation ranks for a different
question.

## Non-negotiables

1. **One window, one priority, fixed before the first query.** Recency, historical or
   default; a date bound only if the question has one. Never widen the window mid-loop to
   find "the famous paper" the user excluded.
2. **Budget by difficulty.** Rate the question 1–10. Difficulty 1–3 gets the initial round
   only; 4–7 gets one follow-up round; 8–10 gets two. A round targets one concrete gap
   (an acronym, a method, a benchmark, a venue), never a rephrasing.
3. **Deduplicate by identifier**, then by DOI or arXiv id, then by normalized title. Prefer
   the published version's record; note when the arXiv version is the one read.
4. **Rank by topical fit.** The APIs already blend recency and citations into their order;
   do not apply those preferences a second time, and never compare citation counts across
   sources.
5. **Read before you claim.** A candidate list may link titles; a finding attributed to a
   paper requires having read at least its abstract, and its results section for a number.
   Put the source link right after the sentence it supports.
6. **Stop when coverage is sufficient.** Five to fifteen strong candidates beat forty
   padded ones. The budget is a cap, not a target.

## Workflow

- [ ] Frame: the question in the user's terms, the window, the priority, the difficulty.
- [ ] Initial round across the sources that fit the field.
- [ ] Deduplicate, rank, and decide whether a follow-up round is warranted.
- [ ] Read the 3–5 load-bearing papers (more only if asked).
- [ ] Write the synthesis with claim-level links; list what was excluded and why.

**Sources.** Exact requests are in `skills/core/citations/references/apis.md`.

| Field | Start with | Add |
| --- | --- | --- |
| ML, CS, math, physics | arXiv API (title and abstract terms), OpenAlex search | Semantic Scholar for abstracts and citation chasing |
| Biology, medicine | PubMed E-utilities (`query_pubmed` when available), OpenAlex | bioRxiv/medRxiv through OpenAlex source filters |
| Any journal-heavy field | OpenAlex, Crossref | research_search for grey literature and reports |

Run the initial calls concurrently. Keyword terms are the user's words and terms observed in
results; never invent an acronym expansion. If the query mixes prose with an acronym, run
one extra call on the acronym alone in the same round.

**Ranking.** Inspect title, abstract, venue and date for every candidate. Keep what answers
the question; drop what shares only vocabulary. Within a source the order already carries
the requested priority; reorder for topical fit only. Note candidates with code or data.

**Follow-up rounds.** One round per concrete gap: a method the results keep citing, a
benchmark named but not covered, the seminal paper an abstract points at. Use the source
that fits the gap (arXiv keyword for exact terms, OpenAlex for cross-disciplinary reach,
`referenced_works` and `cited_by` on OpenAlex for citation chasing). Re-evaluate after
each round and stop as soon as coverage holds.

**Reading.** Fetch the open-access text (OpenAlex `oa_url`, Unpaywall, arXiv) for the
3–5 papers that carry the synthesis. Extract: the claim, the setup that produced it, the
number with its uncertainty and conditions, the stated limitations. Do not summarize from
snippets.

**Synthesis.** Organize by idea, not by paper: what is established, what is contested, what
is missing. Each substantive sentence ends with its source link (`https://doi.org/<doi>`
or `https://arxiv.org/abs/<id>`). Distinguish "X showed" from "X argued" from "X reported
in a preprint". Close with the gap the user's work addresses, if that was the purpose.

## Modes

- **Discovery** ("find papers", "what should I read"): the ranked list with one line each on
  why it matters and its link. Stop there; depth is not requested.
- **Related work**: the synthesis above, shaped as prose for the manuscript, with the
  positioning sentence for the user's contribution; the citations skill writes the `.bib`.
- **Systematic or scoping review** (only when asked): PRISMA-style protocol first
  (question, databases, strings, inclusion and exclusion criteria), a screening log with
  counts at each stage, an evidence table, then the synthesis. `references/database-strategies.md`
  and `references/search-strategies.md` carry the database-specific syntax and strategy
  patterns.

## Before you hand it over

- Every attributed finding was read, not inferred from a title or snippet.
- Every paper linked by DOI or arXiv id; preprints marked as such.
- The window and priority stated; excluded well-known work explained by the window.
- Coverage claims are modest: "no paper found in these sources under this window" rather
  than "no work exists".
