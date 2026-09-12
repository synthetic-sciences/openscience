---
name: brainstorming
description: Generates and selects research directions, mapping what is known and what is open, producing many candidate ideas by named moves (gap, transfer, inversion, constraint change, scale, failure analysis), then ranking them by tractability and value and committing to a shortlist. Use for open-ended ideation, "what should I work on", finding research gaps, exploring interdisciplinary connections, or choosing among directions. For turning a chosen direction into testable statements use hypotheses.
summary: "Map what is known, generate many directions by named moves, shortlist three."
category: core
role: workflow
allowed-tools: [Read, glob, grep, webfetch, research_search]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
  adapted-from: K-Dense scientific-brainstorming and scientific-problem-selection (MIT)
---

# Brainstorming

Good research ideas are not found by asking for good ideas. They come from a clear map of
what is known, a deliberate set of moves that produce many candidates, and a cold ranking
that throws most of them away. Generation and selection are separate steps; mixing them
kills the unusual candidates first.

## Rules

1. **Map before you generate.** Ten minutes on what is established, what is contested and
   what is assumed produces better candidates than an hour of free association. Use the
   user's notes and, when the field is unfamiliar, one research-lookup or a shallow
   literature-review round.
2. **Generate wide, by named moves.** Aim for fifteen to thirty candidates across the moves
   below. Write each as one line: the change and the outcome it would show. Do not judge
   while generating.
3. **Rank cold.** Score each candidate on value if it works, probability it works,
   cost to find out, and whether the user can do it with what they have. Prefer the
   candidate that is cheap to test and informative either way.
4. **Commit to a shortlist of three**, each with the first experiment that would test it
   and the result that would kill it.
5. **Say what is already done.** A candidate that exists in the literature is a lead to
   read, not an idea to pursue; mark it.

## Moves

| Move | Question that produces candidates |
| --- | --- |
| Gap | What does every paper assume, measure or exclude without justification? |
| Transfer | Which method from an adjacent field has never been applied here, and why not? |
| Inversion | What if the accepted direction of the effect, or the usual objective, is reversed? |
| Constraint | What changes under a tenth of the data, compute, labels, or time? Under ten times? |
| Failure | Where does the best method fail, and what is common to those cases? |
| Measurement | Is the standard metric measuring the thing everyone claims? What would? |
| Composition | Which two known results, combined, predict something neither does alone? |
| Mechanism | The effect is established; what is the mechanism, and what would distinguish candidates? |
| Simplification | What is the simplest baseline nobody reports, and would it match? |

`references/methods.md` expands these into structured exercises (SCAMPER, morphological
analysis, assumption reversal, analogical transfer) for a longer session.

## Workflow

- [ ] Map: established / contested / assumed / open, in a short table with sources.
- [ ] Generate: fifteen to thirty one-line candidates tagged by move.
- [ ] Filter: remove duplicates, the already-published, the untestable.
- [ ] Rank: value × probability ÷ cost, plus feasibility with the user's resources.
- [ ] Shortlist three with first experiment and kill criterion; hand to hypotheses.

## Selection criteria

- **Value**: who changes what they do if this is true? A result nobody would act on is low
  value however elegant.
- **Probability**: is there a mechanism or prior evidence that makes it plausible, or is it
  a hope?
- **Cost**: the cheapest experiment that would move the probability substantially; hours
  versus months.
- **Informativeness**: does a negative result teach something? Prefer questions where
  both answers matter.
- **Fit**: the user's data, compute, skills and deadline. A perfect idea for someone else
  is not on the shortlist.

## Deliverable

```markdown
## Map
| Established | Contested | Assumed | Open |

## Candidates (by move)
1. [gap] ...   2. [transfer] ...   ...

## Shortlist
1. <idea>. First experiment: <...>. Killed if: <...>. Value / probability / cost: <...>.
2. ...
3. ...

## Already done (read these)
- <candidate> → <paper, link>
```

## Before you hand it over

- The map cites its sources or says it comes from the user's notes.
- Candidates span at least four moves; none is a restatement of another.
- Each shortlisted idea has a concrete first experiment and a kill criterion.
