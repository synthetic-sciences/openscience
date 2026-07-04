---
name: skill-installer
description: Install or remove third-party openscience skills from a public git repository. Use when the user says "add this skill <url>", "install skill <url>", or "remove skill <namespace>". The skill runs locally via `openscience skill add|list|remove`, fetches the repo, runs a 6-layer safety gate (regex + server-side Haiku classifier), prompts the user to confirm, then writes the skills to ~/.openscience/installed-skills/ and uploads to the dashboard for cross-machine sync.
category: other
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Skill Installer

## Overview

Installs URL-supplied third-party skills into the openscience CLI. The skill itself is a thin wrapper around the bundled `openscience skill` bash subcommand — when the user expresses install/uninstall intent, invoke `openscience skill add|list|remove` via the `bash` tool. The CLI handles fetching, the safety gate, confirmation, on-disk write, and cross-machine sync.

## When to Use This Skill

Trigger on user messages like:

- "Add this skill: <url>"
- "Install <url>" / "Install the skill at <url>"
- "Set up skills from <repo>"
- "Remove the X skill" / "Uninstall <namespace>"
- "List my installed skills"

Do NOT use this skill for:

- Generating new skills (different workflow — see `openscience learn`)
- Installing system packages (use `bash` directly)
- Anything that's not a openscience skill source

## How to Use

### Add a skill

```
openscience skill add <git-url>
```

Accepted URL forms:

- `https://github.com/<owner>/<repo>` — default branch, all skills in `skills/**/SKILL.md`
- `https://github.com/<owner>/<repo>/tree/<ref>` — specific ref/tag
- `gh:<owner>/<repo>` — shorthand
- `gh:<owner>/<repo>@<ref>[/<path>]` — shorthand with ref and optional path scope
- Generic `git+ssh://...` / `https://gitlab.com/...` URLs

What happens when the user runs `add`:

1. CLI clones the repo into a temp dir, pins the commit SHA.
2. Enumerates `skills/<name>/SKILL.md` files.
3. Runs Layers 1, 2, 4 (local regex passes) on every SKILL.md + companion script.
4. POSTs the surviving manifest to `/api/cli/skill-review` for the Layer-3 Haiku classifier (server-side, sandboxed input with canary integrity check).
5. Renders a confirm screen showing the manifest + warnings + classifier reasoning + first lines of each SKILL.md.
6. On `y`, writes everything to `~/.openscience/installed-skills/<namespace>/<name>/` and uploads to the dashboard.

The `<namespace>` is derived from the repo name (last URL segment, lowercased).

### List installed skills

```
openscience skill list
```

Prints `<namespace>/<name>` with a `⚠` marker for any skill the safety gate warned on.

### Remove a skill

```
openscience skill remove <namespace>            # whole namespace
openscience skill remove <namespace>/<name>     # single skill within a namespace
```

Soft-deletes the cloud record (`archived_at` set) and removes the on-disk directory.

## Examples

User: "Install the brainstorming skill from Anthropic's superpowers repo."

You: invoke `bash` with `openscience skill add gh:anthropics/superpowers/skills/brainstorming`. Wait for the spinner + confirm prompt. Relay the manifest to the user. Pass through their `y/N` response.

User: "Uninstall everything in superpowers."

You: invoke `bash` with `openscience skill remove superpowers`. Report the count of archived skills.

User: "What's installed?"

You: invoke `bash` with `openscience skill list`. Print the output.

## Safety Notes

The user-facing `openscience skill add` command runs every install through 6 layers (regex catastrophic-reject, regex classifier-injection-reject, server-side LLM classifier, regex suspicious-warn, user-confirm screen, deferred `allowed-tools` sandboxing). Don't try to bypass any of these by editing `~/.openscience/installed-skills/` directly — that breaks the cloud-sync invariant. Always go through the bash subcommand.

If `openscience skill add` reports `classifier unreachable`, the dashboard backend is down — surface that to the user and stop. Do not retry with a flag that disables the classifier without the user's explicit consent.

## Reference

- Spec: `thesis/docs/superpowers/specs/2026-05-14-cli-add-skill-from-url-design.md`
- Plan: `thesis/docs/superpowers/plans/2026-05-14-cli-add-skill-from-url.md`
- On-disk layout: `~/.openscience/installed-skills/<namespace>/<name>/SKILL.md` (mirror of `~/.openscience/learned-skills/`)
- Backend endpoints under `/api/cli/installed-skills` + `/api/cli/skill-review`
