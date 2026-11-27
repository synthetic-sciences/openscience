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

The existing JavaScript /gi interface is unchanged. Plain identifier text and a
conservative subset of regexes have a known positive maximum width (up to 4,096
UTF-16 units): simple character classes and bounded repetitions, at most one of
variable length. These patterns scan all visible text in 65,536-unit windows with
lookahead of maximum width minus one. A short pause between windows allows
cancellation or timeout. Other expressions retain the original 65,536-unit prefix
limit, disclosed in the coverage footer. Each excerpt is capped
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

Partial pages (time, result count or output bytes) expose an opaque `nextCursor` in
the tool result and metadata. Pass it as `cursor` with the same regex and reader
session. The server retains the iterator position (including an unfinished message
or regex window), at most one pending read/row per iterator, and fork deduplication
state. Coverage is cumulative; the time and output budgets reset on each call.
Bookmarks are single-use, expire after five idle minutes or instance disposal, and
at most eight idle bookmarks are retained per instance. Sources are revalidated
before emitting buffered matches on resume. This is not a transactional snapshot;
start a new search for newly created sessions. An invalid cursor errors instead of
silently restarting. There is no automatic pagination or alternate matching mode.

A fresh search reads current state. Results already delivered to a conversation
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
