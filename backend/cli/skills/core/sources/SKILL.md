---
name: sources
description: Audits claims against their sources, each statement in a draft, report, answer or summary traced to the passage, table, dataset or run that supports it, and marked supported, partially supported, unsupported or contradicted, with a provenance table as the deliverable. Use for a sources audit, fact-check, "is this actually supported", verifying an AI-written summary, or before a manuscript goes out. For resolving reference metadata use citations; for judging methodology use peer-review.
summary: "Audit each claim against the passage that supports it; provenance table as the result."
category: core
role: workflow
allowed-tools: [Read, glob, grep, webfetch, research_search, experiments]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Sources audit

A sources audit answers one question for every claim: where exactly does this come from,
and does that place say this? It is the check that catches confident paraphrase drifting
from what the source said, numbers copied with the wrong units, and results attributed to
the wrong paper. The deliverable is a table, not a reassurance.

## Rules

1. **Atomize.** Split the text into claims small enough to be true or false on their own.
   "X improves accuracy by 4% on Y and generalizes to Z" is two claims.
2. **Locate, then read.** For each claim, find the exact supporting passage: a sentence,
   a table cell, a figure panel, a dataset field, a tracked run's metric. Read it in its
   context; a sentence taken from a limitations paragraph often says the opposite of the
   claim built on it.
3. **Grade against the wording.** Supported: the source says this, in this scope.
   Partially supported: the source says something narrower, weaker or conditional.
   Unsupported: no source found, or the source does not address it. Contradicted: the
   source says otherwise. Recall is never a source.
4. **Numbers are exact.** Value, units, precision, uncertainty and conditions must match.
   A rounded or unit-converted number is partially supported unless the text says it
   converted.
5. **Attribution is part of the claim.** A correct fact attributed to the wrong paper is
   contradicted, not supported.
6. **Report, do not repair.** The audit lists what it found; changing the text is a
   separate step the user asks for (paper-writing).

## Workflow

- [ ] Collect the claims (numbered) and the sources the text cites or relies on.
- [ ] For each claim, locate and read the supporting passage; fetch sources not at hand.
- [ ] Grade each claim; record the passage and location.
- [ ] Summarize: counts by grade, the claims that matter most, what to fix first.

**Locating.** Cited papers: fetch by DOI or arXiv id (requests in
`skills/core/citations/references/apis.md`) and read the relevant section. Project
results: open the output file or query the tracked run (`experiments compare`,
`experiments series`). Datasets: the field and record. Web sources: the page as of today,
with its date.

**Reading.** Quote the supporting text verbatim (a sentence, or a table cell with its row
and column headers). Note the scope: dataset, population, conditions, time. Compare scope
to the claim's scope.

**Grading edge cases.** A claim supported by a preprint is supported, marked "preprint". A
claim resting on a source that itself cites another source is partially supported until
the original is read. A widely known fact with no source is unsupported in an audit; say
so and let the user decide whether it needs one.

## Deliverable

```markdown
| # | Claim | Grade | Source and location | Supporting passage | Note |
| 1 | ... | supported | Smith 2023, Table 2 row 3 | "..." | |
| 2 | ... | partially | ..., §4.1 | "..." | source reports 3.9%, text says 4% |
| 3 | ... | unsupported | none found | | searched OpenAlex, arXiv |

Supported 14 · Partially 3 · Unsupported 2 · Contradicted 1
Fix first: #7 (contradicted, central claim), #3, #9.
```

## Before you hand it over

- Every claim has a grade and, for supported and partial grades, a verbatim passage with a
  location.
- Unsupported claims list where you looked.
- The summary names the claims whose grade changes the document's conclusion.
