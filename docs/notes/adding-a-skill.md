# Adding a bundled skill

A bundled skill is a `SKILL.md` instruction bundle under `backend/cli/skills/`
that ships with every release. This guide covers contributing one to the
default library; [skills.md](skills.md) explains how skills are discovered and
resolved at runtime, and `openscience skill new` creates a personal skill
outside the repo.

## Where it goes

```
backend/cli/skills/<category>/<name>/
  SKILL.md          # required: frontmatter + instructions
  scripts/          # optional helper scripts the instructions reference
  references/       # optional background documents
  assets/, templates/
```

- `<category>` is one of the existing directories (`biology`, `chemistry`,
  `cloud-compute`, `coding`, `data-engineering`, `databases`,
  `document-parsing`, `llm-tools`, `ml-inference`, `ml-training`, `other`,
  `physics`, `quantum`, `research`, `scholar-evaluation`, `visualization`,
  `writing`). Add a directory only with maintainer agreement.
- `<name>` is lowercase with hyphens and must equal the frontmatter `name`.
  Names are global across every skill source, so pick something specific
  (`scanpy`, not `single-cell`).
- Never reuse a retired product name. `backend/cli/src/skill/retired.ts` lists
  them (the `atlas-*` family) and `bundle-format.ts` refuses to build a release
  archive that contains one.

## Frontmatter contract

The parser is `Skill.Info` in `backend/cli/src/skill/skill.ts`; the validate
command and `test/skill/bundled-skills.test.ts` check the same fields.

```yaml
---
name: anndata
description: Data structure for annotated matrices in single-cell analysis. Use when working with .h5ad files or integrating with the scverse ecosystem.
category: biology
tags: [Single-Cell, Data Format, h5ad, Bioinformatics]
license: BSD-3-Clause license
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
dependencies: ["anndata>=0.10.0", "numpy>=1.25.0"]
---
```

| Field                                                      | Required | Meaning                                                                                                                               |
| ---------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                     | yes      | Skill id; must match the directory name.                                                                                              |
| `description`                                              | yes      | One paragraph the model reads to decide when to load the skill. Say what it is for and when _not_ to use it.                          |
| `category`                                                 | no       | Catalog grouping; use the directory name.                                                                                             |
| `tags`                                                     | no       | Free-form list used for search.                                                                                                       |
| `role`                                                     | no       | `workflow` (user-facing task) or `support` (helper loaded by other skills).                                                           |
| `capability`                                               | no       | Scientific capability id this skill fronts, if any.                                                                                   |
| `allowed_tools`                                            | no       | Tools the skill may request after loading; permissions still apply.                                                                   |
| `requirements`                                             | no       | `{ all: [...], any: [...] }` runtime requirements.                                                                                    |
| `entry`                                                    | no       | `false` hides the skill from `/` autocomplete; bundled skills leave it unset.                                                         |
| `disabled`                                                 | no       | `true` keeps this copy out of the catalog.                                                                                            |
| `license`, `version`, `author`, `metadata`, `dependencies` | no       | Conventions in the bundled tree; passed through unchanged. Keep `dependencies` as scalar pip specs (`ray[train]`, not a nested list). |

The body is plain Markdown: an overview, when to use it, the workflow, and the
pitfalls. Reference helper scripts by path relative to the skill directory.
`backend/cli/skills/` is excluded from Prettier, so format the file by hand and
keep lines readable.

## Validate and test

`bun dev` runs with `backend/cli` as its working directory, so pass paths
relative to that directory (or absolute paths):

```bash
bun dev skill validate skills/<category>/<name>/SKILL.md            # frontmatter + safety review
bun dev skill validate skills/<category>/<name>/SKILL.md --strict   # also fail on warnings
bun dev skill list --all                                            # confirm it is discovered
```

The safety review rejects prompt-injection patterns and flags suspicious
instructions; fix rejections before opening a pull request.

```bash
cd backend/cli
bun test --timeout 15000 ./test/skill/bundled-skills.test.ts   # every bundled SKILL.md parses
bun test --timeout 15000 ./test/skill                          # the rest of the skill suite
```

`bundled-skills.test.ts` pins the number of bundled skills (`expect(files.length).toBe(312)`);
bump it in the same change when you add or remove one. Do not add counts to
README.md or the docs site; they drift with every skill change.

## Try it

Run the workspace in this checkout (`bun dev "$PWD"`) and ask the agent to use the
skill by name, or load it directly with the skill tool. Dev mode reads
`backend/cli/skills/` from disk, so edits show up on the next session without a
rebuild. Release builds embed the tree through
`backend/cli/script/generate-skill-bundle.ts`; nothing else is needed.

## Pull request

- Title `feat(skills): add <name>` or `fix(skills): <what broke>`. A broken
  bundled skill (bad script, changed upstream API) does not need an issue first.
- Say which commands or notebooks you ran to confirm the instructions work.
- Add a line under **Unreleased** in `CHANGELOG.md` for a new skill.
