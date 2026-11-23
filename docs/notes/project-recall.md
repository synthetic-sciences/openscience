# On-demand project recall

`scope: "project"` searches saved conversations only when the model calls the tool.
The existing `all`, `history` and `outputs` scopes retain their current-session
meaning. The system prompt assembly and session-context handling are unchanged
from main; only the static recall tool description/schema gains the new capability.

## Selection and bounds

`Session.list()` enforces the current project and canonical directory. Project
recall excludes the current session, children, archived and reverted sessions. A
child caller cannot search project history. Metadata is enumerated to retain the
eight newest eligible sessions, sorted by update time with ID as a tie-breaker.
This bounds candidate message reads, not the cost of enumerating session metadata.

The latest 32 messages per candidate are inspected newest first for completed,
successful `stop` replies, excluding compaction summaries. A reply must have a real
user parent in that window. Continuations resolve to the original user request;
other internal carriers do not qualify. Only visible text is searched, excluding
ignored/synthetic parts, reasoning and tools. Repeated original prompts are searched
once per candidate. Unlike automatic last-exchange recall, an earlier matching
exchange in the window is not hidden by a later unrelated exchange.

Each message's visible text is capped at 65,536 UTF-16 code units for searching.
This does not bound deserialization of stored messages. The JavaScript regex syntax
is the existing recall contract. Results carry source session/message IDs, role,
reply completion time, character offset and at most 240 Unicode code points of
context. JSON escaping and the explanatory header count toward the 16 KiB rendered
output budget. At most four matching sessions and the caller's match limit (default
20, maximum 100) contribute results. `truncated` indicates omitted matches due to
output/result/session limits; the header always states the search-window limits.

Records that disappear or become unavailable are skipped. Each invocation reads
current state, without a snapshot cache or duplicated storage. A result already
delivered to a conversation is not retroactively removed when its source changes.
The operator switches `OPENSCIENCE_DISABLE_PROJECT_MEMORY` and
`OPENSCIENCE_DISABLE_PROJECT_CONFIG` suppress project search only.

## Verification

- Existing recall tests retain current-session history and saved-output behavior.
- Project tests exercise query matching, persistence, isolation, source removal,
  eligibility, continuation handling, limits, Unicode, and disable switches.
- A local deterministic provider drives real `SessionPrompt` runs in independent
  processes: record a fact, make an unrelated request, then emit a project recall
  tool call. The fact is absent from the first request and system text, appears
  only in the tool response, and system messages/tool definitions remain identical
  across the sessions and tool steps. This tests routing and caching invariants,
  not a commercial model's decision to invoke recall.
