# On-demand project recall

`scope: "project"` searches saved conversations only when the model calls the tool.
The existing `all`, `history` and `outputs` scopes retain their current-session
meaning. The system prompt assembly and session-context handling are unchanged
from main; only the static recall tool description/schema gains the new capability.

## Selection and bounds

`Session.list()` enforces the current project and canonical directory. Project
recall excludes the current session, children, archived and reverted sessions. A
child caller cannot search project history. Candidates are sorted by update time
(newest first, ID as a tie-breaker). Messages stream newest first; completed,
successful replies resolve their user parent directly, including the original
request behind a continuation. Empty and aborted-only sessions do not count
toward coverage. Only visible text is searched, not summaries, internal carriers,
ignored/synthetic parts, reasoning or tools.

Forks remap message IDs. Matching excerpts are deduplicated across sessions by
role, turn timestamps and the full visible exchange text, not a short excerpt.
The session and message IDs refer to the copy actually returned.

Each message's search text is capped at 65,536 UTF-16 code units and each excerpt
at 240 Unicode code points. There is no fixed window on sessions or messages.
Results are bounded by the match limit (default 20, maximum 100) and a 16 KiB
UTF-8 output budget. The header,
JSON escaping and final coverage line are included in the byte budget.

A roughly two-second budget starts before candidate enumeration. Reaching a time,
match or output limit returns the hits so far and a footer with the stop reason,
fully searched eligible session count and, when available, the update date of the
last session reached. A partly scanned session is not counted as fully searched.
Reaching the match limit stops the scan immediately; it does not establish whether
another match exists. A caller abort rejects rather than returning partial results.
Pending storage reads can settle after the caller returns. The deadline is checked
between units of work; a running synchronous JavaScript regex is not preemptible.

Each invocation reads current state. Results already delivered to a conversation
are not removed when the source changes.
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
