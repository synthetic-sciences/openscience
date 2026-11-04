# Project memory

Project memory is a directory of markdown notes that a session reads before it
starts work: `.openscience/memory/` inside the project directory. It exists so a
decision recorded in one session is still available in the next one, without
turning the conversation history into context.

The reader is `InstructionPrompt.systemPaths()` in
`backend/cli/src/session/instruction.ts`. Memory is a directory convention
rather than a config key, so a project adopts it by writing files; nothing has
to be enabled first.

## Where it goes

```
<project>/.openscience/memory/
  decision.md          # any markdown file, any depth
  datasets/visdrone.md
  conventions/repo.md
```

- Every `**/*.md` file under the directory is injected, recursively. Hidden
  paths are not scanned.
- The file name is the only label: there is no frontmatter contract, no schema,
  and no required heading. Write what a new session needs to know.
- Files are injected in sorted path order, so `00-…`/`01-…` prefixes are the
  supported way to control ordering within memory.

## What a session sees

Each file is rendered exactly like an instruction source:

```
Instructions from: <project>/.openscience/memory/decision.md
<file contents>
```

Memory is appended **after** every other instruction source, which has two
consequences worth knowing before you rely on it:

| Limit      | Value   | Effect on memory                                                                                                               |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Per source | 256 KiB | A larger memory file is skipped entirely.                                                                                      |
| Combined   | 1 MiB   | Memory is appended last, so `bounded()` drops memory entries before it drops `AGENTS.md` or a configured `instructions` entry. |
| Sources    | 64      | Memory files are only added while slots remain; a project with many configured sources may have no memory injected at all.     |

The ordering is deliberate: instructions describe how work must be done, memory
describes what was decided. When a project gets greedy with context, the
instructions keep their priority and memory is the first thing sacrificed.

## How a note gets written

When the user asks the agent to remember something, the session prompt tells it
to append a short entry to `.openscience/memory/decision.md` with its file tools
instead of only restating the decision in the conversation. That sentence is
appended after the instruction sources and outside the byte budget, so it
survives even when a project's instructions are already at the 1 MiB limit.

The agent writes; the product does not:

- You can also write the file yourself, or edit a note the agent produced.
- `openscience.jsonc` in the project root is a regular source; memory is a
  different one. Do not put memory content in `openscience.json`'s
  `instructions` — it would then outrank `AGENTS.md`.

There is no automatic capture, no summarization hook, and no background writer.
A write happens on a turn where somebody asked for it, which keeps every entry
reviewable and attributable. The alternative — capturing every turn and letting
the model decide what is worth keeping — has to answer questions this change
leaves open: what is stale, and how two sessions that disagree are reconciled.

## What it is not

- **Not conversation history.** Sessions are already durable and listed in the
  workspace; a new session still starts with an empty message list. Memory is a
  project-level fact file, and it is why a fresh session can answer "what did we
  decide" without reading another session's transcript.
- **Not scoped to a user.** Memory belongs to the project directory, so every
  session in that project reads the same notes.
- **Not a vector store or retrieval system.** Everything under the directory is
  injected, bounded by the limits above. If memory outgrows the budget, the
  correct fix is pruning notes, not adding retrieval.
- **Not global.** There is no cross-project memory; the global compatibility
  sources (`~/.claude/CLAUDE.md`, the config-root `AGENTS.md`) are unrelated.

## Related

- `backend/cli/src/session/instruction.ts` — the reader: `memoryFiles()` and
  `InstructionPrompt.systemPaths()`.
- `backend/cli/test/session/project-memory.test.ts` — injected, absent, budget
  exhaustion, precedence.
- [adding-a-skill.md](adding-a-skill.md) — knowledge that ships with the
  product rather than living in one project.
