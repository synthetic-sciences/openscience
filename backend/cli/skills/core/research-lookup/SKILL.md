---
name: research-lookup
description: Answers a focused factual or technical question from current sources with links, a definition, a number, a method's origin, a library's behavior, what a specific paper found, using research_search, webfetch and the scholarly APIs, and knowing when the question is really a literature review. Use for quick grounded lookups during research or writing. Not for surveying a topic (use literature-review) or for verifying a manuscript's citations (use citations).
summary: "One focused question answered from a fetched source with links; not a survey."
category: core
role: support
allowed-tools: [Read, webfetch, research_search]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Research lookup

A lookup answers one question with the source that answers it. The failure modes are
answering from memory with a confident tone, and turning a two-minute question into a
survey. Both are avoided by deciding what would settle the question before searching.

## Rules

1. **Decide the settling evidence first.** A definition needs the defining source; a
   number needs the table it came from; "does library X do Y" needs the documentation or
   the code; "what did paper P find" needs paper P.
2. **Search where the answer lives.** Scholarly claims: OpenAlex, arXiv, Crossref, PubMed
   (exact requests in `skills/core/citations/references/apis.md`). Software: the project's
   docs or repository. Current events, prices, availability: research_search. Do not use a
   general web search for a scholarly claim when the paper itself is one request away.
3. **Read the source, not the snippet.** Fetch the page or abstract and quote the sentence
   or number that answers the question, with its conditions.
4. **Two sources when the answer is contested or numeric.** Agreement settles it; a
   disagreement is reported as one.
5. **Stop at the answer.** If the question turns out to need a ranked reading of the field,
   say so and load literature-review instead of expanding this loop.
6. **Never present recall as lookup.** If nothing was fetched, the answer says it comes from
   background knowledge and how confident that is.

## Workflow

1. Restate the question in one line and name the evidence that would settle it.
2. Make one focused query per source (at most two sources); fetch the best hit.
3. Extract the answer with its exact wording, number, units, date and conditions.
4. Answer in one to three sentences, then the source links. Add the caveat if the source
   is a preprint, a blog, a vendor page, or older than the question implies.

## Patterns

- **Definition or origin**: search the term with "introduced" or the original authors'
  names; cite the first paper, not a survey that mentions it.
- **A number from a paper**: fetch the paper, find the table, report value ± uncertainty,
  setting, and dataset. Say which table.
- **Library or API behavior**: read the current documentation page; note the version.
  A changelog entry beats a Stack Overflow answer.
- **"Is there work on X"**: one OpenAlex search with the user's phrasing and a date filter;
  report the top three with links, and offer a literature review if depth is wanted.
- **Model, dataset or benchmark facts**: the model card, dataset card or benchmark paper;
  not a leaderboard screenshot.

## Before you hand it over

- The answer names its source and the source was fetched in this turn.
- Numbers carry units, uncertainty and conditions.
- Anything not found is reported as not found in the sources tried, not as absent.
