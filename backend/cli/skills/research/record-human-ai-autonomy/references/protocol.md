# Human-AI autonomy protocol

The three output levels follow the contribution axis proposed in Google
DeepMind's Aletheia report, [Towards Autonomous Mathematics
Research](https://arxiv.org/abs/2602.10177):

- `essentially_autonomous`: the agent generated the core scientific content
  without essential human intervention. Posing the problem, exposition edits,
  and genuinely minor corrections may remain auxiliary.
- `human_ai_collaboration`: human and agent contributions are both essential to
  the scientific result.
- `primarily_human`: the core scientific content is human-generated and the AI
  contribution is minor or auxiliary.

## Actors

- `benchmark`: frozen task delivery, evaluator feedback, or other protocol-owned
  communication. This is not human scientific help.
- `human`: any person interacting with the agent or changing its artifact.
- `agent`: the evaluated system, including its declared worker topology.

## Contribution classes

- `problem`: only the original `problem_statement`; never an agent event.
- `auxiliary`: formatting, exposition, administrative clarification, or a minor
  correction that does not supply a scientific step.
- `essential`: a contribution without which a material strategy, inference,
  experiment, or validation would be absent.
- `core`: authorship of the central scientific construction or result.
- `unclear`: evidence is insufficient to distinguish the above. This must
  remain inconclusive.

Use the event kinds `problem_statement`, `clarification`,
`resource_provision`, `strategy`, `technical_correction`, `artifact_edit`,
`candidate_selection`, `evaluation_feedback`, `exposition`, and `other`.
The kind describes the interaction; the contribution class determines the
derived level.

Every event needs a retained evidence reference. The private raw log must cover
the entire interval, including rejected suggestions, post-generation edits,
human candidate selection, and feedback that caused a retry. Hash commitments
do not prove that an omitted event never happened; completeness depends on the
evaluator-controlled recorder and operating boundary.
