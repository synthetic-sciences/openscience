# Project memory

OpenScience automatically persists conversation messages in its existing session
store. A new session can now recall recent completed exchanges from that store,
without a remember command, an extra model call, or an agent-written memory file.

## Automatic recall

At the start of each turn, `ProjectMemory.recall()` selects up to eight recent
eligible session records in the current project and directory, ordered by update
time with session ID as the tie-breaker. It examines the latest 32 messages in
each candidate and includes the latest completed visible user/assistant exchange
from at most four sessions. This is bounded conversation recall, not a semantic
summary or a complete reconstruction of every earlier decision.

The current session, child-agent sessions, archived sessions and sessions with an
active revert are excluded. A reply must be completed, have a `stop` finish reason,
and have neither an error nor the compaction-summary flag. Only visible text is
included: tool output, reasoning, ignored text and synthetic messages are omitted.
A continuation reply can use its original user request when that request is still
in the inspected window. Unavailable records are skipped.

Each user/assistant excerpt is limited to 2 KiB of UTF-8 text plus a truncation
marker. Rendered automatic recall totals at most 16 KiB and carries source session
IDs and completion timestamps. It is labeled historical context, not instructions;
current requests and project rules take priority. Facts can be stale and should
be checked when they matter.

The recall snapshot is held for one turn's model/tool loop, keeping its provider
prefix stable. The next turn refreshes it. The source is the existing durable
history, so a server restart does not lose memory and deleted/archived/reverted
sessions are excluded on the next recall. Disabling recall does not erase history.
Previously saved conversations are eligible as well; there is no second store to
migrate or synchronize. No project file is created automatically.

## Curated project notes

Long-lived facts can also be kept in `.openscience/memory/**/*.md` under the opened
project directory. The user or an ordinary requested file-editing task maintains
these files. There is no system instruction to append decisions automatically.
Notes are read whenever the instruction prompt is assembled, including later
steps in the same turn; they are not a session-start snapshot.

Hidden paths are skipped. Notes are selected and rendered in sorted absolute-path
order, including when the source limit is reached; `00-` prefixes can prioritize
notes. Selection retains only the remaining number of paths in memory. If a scan
finds more than 4,096 markdown files, it skips curated notes and logs a warning
instead of selecting an arbitrary traversal-order subset. A missing or unreadable
directory does not prevent a session from starting.

## Shared limits and precedence

`InstructionPrompt.system()` orders sources as follows:

1. Existing local/global/configured instruction files, in their existing order.
2. Configured URL instructions, in their existing order.
3. Curated project notes, in sorted path order.
4. Automatically recalled exchanges, newest candidate first.

All entries share the existing 64-source and 1 MiB rendered-byte limits. Notes and
recall only use slots left after instruction sources. The existing local reader
rejects non-regular files and files over 256 KiB, and detects concurrent changes.
Nothing is appended outside the combined budget. Memory can be omitted when
instructions consume the budget; the prompt makes no claim that omitted notes
were loaded. Notes are labeled `Project memory from:`, separately from instructions.

## Disable

Set `OPENSCIENCE_DISABLE_PROJECT_MEMORY=1` before launching the server to disable
both automatic recall and curated notes. `OPENSCIENCE_DISABLE_PROJECT_CONFIG=1`
also suppresses both. Neither switch deletes saved conversations or notes.

## Verification

- `project-memory.test.ts`: curated notes, source limits, sorting and switches.
- `project-memory-budget.test.ts`: URL precedence and the exact combined limit.
- `project-memory-recall.test.ts`: durable recall, isolation, deletion, filtering
  and bounded UTF-8 excerpts.
- `project-memory-prompt.test.ts`: actual session prompt executions against a
  local deterministic provider in independent processes; the second process
  receives the earlier fact only in its system context. A queued-turn scenario
  archives the sources during a request and checks that the next epoch refreshes
  recall. This verifies runtime integration without evaluating a real model's
  recall quality.
