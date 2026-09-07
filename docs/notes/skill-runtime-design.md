# Skills in the scientific runtime

Skills are local bundles of instructions and supporting files. They supply a
method when a task needs it; the Research session remains the agent loop. A skill
does not create a second planner, install packages on discovery, switch models,
or bypass tool permissions.

## Discover metadata, then load instructions

`Skill.catalog()` provides one permission-filtered view to the workbench, prompt
assembly and `skill` tool. Catalogs retain frontmatter metadata rather than full
instruction bodies. The model sees category counts and at most eight relevant
matches. Explicit `/skill-name` requests keep their existing priority over
suggested workflows.

Prompt suggestions and `skill(query=...)` use the same deterministic lexical
search across names, descriptions, tags and capabilities. Exact names and known
aliases win. Search is not an embedding service or a claim of semantic reasoning;
it adds no model call, network dependency or registry. A category can restrict a
query. Browsing returns at most 40 entries and an explicit next-page offset.

Loading reads the selected `SKILL.md` again, validates its current frontmatter,
and returns its instructions with a base directory for relative references. The
tool records the origin and SHA-256 of the delivered instruction body in its
result metadata. This identifies the instructions used in a trajectory; it is
not a signature or a claim that the procedure is scientifically validated.

## Predictable local ownership

Existing sources remain supported: bundled release assets, reviewed URL installs,
user-authored skills, compatible `.claude/skills` directories, trusted project
`.openscience/skills` directories, and explicit `skills.paths` configuration.

For duplicate names, precedence is project > user > installed > bundled. Global
OpenScience configuration folders are user scope. Within project directory
discovery, an ancestor is loaded before a nearer project folder. Files within a
source are sorted by path; the later path wins and the collision is logged once
per pair. OpenScience project folders override compatible Claude project folders.
Explicit configured paths are processed last, in configuration order. These
rules make a collision repeatable rather than dependent on filesystem enumeration.
Use distinct names when an override is not intended.

Bundled skills are versioned build assets. Third-party installation continues to
use the existing pinned-source and review workflow. Discovery does not fetch
updates. Editing or installing a skill invalidates its catalog without disposing
active Research sessions, terminals or jobs. Disabling a skill removes it from
discovery and future loads; it does not erase instructions already delivered in a
conversation.

## Instructions do not confer execution authority

Untrusted project configuration remains excluded. Server-wide disabled skills
cannot be re-enabled by project configuration, and `deny` permission rules remain
authoritative. Loading asks for the normal skill permission, then checks the
current selection again. If the selected origin/path changed while approval was
pending, the call fails and asks for a fresh selection. Invalid or newly disabled
frontmatter fails before instructions are delivered.

A successful load grants the session read access to that exact bundle directory
so references and scripts can be inspected. It grants neither write access nor
access to the parent or sibling bundles. `allowed-tools` requests tool visibility
only; a tool still passes its ordinary execution, filesystem, credential and
compute checks. Requirements are capability hints, not proof of installed
dependencies or permission to acquire compute. Referenced scripts run only through
normal tools when the task and permissions authorize them.

## Where functionality belongs

Put a reusable scientific procedure, limitations and validation steps in a skill.
Keep credentials, API pagination, cancellation and result envelopes in connectors
or tools. Keep durable jobs and resource cleanup in compute services. Keep
task-specific staging, hidden graders and benchmark policy in adapters. A skill
can compose these working capabilities without embedding benchmark answers or
forcing every scientific request through the same workflow.

The implementation is in `backend/cli/src/skill`, `src/tool/skill.ts` and
`src/session/system.ts`. Regression tests cover ranked discovery, bounded browse,
selection changes, duplicate precedence, current-content loading, read-only bundle
access, runtime skill additions, and the Research tool-schema budget.
