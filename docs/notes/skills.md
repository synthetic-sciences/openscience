# Skills: where they come from and how they resolve

A **skill** is an instruction bundle (`SKILL.md` with `name`/`description`/`category`
frontmatter and a body) that the agent loads on demand to prime itself for a task.
This note explains where skills are discovered and how a bare name resolves —
useful when a skill is unexpectedly "not found".

The [skill runtime design](skill-runtime-design.md) explains metadata discovery,
bounded search, instruction loading, and the execution-authority boundary.

## Sources

The catalog is assembled in `backend/cli/src/skill/skill.ts` from several sources,
keyed by skill `name`:

1. **Default skills** — the repository's `backend/cli/skills/` tree. Release
   builds embed the complete tree, including scripts, references, assets, and
   templates, in a verified archive. No login or download is required.
2. **Installed skills** — Git-installed packs under
   `~/.openscience/installed-skills/`, plus compatible global
   `~/.claude/skills/` packs.
3. **Personal skills** — authored through Customize or
   `openscience skill new`, stored under `~/.openscience/user-skills/`.
   Global OpenScience skill directories also have user precedence.
4. **Project skills** — `.openscience/{skill,skills}` and `.claude/skills`
   directories committed to the current project, plus `skills.paths` entries.

5. **Registered roots** — directories added at runtime through
   `POST /settings/skills/paths` (`Skill.addRoot`), per project instance, loaded
   with project precedence exactly like `skills.paths`; `persist` writes them
   to the global or project config. `Skill.roots()` reports every root with
   the skills it won and lost (`shadowed`), and each winning skill carries
   `shadows` with the paths it beat. `GET /skill/:name/content` serves the
   SKILL.md text for remote clients.

`OPENSCIENCE_DISABLE_BUNDLED_SKILLS` disables only the default release library.
`OPENSCIENCE_DISABLE_CLAUDE_CODE_SKILLS` disables compatible Claude skill paths.
`OPENSCIENCE_DISABLED_SKILLS=vllm,tensorrt-llm` hides individual skills from
every source. Each comma-separated value may match either the skill's frontmatter
`name` or its containing directory name. Empty values and surrounding whitespace
are ignored.

A skill author can set `disabled: true` in `SKILL.md` frontmatter to keep that
specific copy out of the catalog. A disabled copy does not shadow an enabled copy
from another source; normal project → user → installed → default
precedence still applies among the enabled copies.

## Two tiers: core and library

`backend/cli/skills/core/` holds the curated research procedures the Research
agent always sees: one line per skill in a `<core-skills>` block built by
`SystemPrompt.coreSkills` (`backend/cli/src/session/system.ts`) from the
`summary` frontmatter field (falling back to the description's first sentence),
in the order `CORE_ORDER` gives, followed by two category pointers that name
the cloud-provider and database skills so they are one exact-name load away.
Bodies are never preloaded; the model calls `skill({name})` when a task matches.
Everything outside `core/` is the library, reached by `skill({query})`,
`skill({category})` or an exact name. The old hand-written routing table is gone;
the full `<available-skills>` catalog appears only for an explicit `/skill`
invocation.

Core skills are authored here, not vendored: third person `description` with the
trigger terms and a "not for" clause, a `summary` under 120 characters (quote it
when it contains a colon), a body under 250 lines with the stance, the
non-negotiables, the workflow as a checklist with its feedback loop and "before
you hand it over", then `references/` one level deep with a contents list.

Retired names (`scientific-writing`, `citation-management`, `hypothesis-generation`,
`scientific-schematics`, `verify`, ...) resolve through `SkillCatalog.aliases`
(`backend/cli/src/skill/catalog.ts`) to the core skill that replaced them, for
`skill({name})`, `/name` invocations and installer entries. A real skill carrying
a retired name still wins over the alias.

Specialists (`backend/cli/src/agent/specialist.ts`) are Research workers with a
domain contract, the full index of their library categories (`<domain-skills>`),
and their domain tools; the lead selects one through the Task tool's
`specialist` parameter (`ml`, `biology`, `physics`, `chemistry`, or the read-only
`critique` reviewer). A skill that declares `allowed-tools` unlocks those tools
for whichever agent loaded it, including the biology database tools that were
previously gated to the biology agent.

## Resolution

`Skill.get(name)` looks up the assembled name→skill map. On a name collision the
precedence is project → user → installed → default. Within a source directory,
paths are sorted and the later path wins. Closer project directories override
ancestors. Explicit `skills.paths` entries are processed last, in configured order,
with project precedence. If a name isn't
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
