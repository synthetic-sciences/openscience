# Source mechanism ledger

Pinned source revisions used for `meta-harness-v1` design:

| Source | Revision | Adopted mechanism |
|---|---|---|
| PrimeIntellect-ai/prime-agent | `0859d06a5da2c7642adb4130cdadf7e8aa445835` | Immutable base plus local-first versioned supplemental prompt/memory/skill/subagent state; evidence-backed refinement; atomic saves and rollback; serialized updates |
| InternScience/MLEvolve | `7d8403c899c40f01941c0429f1c4ef51e82ae41c` | Progressive graph search, exploration/exploitation control, stagnation-aware fusion, and success/failure memory |
| EvoScientist/EvoScientist | `0c21a01f6fdb4852ac26909c00fff50d098617b4` | Guarded skill proposals, read/write tiers, and implementation-versus-fundamental failure diagnosis |
| EvoScientist/EvoSkills | `2e474118106f86c29082a6466b995ba59236614c` | Confidence-tagged reusable skill memory |
| Agentic Harness Engineering | `8b2a55d97590363fe50c3cc6b5e833b020a4bb4c` | Full raw traces; trace-cited root cause and targeted fix; predicted task flips and risk tasks; falsification on the next iteration |
| Meta-Harness | `44b9942127847f7421db70d8c7e48407f09a3c70` | Updater/beneficiary separation, held-out task/model transfer, activation and adherence measurement, model-harness pair reporting |
| A-Evolve | `c9d4789f2be499589d543aa08e74d05d10d93177` | Continual harness refinement and evaluator-owned promotion checks |
| HarnessBench | `1025086a446653702b80cfb48babbeec35db6b2c` | Harness evaluation as an empirical object rather than prompt aesthetics |

OpenScience already supplied persistent runtime goals, heartbeats, compaction, subagents, adaptive graph search, Pareto/island search, reservations, evolution provenance, evaluator isolation, and sealed confirmation. Those mechanisms were integrated rather than duplicated.

Deliberately excluded:

- candidate-authored or summary-only evidence;
- hidden-model/task feedback during search;
- global self-modification before independent transfer qualification;
- diagnostics as benchmark fitness;
- prompt-only evaluation without activation/adherence measurement;
- mutable receipts or post-hoc prediction edits.
