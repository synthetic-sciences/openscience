# Skills: where they come from and how they resolve

A **skill** is an instruction bundle (`SKILL.md` with `name`/`description`/`category`
frontmatter and a body) that the agent loads on demand to prime itself for a task.
This note explains where skills are discovered and how a bare name resolves —
useful when a skill is unexpectedly "not found".

## Sources

The catalog is assembled in `backend/cli/src/skill/skill.ts` from several sources,
keyed by skill `name`:

1. **Default skills** — the repository's `backend/cli/skills/` tree. Release
   builds embed the complete tree, including scripts, references, assets, and
   templates, in a verified archive. No login or download is required.
2. **Installed skills** — Git-installed packs under
   `~/.openscience/installed-skills/`, plus compatible global
   `~/.claude/skills/` packs.
3. **Learned skills** — private skills distilled from prior local runs under
   `~/.openscience/learned-skills/`.
4. **Personal skills** — authored through Customize or
   `openscience skill new`, stored under `~/.openscience/user-skills/`.
5. **Project skills** — `.openscience/{skill,skills}` and `.claude/skills`
   directories committed to the current project, plus `skills.paths` entries.

`OPENSCIENCE_DISABLE_BUNDLED_SKILLS` disables only the default release library.
`OPENSCIENCE_DISABLE_CLAUDE_CODE_SKILLS` disables compatible Claude skill paths.
`OPENSCIENCE_DISABLED_SKILLS=vllm,tensorrt-llm` hides individual skills from
every source. Each comma-separated value may match either the skill's frontmatter
`name` or its containing directory name. Empty values and surrounding whitespace
are ignored.

A skill author can set `disabled: true` in `SKILL.md` frontmatter to keep that
specific copy out of the catalog. A disabled copy does not shadow an enabled copy
from another source; normal project → personal → learned → installed → default
precedence still applies among the enabled copies.

## Resolution

`Skill.get(name)` looks up the assembled name→skill map. On a name collision the
precedence is project → personal → learned → installed → default. If a name isn't
present, the skill tool returns a "not found" error with the closest fuzzy
matches.

## Authoring

To contribute a skill to the bundled library, see
[adding-a-skill.md](adding-a-skill.md). Personal skills work like this:

```bash
openscience skill new leakage-checks --description "Checklists for spotting data leakage"
openscience skill validate leakage-checks
openscience skill list --all      # everything discovered on this install
```

Pin extra skill folders per project with `skills.paths` in `openscience.json`.
