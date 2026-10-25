# Traces, usage and cost: local acceptance

The packaged/browser fixtures were verified on 2026-10-18 against OpenScience
`9fac1706` and Dashboard `83ae327f`. The live local Ace audit below adds real
provider billing and an exact Wallet receipt. Neither check establishes hosted
deployment acceptance.

## Current completion audit

The following maps the seven requested items to evidence below. Earlier sections
retain the exact versions and fixture scope of each historical check. Live
subscription, BYOK and Ace evidence supplements those fixtures; local Wallet
receipts do not establish the hosted release.

| Item                             | Current evidence                                                                                                                                                                                                                                                                | Open acceptance                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1. Real route audit              | Raw subscription/BYOK comparisons; real local Ace parent/worker calls→holds→charges; real mixed Ace/BYOK delegation; provider generation checks                                                                                                                                 | Hosted Ace verification and wider route/provider coverage        |
| 2. Shared trace path             | Durable dispatch/outcome, retry/failure/cancellation tests, live worker/internal/background calls; interrupted work stays visibly pending                                                                                                                                       | Release acceptance on deployed versions                          |
| 3. Reported token fields         | Nullable provider fields, raw cache-write correction, zero/omitted replay matrix, context and usage displays                                                                                                                                                                    | Release acceptance on deployed versions                          |
| 4. Task Wallet receipts          | Exact scoped worker receipts, independent of sharing; SQLite/PostgreSQL and browser acceptance; five real local Ace parent/worker receipts                                                                                                                                      | Hosted receipt endpoint currently returns 404                    |
| 5. BYOK cost provenance          | Separate cost sources; real nonzero provider records imported with unique matches; local browser shows separate totals and 2/0/0 reconciliation; isolated Chrome file-input import, reload and removal pass; independent account Analytics now matches two unique nonzero calls | Hosted release acceptance                                        |
| 6. Shared message/event database | Schema 7 includes Task replay records; migration/recovery/deletion/relocation checks and real Task replay                                                                                                                                                                       | Release acceptance                                               |
| 7. Logging health                | Queue/rejection/receipt/projection/attempt/charge checks, all-route opt-out; real local Ace worker health: five completed/settled, zero mismatches                                                                                                                              | Hosted health endpoint currently returns 404; release acceptance |

Independent billing evidence now includes two authenticated account Analytics records,
queried by exact generation ID and imported without changing their reported amounts.
This is an account report, not an invoice or a settled Wallet receipt. No item is
marked released solely on local tests. Current post-schema-7 checks include 90 broader
storage/trace/receipt/billing tests and 72 data-root/storage-route tests (one
skipped). No production promotion has been performed.

## Deployment

`bun run build --single` completed twice: first for `71ff6de1`, then with the
context-entry correction in `9fac1706`. The latter executable serves the
embedded workspace UI on `http://localhost:4201`. A separately started full
Dashboard API on `http://127.0.0.1:8010` uses a consistent SQLite backup of the
disposable earlier acceptance database. Existing app/server processes were not
restarted. The app's copied data directory upgraded to research database schema
6 without pending ambiguous legacy records.

The acceptance project is **Roadmap acceptance fixtures**, with a root task
**Trace, receipt and billing acceptance** and one child worker. Requests use a
loopback fixture provider, through `Provider.fetchWithIdleWatchdog` and
`ModelCallTrace`, with an actual HTTP exchange for each attempt.

## Observations

| Check                        | Observed result                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attempt identity and outcome | Three calls retained the same HTTP UUIDs locally and on the server: dispatch/completed, dispatch/failed (HTTP 503), and dispatch/cancelled after a partial body.                                                                                                                                                        |
| Delivered evidence           | Seven new events acknowledged; queue and quarantine empty. Server health displayed three calls, three dispatches, one completed, one failed and one cancelled.                                                                                                                                                          |
| Reported usage               | A controlled observation with input 0 and output 3 retained those counts locally and in `account_usage_events`. Omitted reasoning remained null.                                                                                                                                                                        |
| Provider amount              | The fixture observation's `0.00123` USD stayed provider-reported evidence in both stores.                                                                                                                                                                                                                               |
| Imported billing             | A local two-record normalized import preserved a charge of `0.004560000000000001` USD and a separate credit of `0.00001` USD. Exact provider/request IDs uniquely matched the charge; the credit remained unmatched.                                                                                                    |
| Usage UI                     | API-key usage displayed provider-reported `$0.00123 (partial)`, imported billing `$0.004560000000000001`, and imported credit `$0.00001` separately. No combined cost was presented. The partial label covered an unreported cancelled-call amount.                                                                     |
| Worker receipt               | An explicitly synthetic settled hold/ledger pair for the failed worker call returned a stable receipt ID and exact `123` microdollars. The task lookup included the child session and displayed `USD 0.000123`.                                                                                                         |
| Before any response          | Browser acceptance found the header previously hid Context without a usage sample. `9fac1706` exposes the button in that state. The rebuilt executable opened Context and checked receipts with zero transcript messages. Token fields displayed Unknown.                                                               |
| Device opt-out               | The browser switch disabled sharing. A second process holding a pre-opt-out context made actual local HTTP calls through all six route labels: managed, byok, chatgpt, subscription, local and custom. Six completed private records persisted; no upload payloads remained and the server event count stayed at eight. |
| Independent receipt lookup   | With sharing off, the task lookup still returned the settled worker receipt. The additional unlinked private managed call remained Unknown, and the receipt subtotal was explicitly incomplete.                                                                                                                         |
| Health diagnostics           | The copied database deliberately retained one older response lacking a usage projection. Health reported this discrepancy instead of claiming that the whole window was healthy. The failed worker call joined its hold/ledger even though no model response existed.                                                   |

The billing import was submitted through the local API, then rendered and
reconciled in the browser. Native browser file-picker interaction was not part
of this acceptance run; file-input ingestion is covered by the component tests.
The settled financial rows are seeded test evidence, not an upstream charge.

## Validation

For the HTTP health milestone: 2,879 service tests passed (142 skipped), 34
focused tests including real PostgreSQL passed, 1,237 workspace tests passed,
25 client trace/health tests passed, and 31 SDK tests passed. All seven typecheck
packages, documentation checks and 103-table SQLite/PostgreSQL migration parity
passed. The PostgreSQL container was disposable and removed after testing.

After the small context-entry correction: workspace typecheck passed, 11
receipt/accounting tests passed, documentation checks passed, the native build
succeeded, and the rebuilt UI passed the pre-response receipt browser check.

Local run artifacts are under `/tmp/roadmap-acceptance-latest`: fixture call
identities, reconciliation outputs, opt-out evidence, cross-layer assertions,
and `receipt-panel.png`. These files contain synthetic fixture identities;
credentials are kept separately and are not included in this note.

## Still required

- Real hosted-provider/route/worker runs with returned usage compared against
  local evidence, consented server evidence and actual charge receipts.
- Independent BYOK account-report import and reconciliation now pass locally;
  the hosted release still needs acceptance.
- Hosted rollout and verification at the deployed versions. Local checks do
  not prove that these commits are running on a hosted service.

## CLI follow-up and read-only historical audit

The CLI `stats` surface also used a combined compatibility `Total Cost`. New
source separates the same cost categories as Settings, preserves exact decimal
amounts and partial/unknown evidence, and labels legacy transcript accounting
separately. Project filters include only attributable session calls and uniquely
matched imported records. All-project summaries retain unattributed internal
calls and unmatched billing. Internal/failed calls can introduce a model even
without transcript messages. Cross-project transcript reads no longer use the
HTTP reader's current-project restriction.

Validation: 107 CLI/usage/import tests passed, then 18 focused tests passed after
adding an empty-evidence check. Backend typecheck and documentation checks pass.
An actual source CLI invocation against the disposable acceptance data displayed
provider-reported `$0.00123 (partial)` separately from imported billing
`$0.004560000000000001`; the unmatched credit was excluded by its project filter.

A read-only inspection of the previously supplied real ChatGPT session found
41 completed steps and 49 saved call identities. The older records have neither
nullable reported usage nor explicit call outcomes, so their compatibility zeros
cannot establish actual provider observations. No stored records were rewritten.
The original localhost server was no longer listening. An authenticated read-only
request to the hosted health endpoint returned HTTP 404: current local health
features are not verified on that hosted deployment. No model request or payment
was made during this historical inspection.

## Fresh subscription audit and cache-write correction

A fresh real `openai-codex/gpt-6.1-sol` subscription audit used only minimal test
prompts and isolated local state. The existing unexpired access credential was
copied without its refresh token and removed from the audit state afterward.
The original credential file and original conversations were not written.
Trace uploads went to the separately deployed local Dashboard service, not the
hosted endpoint that returned 404.

Five real calls completed while verifying the pipeline and correcting an
observed field-loss bug. One was a subagent-mode child-session call; the local
root audit found its parent and child with two distinct completed HTTP call IDs.
This verifies child-session lineage, not a full live Task-tool orchestration.
Every response passed usage projection and delivery reconciliation. These
subscription calls had no managed call/hold links, and their per-call cost stayed
null/subscription-covered rather than being assigned a zero-price receipt.

For the final minimal call, the raw `response.completed` usage was:

```json
{
  "input_tokens": 33,
  "output_tokens": 5,
  "total_tokens": 38,
  "input_tokens_details": { "cached_tokens": 0, "cache_write_tokens": 0 },
  "output_tokens_details": { "reasoning_tokens": 0 }
}
```

The pinned SDK originally stripped `cache_write_tokens`; after preserving it,
the recorder also needed the configured provider metadata namespace
(`openai-codex`, rather than always `openai`). The SDK patch, compatible adapter
and recorder now preserve the field. A post-fix real call matched raw provider,
local trace and server counters exactly: input 33, output 5, reasoning 0, cache
read 0, cache write 0. HTTP call and provider request identities also matched.
The earlier audit records retain their original unknown cache-write evidence;
they were not silently rewritten.

A replay regression matrix covers JSON and SSE for OpenAI, CommonJS, Azure,
compatible and renamed Codex adapters, with zero, positive, null and omitted
write counters. Explicit provider counts override the catalog cache-write
inference. Final focused tests: 90 passed; broader provider/usage/trace/CLI
regressions: 605 passed, two skipped. Another 71 processor/accounting tests passed.
Frozen installation, all seven typecheck
packages and documentation checks pass. Raw numeric usage, lineage and matching
assertions remain in the isolated audit directory named by
`/tmp/roadmap-real-chatgpt-root`; its provider access credential has been removed.

## Fresh BYOK audit and provider billing reconciliation

A real OpenRouter request used `liquid/lfm-2.5-2.6b:free`, with prompt and
completion maximum prices both zero, fallback disabled and output capped at 32
tokens. Two HTTP 400 attempts were retained as failed calls with unknown usage
and cost. The successful request reached the output limit during reasoning;
it verifies accounting for a bounded response, not a completed answer.

Raw usage, local call records and the server projection agreed on 34 input,
32 output, 32 reasoning, zero cache-read and zero cache-write tokens. Reported
cost was explicitly zero. A read-only lookup of the actual generation confirmed
zero total cost and the same native token counters. Its normalized tokenizer
counts differed and were not substituted for native usage. See OpenRouter's
[generation metadata reference](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)
and [price routing controls](https://openrouter.ai/docs/guides/routing/provider-selection).

The provider billed a dated model name rather than the requested alias. Billing
imports now accept an explicit `requested_model` annotation while preserving the
original billed model. The actual generation record was normalized into the
import document and accepted through the settings API. Its unique request ID
matched the correct local call; the aggregate retained provider-response and
imported-billing zero amounts as separate sources. Incorrect aliases and duplicate
request IDs remain unmatched or ambiguous. The annotation is supplied by the
importer and is not independent verification of model equivalence.

The local server reconciled all three attempts, including both failures, with
one response projection and no missing response. The isolated provider credential
was removed afterward; original credentials and conversations were not written.
Content-free comparison artifacts remain in the directory named by
`/tmp/roadmap-real-byok-root`. Validation: 20 backend, eight UI and 31 SDK tests,
all seven typecheck packages and documentation checks passed. The UI tests cover
file ingestion; a native browser file chooser has not yet been driven for this
real document.

Real Ace billing, nonzero real-provider billing evidence, full live delegated-task
coverage and hosted rollout remain unproven.

## Rebuilt real-BYOK browser acceptance

The native build at `c4bfa1e9` passed `bun run build --single`. A separate
server on port 4202 opened the isolated real-BYOK audit database; existing servers
were not restarted. Settings → Usage → API keys displayed three requests and 66
recorded tokens, provider reported $0.00 marked partial with two unknown cost
observations, and imported billing $0.00 as a separate category. Manage billing
imports displayed one matched, zero unmatched and zero ambiguous records, plus
the explicit requested-model annotation and unverified-alias guidance. This
verifies rendering against the actual imported provider record. Native file-picker
automation remains unavailable in the browser tool. No inference was made during
this browser check, and the isolated provider credential remains removed.

## Real Task-tool execution and replay

The actual Task tool dispatched a configured subscription worker from a prepared
durable parent assistant record. The worker ran through SessionPrompt and returned
its answer in the Task result. This exercises real Task dispatch, child creation,
provider streaming and result reuse; the parent tool selection was prepared by
the audit rather than chosen by a live parent model. Tools were denied and the
worker was restricted to one iteration with a 90-second abort bound.

The run produced two completed HTTP calls: a worker call (4,476 input, 19 output,
12 reasoning, zero cache read/write) and an internal summary call (547 input, nine
output, zero reasoning/cache read/cache write). The root audit retained two
sessions and both call identities without double-counting the completed step.
The worker's raw provider usage matched its saved fields. Both calls matched
the corresponding server projection by HTTP and provider request identity;
subscription cost remained null, with no fabricated Wallet charge.

Repeating the same durable Task invocation returned the same result and retained
exactly the same two calls. No credential was available during replay. Health
reported seven completed calls and seven projected responses across the isolated
subscription audit history, with no pending calls or missing projections. Earlier
unknown cache-write observations remain unknown. The copied access credential
was used without refresh and removed after execution. Assertions are recorded in
`task-tool-verified.json` in the isolated subscription audit directory.

Model-selected parent delegation, background cancellation and mixed-route live
Task orchestration remain outside this run's acceptance scope.

## Task replay records join the research database

The live Task audit exposed `task_attempt` records still using legacy JSON
files. Schema 7 adds project-scoped Task attempts to the same transactional
research database as messages and traces. Existing attempts migrate with their
identities, fingerprints and saved results intact. Original files remain backups;
authoritative changes and deletions survive database reopening without restoring
stale backup content. Older clients reject the newer schema.

The actual completed Task from the subscription audit migrated from its existing
JSON record into SQLite and replayed successfully without credentials or new
model calls. Verification: 33 storage tests, 32 focused database/Task tests and
backend typechecking passed. The schema-six upgrade regression covers retained
results, changed authoritative content and deletion without resurrection.

## Hosted Ace read-only readiness audit

Authenticated read-only requests to the existing hosted account returned HTTP
200 for managed usage and Wallet status. The usage window contains 55 managed
calls and nonzero billed amounts; its recent-call rows expose usage IDs but omit
HTTP call IDs, hold IDs and task/session relationships. These aggregate amounts
do not prove a specific task receipt. The Wallet has available funds, auto-reload
is disabled and no payment method is configured. No new inference, reload,
payment or account mutation was requested.

The scoped receipt lookup returned HTTP 404 for a content-free nonexistent call
ID. The route is a read-only lookup despite using POST. Together with the earlier
health 404, this confirms that the hosted deployment does not yet expose the
local acceptance endpoints. Generating a paid managed call alone would not close
this receipt verification gap. Account-specific response snapshots remain private
in temporary files; no account credential or balance is committed.

Dashboard's deployment workflow requires an exact reviewed commit reachable
from main and successful push CI at that same SHA. The local Dashboard branch
contains four commits beyond origin/main, ending at `83ae327f`; no push, merge or
production deployment was performed. The release path is to review those changes,
squash merge after required checks, and explicitly promote the resulting main
commit using the existing workflow. Then verify scoped receipt and health
availability before doing the remaining real Ace audit.

## Live model-selected delegation

A subsequent subscription audit used SessionPrompt for the parent as well as
the child. The live parent model selected the Task tool exactly once, dispatched
`audit-worker`, received its completed result and finished its own turn. The
parent was limited to three iterations, the worker to one, other tools were
denied and the run had a 90-second cancellation bound. This closes the prepared
parent limitation of the earlier Task audit.

The root audit retained two sessions and five distinct completed HTTP calls,
including internal work. Each call's provider request identity and all nullable
reported token dimensions matched its server projection. Every call retained
subscription cost with a null amount. Logging health was healthy and the copied
credential was removed after execution. No paid route or payment method was used.
Assertions remain in `live-task-verified.json` in the isolated subscription audit
directory. Raw-stream comparison was not repeated for every call in this run;
the earlier bounded provider observations remain separate evidence.

All 90 broader storage/trace/receipt/billing regressions pass on schema 7.
Background cancellation, mixed-route live execution and hosted Ace receipt
acceptance remain outstanding.

## Real child cancellation and unfinished-work visibility

A real subscription child was cancelled after its HTTP attempt became durably
pending. Its final local outcome was cancelled, with no fabricated usage, cost
or response status. The server retained both its dispatch and cancellation event
under the same HTTP call identity. The independently running internal summary
completed with 542 input, 10 output and zero reasoning/cache counters. The audit
waited for those terminal outcomes before flushing and inspecting evidence.
The provider credential was removed afterward.

The first cancellation probe exited its process while its summary was still
running. That older summary remains pending in the durable call records and
server health. The later probe does not rewrite it into a success or invent token
counts. Consequently the combined historical health status is incomplete, with
one pending call, rather than healthy. This is genuine unfinished-work evidence
from the audit process exit, not a claimed cancellation failure in the repeated
run. Content-free evidence is in `cancelled-child-settled-evidence.json` in the
isolated subscription audit directory.

This checks real child cancellation through SessionPrompt. It does not yet
exercise a background Task's parent notification or mixed access routes.

## Real background Task completion and parent notification

A live subscription parent selected one Task with background enabled. The child
completed independently, delivered its completed result as a synthetic parent
message, and the parent answered that notification. The audit waited for the
notification reply and all call outcomes before inspecting records. The parent's
tool part retained its completed background metadata and stable child job ID.

The root audit contains two sessions and six completed HTTP calls, covering
parent dispatch, child work, internal summaries and notification handling. Every
reported token dimension and provider request ID matches its server projection.
All costs remain unallocated subscription amounts. The copied provider credential
was removed. Assertions are retained in `background-task-verified.json` in the
isolated subscription audit directory. Historical health still includes the
previous deliberately retained pending summary from the earlier process exit.

This closes real background completion and parent-notification coverage; a live
mixed-provider task and hosted Ace receipts remain outstanding.

## Live subscription parent with a BYOK child

A live subscription parent selected a Task configured for the OpenRouter free
Liquid model. The parent processed the child result and finished. The root audit
retained two sessions, four completed HTTP calls across subscription and BYOK
routes, and one failed internal attempt. Successful local records matched every
reported token dimension and provider request identity in their server projections.

The BYOK child reported 1,489 input, 256 output, 151 reasoning and zero cache
read/write tokens. Its raw provider response confirmed those counts and explicit
zero cost. The output was capped at 256 tokens; bounded accounting does not prove
a full unrestricted answer. Its provider-response cost stays separate from the
parent's null subscription allocation. No combined bill is fabricated.

The request guard required the exact free model, zero prompt/completion maximum
prices and disabled fallback. An independent internal summary selected a paid
Haiku model; the guard rejected it before network dispatch. That attempted call
is retained locally and on the server as failed with unknown usage and cost.
It is not claimed as a provider-billed zero. The copied credentials were removed.
Assertions remain in `mixed-task-verified.json` in the isolated subscription
audit directory. This closes live subscription/BYOK task routing coverage, not
Ace mixing, nonzero billing or hosted receipt acceptance.

## Final schema-7 packaging checks

The final native `bun run build --single` completed successfully. Its packaged
`stats --days 1 --models` command opened the real schema-7 subscription/mixed-route
audit database successfully and displayed provider-reported zero as partial,
subscription covered as not allocated, and the blocked paid-summary attempt as
unknown. Data-root, relocation and storage-route checks passed: 72 tests, one
skipped, no failures. The pending hosted release question does not authorize
a push or deployment by silence.

## Real local Ace inference and Wallet receipt (2026-10-20)

The configured shared OpenRouter key passed a read-only account check. A new
local Dashboard API used an isolated SQLite clone, a temporary Personal API
key, $1 of promotional credit and auto reload disabled. No original Wallet,
database or production account was changed. A direct managed request settled
and produced a scoped receipt for 8 microUSD.

OpenScience then sent a real managed streaming request to
`z-ai/glm-5.3-flash`. It retained one completed HTTP call, its provider
generation ID and Ace hold, and uploaded the reported 32 input, 32 output,
36 reasoning, zero cache-read and zero cache-write tokens to the local server.
The patched Dashboard proxy settled that same hold immediately; the
`llm_usage` row retained all five token dimensions, provider cost 9 microUSD
after rounding and exact Wallet charge 10 microUSD. The authenticated scoped
receipt returned `settled` and the same 10-microUSD charge. The short response
exhausted its output limit during reasoning, so it proves accounting and
settlement, not answer quality.

This test exposed that OpenRouter can report reasoning tokens greater than
`completion_tokens` for this model. The Dashboard proxy previously rejected
those details before settlement. Its token parsing now preserves the reported
values and charges from the provider's explicit cost; a regression test covers
the provider shape. Earlier isolated attempts remain in the test database,
including one hold that waited for the generation reconciler after an immediate
generation lookup returned 404. The reconciler later settled that hold. A fresh
health check reports three completed managed calls and three settled holds, with
zero pending, token mismatches or charge mismatches; status is `healthy`.
Hosted receipts and health still return 404 until the Dashboard branch is
reviewed, deployed and verified there. Mixed Ace/BYOK delegation remains open.

## Real Ace parent and worker Task (2026-10-20)

A managed Ace parent selected one Task with a managed Ace worker. A fresh
isolated OpenScience installation retained two sessions and five completed
HTTP calls, including parent, worker and internal summary calls. Each call
kept its managed route, provider generation ID and hold ID. The first local
attempt exposed a route-classification bug: a loopback Dashboard proxy was
labelled `local` even though it created Wallet holds. The access-route fix
classifies the managed credential before checking the proxy URL.

In the clean rerun, every provider-reported input, output, reasoning, cache-read
and cache-write count matched the `llm_usage` row for its hold. Five scoped
Wallet receipts returned `settled` with exact charges of 700, 643, 224, 252
and 136 microUSD (1,955 microUSD total). Server health for this installation
reported five completed attempts, five managed responses, five settled holds,
zero pending holds and zero token or charge mismatches. The worker Task finished.
This verifies real local Ace parent/worker accounting, including cached input;
hosted release still needs acceptance.

## Mixed Ace parent and direct API-key worker (2026-10-20)

A fresh isolated installation used the managed OpenRouter provider for its
parent and a separate direct OpenRouter provider alias for its BYOK worker.
Read-only route preflight identified `managed` for the parent and `byok` for
the worker. The parent selected one Task, the worker completed, and the root
audit retained two sessions and five completed HTTP calls. Three managed calls
have settled Wallet holds and scoped receipts of 700, 251 and 107 microUSD.
The two BYOK worker calls have no Wallet holds or managed-call links. The local
server projected all five responses; health reported three settled managed
responses, zero pending and zero token or charge mismatches. This tests both
routes in one delegated task without treating BYOK cost as Wallet spend.

OpenRouter's read-only generation records for both BYOK calls matched their
provider-reported costs and all available native token counters. The records
reported model `z-ai/glm-5.3-flash-20260826` while the requests used
`z-ai/glm-5.3-flash`; the normalized import kept both names. Both billing
records matched unique local call IDs. The two costs total `$0.000289264`.
Settings Usage retained that amount separately as provider-response evidence
and imported billing evidence, with two known calls and no unknown amount.
The fresh local workspace browser showed `Provider reported: $0.000289264` and
`Imported billing: $0.000289264` as separate totals and model-row categories.
Its import panel reported two matched, zero unmatched and zero ambiguous
records. The normalized JSON was imported through the same `BillingImport`
service used by the settings API; the browser's native file picker was not
driven. These generation records are provider account metadata, not an
independently downloaded invoice. Hosted release and native file-picker
acceptance remain open.

## Release-candidate checks (2026-10-20)

The Dashboard backend suite passed with 2,880 tests passed and 142 skipped.
The frontend suite passed 433 tests across 71 files. The production frontend
build passed, and the SQLite/PostgreSQL migration comparison matched 103
tables. Review of the OpenScience and Dashboard changes found one actionable
failure path: an OAuth structured-output error could record the same failed
model call twice. The OpenScience source now handles that error once; the new
regression test and all 44 agent tests pass, as does repository typecheck. The
full OpenScience backend run finished with 5,209 passed, 66 skipped and four
failed. Three failures passed when run alone: a Modal output-recovery timeout,
a folder-authority test and an authority watcher. The remaining failure was
a stale assertion that expected session JSON files after the shared-database
migration. The test now checks the authoritative database and its six-server
run passes. The UI (386), workspace (1,237), SDK (31) and docs (8) test suites
pass. The single-file native build passes. The full backend suite has not been
rerun after the test correction.

The hosted Dashboard liveness path `/api/health` returned HTTP 200, while
`/api/v1/telemetry/health` returned HTTP 404. Hosted receipt, telemetry and
billing acceptance therefore remain open.

## Billing file-input acceptance (2026-10-20)

An isolated Chrome test selected a normalized JSON billing file in Settings →
Usage → API keys. The real local server saved its charge as unmatched evidence.
The record remained visible after page reload and disappeared after removal.
This verifies the browser file input, request, persistence and removal path
without a live provider key or Wallet charge. It does not verify an operating
system file dialog, an independent provider invoice or the hosted release.

## Phase 1 completion audit (2026-10-25)

OpenScience source is pinned to `d720862157d146d52b6faae1e5aff9d3973ed918`
(merged PR #1007). The earlier worktree tip `ec287fed` has the same tracked
content. The Phase 1 branch is `codex/usage-tracking-phase1`. Dashboard's local
HEAD is `93b56986a58d2e4121530ebb01a6cf4a8aa905f1`; its tracked tree is identical
to `origin/main` at `0cc9b3ce7dfc633f120f04ad816cb06b318d67d7`. Both repositories
were clean at the baseline. No production promotion, new paid inference, or
production data mutation was performed for this audit.

The real-run artifacts described above are still present. A fresh read-only
comparison joined their local model-call records to stored server usage,
provider request IDs, holds, usage rows and debit transactions. It covered
**34 unique HTTP attempts: 28 completed, three failed, two cancelled and one
pending**. All 28 completed calls have exact saved server projections for every
reported token field and provider request ID. All eight managed calls have
settled holds, exact native token vectors, and matching Wallet debit amounts.
Identical records in a database backup are compared once, by stable usage ID;
they are not treated as extra calls or fresh server deliveries.

These are carried real-provider observations checked again against saved data,
not new live-provider requests. The saved raw-field and generation comparisons
remain separate evidence; this audit did not fetch a new provider invoice or
repeat a raw-stream capture for every call.

| Case                                                   | State               | Evidence and remaining limit                                                                                                                                                    |
| ------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT sign-in/subscription                           | Verified locally    | Raw final usage and saved projection agree; costs remain unallocated subscription amounts.                                                                                      |
| Direct BYOK                                            | Verified locally    | Native fields, explicit provider zero, two retained HTTP 400 failures and nonzero mixed-worker calls are retained. Independent billing evidence is missing.                     |
| Managed Ace parent/worker                              | Verified locally    | Five calls, five exact settled holds/debits, provider comparisons and healthy saved scoped report.                                                                              |
| Mixed Ace/BYOK delegation                              | Verified locally    | Three Ace receipts and two direct BYOK calls; no Wallet holds on the BYOK calls.                                                                                                |
| Internal summaries and foreground/background Task work | Verified locally    | Stable root/child identity, completed summaries, parent notification and saved projections.                                                                                     |
| Cancellation/process interruption                      | Verified locally    | Cancelled attempts have no fabricated usage; one older interrupted summary remains pending and health remains incomplete.                                                       |
| Retries, compaction and local/custom routes            | Controlled coverage | Current tests cover retries and compaction; all six route labels have fixture coverage. This does not establish live-provider coverage for every label or provider combination. |
| Independent provider billing                           | Missing             | No local export was found. OpenRouter's read-only activity API returned HTTP 403 with the configured key. Generation metadata is not substituted for a bill.                    |
| Hosted receipt and logging health                      | Missing             | Last hosted checks returned HTTP 404. This phase does not authorize deployment or repeat hosted mutation checks.                                                                |

### Redacted call inventory

The short identifiers below are the first ten SHA-256 hexadecimal characters
of the original identities; they allow correlation without publishing raw
request, hold or ledger IDs. `I/O/R/CR/CW` means input/output/reasoning/cache-read/
cache-write. `?` means unknown. `exact` means the persisted server projection
matches the saved provider fields, not that every stream was observed again.
Wallet amounts are ledger debits in micro-USD. A provider-reported BYOK zero or
subscription coverage is not a zero Wallet receipt.

| Audit               | Call hash  | Provider ID hash | Route   | Outcome   | I/O/R/CR/CW        | Server       | Hold hash  | Wallet outcome            | Ledger hash |
| ------------------- | ---------- | ---------------- | ------- | --------- | ------------------ | ------------ | ---------- | ------------------------- | ----------- |
| subscription-fields | 561809537c | 0238608fd1       | chatgpt | completed | 33/5/0/0/0         | exact        | —          | subscription; unallocated | —           |
| subscription-worker | ca67489dbb | 9a82b63edd       | chatgpt | completed | 561/10/0/0/0       | exact        | —          | subscription; unallocated | —           |
| subscription-worker | 589da7c0dc | ae0acceb85       | chatgpt | completed | 547/9/0/0/0        | exact        | —          | subscription; unallocated | —           |
| subscription-worker | ea1ccb6a78 | 00373f728e       | chatgpt | completed | 4477/21/14/0/0     | exact        | —          | subscription; unallocated | —           |
| subscription-worker | e0e2435fff | 94d09f6a0d       | chatgpt | completed | 1795/37/0/0/0      | exact        | —          | subscription; unallocated | —           |
| subscription-worker | 08d99dd72e | d7fac6dd17       | chatgpt | completed | 1916/5/0/1664/0    | exact        | —          | subscription; unallocated | —           |
| cancellation-first  | 54b59734dd | —                | chatgpt | cancelled | ?/?/?/?/?          | attempt only | —          | subscription; unallocated | —           |
| cancellation-first  | 5273562a1c | —                | chatgpt | pending   | ?/?/?/?/?          | attempt only | —          | subscription; unallocated | —           |
| cancellation        | 0aca52c272 | —                | chatgpt | cancelled | ?/?/?/?/?          | attempt only | —          | subscription; unallocated | —           |
| cancellation        | cda2e9d84f | e56bed1415       | chatgpt | completed | 542/10/0/0/0       | exact        | —          | subscription; unallocated | —           |
| background-worker   | 76584fb53b | ca25eb90c5       | chatgpt | completed | 567/8/0/0/0        | exact        | —          | subscription; unallocated | —           |
| background-worker   | c7ec2e1816 | 829c421fb0       | chatgpt | completed | 1826/36/0/0/0      | exact        | —          | subscription; unallocated | —           |
| background-worker   | dc347872f0 | 49faab1fdc       | chatgpt | completed | 542/9/0/0/0        | exact        | —          | subscription; unallocated | —           |
| background-worker   | 4f6c7573fc | 781f4518fd       | chatgpt | completed | 2027/5/0/1664/0    | exact        | —          | subscription; unallocated | —           |
| background-worker   | c0ce12dae7 | 1f9aea3f5b       | chatgpt | completed | 4475/24/17/0/0     | exact        | —          | subscription; unallocated | —           |
| background-worker   | 906173a0d6 | 8547c8541f       | chatgpt | completed | 2114/5/0/1920/0    | exact        | —          | subscription; unallocated | —           |
| subscription-BYOK   | bbc381bc56 | 247cc45f9f       | chatgpt | completed | 561/13/0/0/0       | exact        | —          | subscription; unallocated | —           |
| subscription-BYOK   | e9315453b4 | —                | byok    | failed    | ?/?/?/?/?          | attempt only | —          | no Wallet hold            | —           |
| subscription-BYOK   | eccdd560ea | d879308e4c       | byok    | completed | 1489/256/151/0/0   | exact        | —          | no Wallet hold            | —           |
| subscription-BYOK   | 2d06395450 | b7409eb3f3       | chatgpt | completed | 1802/33/0/0/0      | exact        | —          | subscription; unallocated | —           |
| subscription-BYOK   | baf43dab79 | c37be053f2       | chatgpt | completed | 2021/5/0/1664/0    | exact        | —          | subscription; unallocated | —           |
| BYOK-fields         | 5968de2cda | 21a915e16d       | byok    | failed    | ?/?/?/?/?          | attempt only | —          | no Wallet hold            | —           |
| BYOK-fields         | 2ae27b8f51 | 17e2a0308c       | byok    | failed    | ?/?/?/?/?          | attempt only | —          | no Wallet hold            | —           |
| BYOK-fields         | d801f83aef | a1853b4a4b       | byok    | completed | 34/32/32/0/0       | exact        | —          | no Wallet hold            | —           |
| Ace-worker          | 1876de5dc0 | ddc036bfc5       | managed | completed | 608/11/0/0/0       | exact        | b41dcd53cf | 700 µUSD                  | 93bbe41263  |
| Ace-worker          | 852c827592 | 81f322cade       | managed | completed | 589/4/0/0/0        | exact        | fbbb2d9c76 | 643 µUSD                  | bae598728a  |
| Ace-worker          | cb75d6d409 | 2f510080d2       | managed | completed | 1376/552/312/0/0   | exact        | 073b0a7fd1 | 224 µUSD                  | cde06f142e  |
| Ace-worker          | 7e4c33d758 | 0414190ac3       | managed | completed | 2128/119/57/1024/0 | exact        | 370242f385 | 252 µUSD                  | 92f040b1bc  |
| Ace-worker          | 19d14902e5 | c79d8a7aab       | managed | completed | 2593/28/24/2048/0  | exact        | a4ca74f999 | 136 µUSD                  | 8c02ec0fd7  |
| Ace-BYOK            | 2ebc681c77 | 1b8ee66914       | managed | completed | 608/11/0/0/0       | exact        | 62296fa360 | 700 µUSD                  | 6637322d35  |
| Ace-BYOK            | 5b92380a60 | 1525b920a8       | byok    | completed | 540/20/15/0/0      | exact        | —          | no Wallet hold            | —           |
| Ace-BYOK            | 9105299a4d | a4c8081484       | byok    | completed | 1392/128/128/0/0   | exact        | —          | no Wallet hold            | —           |
| Ace-BYOK            | eb3193fa3b | b7471df389       | managed | completed | 2140/113/51/1024/0 | exact        | 48d8627597 | 251 µUSD                  | 3db20f5fe3  |
| Ace-BYOK            | 44545adc07 | ded26162da       | managed | completed | 2363/45/42/2048/0  | exact        | 0ed2035c88 | 107 µUSD                  | 167672a0cc  |

### Fresh Phase 1 verification

All commands used pinned Bun 1.3.14, an environment with provider credentials
removed, and test-controlled data roots. The following are new runs against
`d7208621`, rather than reused test totals:

| Check                                                | Command / result                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused trace/billing/database/Task tests            | From `backend/cli`: `bun test --timeout 15000 ./test/session/billing-import.test.ts ./test/session/model-call-trace.test.ts ./test/session/trace-queue.test.ts ./test/session/usage-logging.test.ts ./test/session/usage-accounting.test.ts ./test/session/logging-health.test.ts ./test/session/trace-database.test.ts ./test/storage/database.test.ts ./test/storage/migration-damaged-record.test.ts ./test/tool/task-attempt-process.test.ts` — 127 passed, zero failed. |
| Adjacent provider/receipt/data-root/stats/API checks | Eight discovered files across provider cache writes, OpenRouter cache usage, call audit, receipts, managed data root, CLI data-root scope/stats, and settings usage — 116 passed, one Windows-only skip, zero failed.                                                                                                                                                                                                                                                        |
| Relevant backend directories                         | From `backend/cli`: `bun test --timeout 15000 ./test/session ./test/storage ./test/provider ./test/cli ./test/global` — 1,653 passed, three skipped, zero failed.                                                                                                                                                                                                                                                                                                            |
| Workspace unit tests                                 | `bun run test:workspace` — 1,237 passed, zero failed.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Typecheck                                            | `bun run typecheck` — seven packages passed through Turbo cache.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Native build                                         | `bun run build --single` — exited 0; output `backend/cli/dist/@synsci/openscience-linux-x64/bin/openscience`. Existing CSS build warnings remain.                                                                                                                                                                                                                                                                                                                            |
| Billing browser file input                           | `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/google-chrome-stable bun run --cwd frontend/workspace test:e2e -- billing-imports.spec.ts` — one passed against its isolated local server.                                                                                                                                                                                                                                                                                     |
| Copied real Task replay                              | Copied schema-7 database plus project metadata; two identical Task replays retained two HTTP calls and two sessions, returned the saved result, and made no new calls. No credentials were copied and network dispatch was forbidden.                                                                                                                                                                                                                                        |
| Queue acknowledgement after restart                  | Three separate Bun processes dispatched, replayed, then acknowledged the earlier delivery. The event ID stayed stable: one stored event, one delivered count, zero queued events.                                                                                                                                                                                                                                                                                            |
| Copied nonzero billing records                       | Reimporting the two saved generation-derived records twice retained two unique matches and exact decimal amounts `0.000216704` and `0.00007256` USD. This proves local idempotent matching, not independent billing.                                                                                                                                                                                                                                                         |

The final independent review requested a fresh combined privacy/receipt check.
A disposable local probe captured a context before opt-out, disabled sharing,
and attempted to record through that stale context on all six route labels.
It observed zero telemetry requests and zero queued payloads. While sharing
remained off, the same account made one authenticated, workspace-pinned receipt
request and received the exact `123` micro-USD synthetic fixture receipt.
This closes the combined assertion without claiming a new real charge or hosted
acceptance. The probe is retained as `privacy-receipt.ts` and its output as
`privacy-receipt.log` in the execution workspace.

The broader backend skips were the fully reparented token-helper daemon test,
the opt-in live models.dev catalog test, and the native Windows junction test.
They are not claimed as verified on this Linux host. The original subscription
audit database's SHA-256 stayed unchanged during copied-data verification.
No product defect was found in these checks and no product code changed.

Existing behavior assertions used for the spec include dispatch-before-network,
separate retry identities, failed/cancelled attempts without fabricated usage,
nullable provider counts, lost-ack receiver deduplication, all six route labels,
in-flight opt-out, raw partial reasoning, atomic legacy import, rollback,
concurrent writes, deletion history, explicit ambiguous recovery, and schema-6
Task migration. `Usage.component.test.ts` checks separate cost sources and CSV;
`UsageLogging.component.test.ts` checks incomplete coverage and old-server
unavailability. The fresh cross-process queue probe adds direct restart evidence
to the existing deduplication and concurrent-producer assertions.

### Phase 1 result before management-key access

Task 1 (baseline and route inventory) and Task 3 (current regression checks)
are complete. Task 2 has functional import coverage, but remains **pending**:
there is no independent nonzero billing source with a unique request identity.
The configured key returned HTTP 403 from the read-only activity query for
2026-10-20; the [OpenRouter activity API](https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity)
requires a management key. No management key was created and no permission was
changed. The user has been asked for an existing export path or read-only source.
Aggregate billing without request identity must remain unmatched.

Phase 1 as a whole is therefore **partial**, not complete. None of the seven
roadmap items is marked shipped from these local results. Phase 2 has not started;
hosted release and deployment remain unauthorized. Command logs, the read-only
comparison script, copied-data probes and original-input hash are retained under
`.superpowers/sdd/2026-10-25-usage-tracking-completion/` in this worktree. The
private `/tmp/roadmap-*` artifacts remain local and may be lost on cleanup; only
the redacted result and inventory above are durable repository evidence.

## Fresh-account test key acceptance (2026-10-25)

The newly supplied direct OpenRouter test key passed a read-only authentication
check. A separate local data root then completed one bounded
`qwen/qwen3.8-flash` request through OpenScience's real LLM and durable attempt
path. The answer was `OK`. Raw provider usage and the saved call agree on
27 input, one output, 28 total, zero reasoning, zero cache-read and zero
cache-write tokens. The provider request identity matches, and the exact
provider-reported amount is **USD 0.00000452** (call hash `8f13038d39`).
The request had a 32-token output cap, no tools or retries, disabled provider
fallbacks, and explicit prompt/completion price caps. No production account
trace or managed Wallet charge is claimed from this signed-out local audit.

Two earlier `openai/gpt-4.1-nano` HTTP 404 attempts remain stored as failed with
unknown usage and cost. A deprecated-model selection was rejected locally
before dispatch and is not counted as an HTTP attempt. The new audit database
therefore contains three HTTP attempts, with one completed. No failed record
was cleared to obtain that result. The existing 34-call inventory above keeps
its original scope and does not include this new isolated account.

Independent request-level billing remains pending. The management key is still
absent, and the first post-call aggregate key-usage read had not yet reflected
the small provider amount. This is not treated as proof of either a zero bill
or a mismatch. A website export or account analytics record containing this
request identity and its charge is still needed. The private raw observation,
request guard and saved call are under the data root named by
`.superpowers/sdd/2026-10-25-usage-tracking-completion/fresh-account-root`.

## Independent account billing and second test round (2026-10-25)

The supplied management key passed `GET /api/v1/analytics/meta` with HTTP 200.
Read-only `POST /api/v1/analytics/query` calls then retrieved account-side
`credits_usage` for each real test generation. Each query used an exact
`generation_id` filter, `generation_id` and `model` dimensions, a bounded UTC
time range, and minute granularity. Each returned one row with `request_count`
1 and `truncated: false`. The returned `created_at__minute` bucket was retained
as the source date, normalized to ISO 8601 UTC; it is not represented as an
exact request timestamp. Raw responses remain private and unchanged.

| Call hash    | Generation hash | Provider-response USD | Account-reported credits usage USD | Account minus provider USD |
| ------------ | --------------- | --------------------- | ---------------------------------- | -------------------------- |
| `8f13038d39` | `6338bac521`    | `0.00000452`          | `0.000004`                         | `-0.00000052`              |
| `b7bc62d3f0` | `b977d1ba82`    | `0.00000452`          | `0.000004`                         | `-0.00000052`              |

Source response SHA-256 values are
`24077e74371c09c4784377edf1f3c7d53849e3c329e37ad65b6e63a2ba00d6a3` and
`5065c398a3f4dad4531a40c14a9c9e01fe1e997f0ec32c36b8b15d680aa44d77`. The source contains a positive account-reported credits
amount for each unique request. It is independent of the completion response
and the generation metadata lookup. The reason for the sub-microdollar
source difference was not established. No rounding rule, refund, charge
correction, or final invoice amount is inferred from it.

The first document passed the real Settings Usage import/export API in a
copied database. It matched one real call, retained exact source decimals,
deduplicated reimport, exported match status, and removed imported evidence
without changing the provider record. No model request was made while testing
the importer. This supplies the independent nonzero read-only account evidence
allowed by spec §5; it does not claim an invoice export.

At the user's request, a second bounded real Qwen call then returned `OK`.
It again retained 27 input, one output, zero reasoning, zero cache-read and
zero cache-write tokens, and USD 0.00000452 in both the raw response and local
call. It has a different HTTP and provider generation identity. Original
first-round artifacts were preserved, and a new disposable data root was used.
No hosted Dashboard deployment or production Wallet mutation was involved.

The two real records were normalized into one billing document and exercised
through fresh copied data in a second test round:

- Two separate Bun processes verified save/reopen persistence, exact unique
  matching, duplicate and overlapping imports, atomic HTTP 409 conflicts,
  deliberately ambiguous account labels, removal of that collision, and
  removal without losing shared imported records or provider evidence.
- The resulting Qwen row retained **provider reported USD 0.00000904** and
  **imported billing USD 0.000008** separately, with two model calls. The
  two equal-cost account records matched two distinct call IDs; matching did
  not use their amounts as identities.
- An isolated Chrome test selected the actual two-record normalized document
  through Settings Usage's file input. The browser showed **2 matched / 0
  unmatched / 0 ambiguous**, kept both source totals separate, deduplicated
  repeat file selection, exported two unique reconciled calls, retained the
  records after page reload, and removed the import without changing provider
  totals. The source data copy was supplied to the existing isolated E2E
  harness; all provider credentials were omitted from the browser/server test.
- Fresh focused backend checks passed **101 tests across seven files**, zero
  failures. They cover billing imports, usage accounting, model-call tracing,
  trace queue, usage logging, receipts and Settings Usage. The actual-document
  browser test passed **one test**. Earlier in this continuation, the billing/
  accounting/Settings tests passed 48 tests and the existing synthetic-file
  browser test also passed. These overlapping runs are not added together as
  a count of unique tests.

Private evidence and probes are retained in the execution workspace:
`account-billing-query.py`, `private-account-billing.json`,
`second-account-billing.json`, `two-account-records.json`,
`account-billing-import.log`, `second-import.log`,
`second-round-regressions.log`, `second-real-browser.log`,
`second-browser-export.json` and `second-browser.png`. The temporary browser
spec was archived as `second-browser.spec.ts` and removed from the source test
directory after execution. The raw reports and local credential file are not
committed. No product code changed.

### Current Phase 1 result

**Phase 1 is complete for the approved plan's Tasks 1–3.** Baseline inventory,
independent billing evidence and the regression checks now have local evidence.
The earlier missing-source and HTTP 403 notes remain historical observations;
the management key and new account reports close that dependency. This does
not close the seven roadmap checkboxes. The subsequent Phase 2 result is
recorded below; release-candidate and hosted checks remain separate. No release,
merge or production deployment is authorized.

## Read-only amount-difference check (2026-10-25)

A further check queried both existing generations, the same test API key's
usage total, and Analytics for those exact generation IDs both separately and
combined. No new inference was requested.

| Source for the two test calls                                    | Reported total USD |
| ---------------------------------------------------------------- | ------------------ |
| Raw completion responses saved by OpenScience                    | 0.00000904         |
| OpenRouter individual generation records, summed                 | 0.00000904         |
| OpenRouter test API-key usage                                    | 0.00000904         |
| OpenRouter Analytics `credits_usage`, per-generation rows summed | 0.000008           |
| OpenRouter Analytics `credits_usage`, one combined query         | 0.000008           |

Both generation lookups also agree with the saved native input/output counts
(27/1 per call). The exact test-key usage total now agrees with both full
provider amounts, unlike the earlier stale aggregate read. The lower values
are already in the original Analytics JSON; OpenScience's importer and export
preserve them without changing decimals.

This isolates the difference to OpenRouter's Analytics reporting path. The
observed values are consistent with loss of sub-microdollar precision there,
but the exact conversion rule has not been confirmed. It does not establish
a final invoice adjustment or a refund. For these two calls there is no amount
loss in OpenScience: its stored values match the responses, generation records
and key-usage total. No product-code change is indicated by this check.

The original independent-report imports remain USD 0.000008 in total, since
that is what their source returned. They are not rewritten to USD 0.00000904.
Private read-only observations are retained in `amount-investigation.json`
and the `private-amount-*.json` files in the execution workspace. Account-wide
credit totals were not used to attribute these two calls and are not published.

## Account CSV and displayed cost (2026-10-25)

The user's original `openrouter_activity_2026-10-25.csv` contains exactly the
two test generation IDs, each with 27 input, one output, zero reasoning and
zero cached tokens. Its `cost_total` is USD 0.000004 per call, matching the
Analytics account records. The OpenRouter activity screenshot shows USD
0.00000452 per call, matching the raw responses, generation records and local
records. The CSV SHA-256 is
`8fd95a7a1c5a74125c29378147280443b00abb736f0a629a404567483c6955f5`.
The file was read without modification and remains outside Git.

The user accepted the USD 0.00000104 total difference for this verification.
This does not authorize discarding provider precision or using a tolerance to
change charges or refunds. Both source amounts remain separate. Truncation to
six decimal places would explain the exported values, but the upstream method
is unconfirmed.

## Phase 2 cross-service local acceptance (2026-10-25)

OpenScience source remains at merged baseline `d720862157d146d52b6faae1e5aff9d3973ed918`
(evidence branch parent `aaf3e414`); Dashboard runs source `93b56986a58d2e4121530ebb01a6cf4a8aa905f1`.
The Dashboard tree is identical to its recorded merged `origin/main` baseline.
No product code changed for this phase.

A separate loopback Dashboard API used a new disposable SQLite database,
account, workspace-pinned API key, USD 1 of synthetic local promotional credit,
and disabled auto reload. OpenScience used a consistent backup of the earlier
disposable research database. Source-file hashes remained unchanged. Neither
the user's original data nor production Wallet was used. The real upstream
key was passed only to the isolated Dashboard process. Provider requests were
limited to Qwen 3.8 Flash, 512 output tokens, eight requests and a conservative
USD 0.02 aggregate input/output bound; Dashboard's reviewed upstream price
filter remained active. Five requests ran, below the bound.

The live parent selected the Task tool once. Its managed worker completed;
the parent finished. The two sessions retained five completed managed HTTP
calls, including internal work. Each raw response matched the local provider
generation identity, six-field usage vector and provider cost. Read-only
OpenRouter generation lookups independently matched all five costs and native
input/output/reasoning counters. The local call, unique server usage projection,
managed call link, hold, exact usage receipt and Wallet debit were joined for
every call. The five settled receipts total **858 microUSD (USD 0.000858)**.
Their separate provider costs total **USD 0.000812082**.

| Call ID SHA-256 prefix | Session         | Provider request SHA-256 prefix | Input | Output | Reasoning | Cache read | Cache write | Provider USD | Settled microUSD |
| ---------------------- | --------------- | ------------------------------- | ----- | ------ | --------- | ---------- | ----------- | ------------ | ---------------- |
| c74ab8f948             | Parent/internal | c92bc409e3                      | 581   | 8      | 0         | 512        | 0           | 0.000022302  | 24               |
| cefb14e77e             | Worker          | 545c015786                      | 564   | 4      | 0         | 512        | 0           | 0.000017872  | 19               |
| 6e5b6f87ca             | Worker/internal | 4b6b069190                      | 1454  | 237    | 0         | 0          | 0           | 0.00032949   | 348              |
| 2f65f4cc1a             | Parent/internal | c657296dc1                      | 2096  | 59     | 0         | 0          | 0           | 0.00034213   | 361              |
| 53929f5fbb             | Parent/internal | b9ce47210f                      | 2495  | 1      | 0         | 2048       | 0           | 0.000100288  | 106              |

The health response reported five dispatched/completed calls, five responses,
five projections and five settled holds. Pending calls/holds, missing links,
token mismatches and charge mismatches were all zero. The device queue was
empty. Turning sharing off retained identical scoped receipts and their exact
total; delivered event counts did not increase during that receipt lookup.

Faults were injected one at a time into another database copy, then rolled
back. The healthy baseline returned after each rollback:

| Fault                         | Observed status | Exact diagnostic                     |
| ----------------------------- | --------------- | ------------------------------------ |
| One missing usage projection  | attention       | `usage.missing_projection = 1`       |
| One rejected delivery receipt | attention       | `receipts.anomalous = 1`             |
| One pending, unsettled hold   | incomplete      | `managed.pending = 1`                |
| One accepted receipt only     | attention       | `receipts.receipt_only = 1`          |
| One different input count     | attention       | `managed.token_mismatch = 1`         |
| One different charge amount   | attention       | `managed.charge_amount_mismatch = 1` |

Pending and inconsistent calls returned four settled receipts plus an explicit
non-settled state for the fifth, without a fabricated zero charge. A released
hold returned `not_charged` and no receipt. A pending hold with a contradictory
settled usage row correctly returned `inconsistent`. Account, workspace and
device scope changes returned no unrelated evidence. Route tests additionally
checked authentication, suspended membership and pinned credentials.

Verification commands, with full private logs in the execution workspace:

- OpenScience `bun test --timeout 15000 ./test/session/task-receipts.test.ts
./test/session/logging-health.test.ts ./test/session/usage-logging.test.ts`:
  **48 passed**, zero failed.
- Dashboard `.venv/bin/python -m pytest tests/test_call_receipts_route.py
tests/test_call_receipts_service.py tests/test_logging_health_route.py
tests/test_logging_health_service.py tests/test_logging_health_audit.py -q`:
  **38 passed**, zero failed; 24 existing UTC datetime deprecation warnings.
- Dashboard PostgreSQL health, managed recovery, settlement, token-correction
  and Wallet concurrency files: **28 passed**, zero failed/skipped, against a
  separate disposable pgvector/PostgreSQL 16 container, removed after testing.
- Workspace receipt and logging-health components plus receipt page tests:
  **17 passed**, zero failed. These counts cover distinct suites; they do not
  include earlier overlapping Phase 1 checks.
- `phase2-verify.py`: raw/local/server field comparisons, exact receipt/debit
  sums, opt-out, source preservation, six isolated faults and scope checks pass.

Two initial harness runs stopped before upstream dispatch: one used unsupported
client routing options, and one had a test monthly limit below the reservation.
Both retained their failed attempts, had zero upstream usage rows, and remain
private. The successful run used a fresh account/database after correcting
those test settings. No product behavior was changed to make the audit pass.

This verifies the SQLite cross-service path and real PostgreSQL adapter
contracts. It does not test hosted Supabase authentication, deployment settings
or deployed routes. Server health still cannot observe rejection before a
receipt is stored; historical unscoped receipts cannot be assigned to a guessed
workspace. Phase 2 is complete locally. Roadmap items #4 and #7 remain Partial
until separately authorized hosted acceptance.

## Phase 3 local candidate checks (2026-10-25)

Both remotes were fetched again. OpenScience `origin/main` remains `d7208621`;
Dashboard `origin/main` remains `0cc9b3ce`, with the local `93b56986` tree
identical to it. The OpenScience review branch changes this acceptance note
only. Dashboard has no candidate code diff. SDK regeneration, user-facing
changelog entries and package version changes are not applicable.

A fresh read-only reviewer checked `d7208621..5fd06202`, independently joined
all five generation/raw/local/server/hold/receipt/debit records, and found no
actionable issue. Its review confirms the evidence boundary; it does not
certify hosted behavior or an upstream invoice conversion rule.

The local commands ran on `5fd06202` with unchanged product source:

| Check                                                         | Result                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bun run check` formatting and typecheck stages               | Passed; seven successful cached typecheck tasks                                                             |
| `bun run check` backend stage                                 | **5,211 passed, 66 skipped, two failed**; the command exited 1 and did not run its later stages             |
| Separate `./test/project` process with Bash                   | **91 passed, one platform skip, zero failed**                                                               |
| `bun run test:ui`                                             | **386 passed**, zero failed                                                                                 |
| `bun run test:workspace`                                      | **1,237 passed**, zero failed                                                                               |
| `bun run test:sdk`                                            | **31 passed**, zero failed                                                                                  |
| `bun run test:docs`                                           | **8 passed**; 70 pages, 981 links, 17 JSON examples and nine TypeScript examples validated                  |
| `bun run build --single`                                      | Passed; workspace bundle and Linux x64 executable built; `--version` returned the local development version |
| Dashboard `.venv/bin/python -m pytest tests/ -q --timeout=30` | **2,880 passed, 142 skipped**, zero failed; existing datetime deprecation warnings remain                   |
| Dashboard SQLite/PostgreSQL migration parity                  | All **103 tables** matched                                                                                  |
| Dashboard `npm test -- --run`                                 | **433 passed**, zero failed                                                                                 |
| Dashboard `npm run build`                                     | Passed TypeScript, production build, UI-copy and distribution checks                                        |

The two monolithic backend failures are retained, not reported as a green
`bun run check`. `AuthoritySignal.watch`'s own-settled-burst test passes alone;
the monolithic run supplied older shared authority state and a resync that
its assertion did not expect. `tooling/repo/test-shards.ts` already declares
the entire project group isolated from other multiprocess groups in Deep CI.
The terminal test also failed in isolation under the inherited Zsh setup,
which points `ZDOTDIR` at the user's interactive configuration. Running the
whole project group in its own process with Bash and without that override
passed both cases. No test assertion or product path was weakened or changed.
The remaining check stages were run separately because the aggregate command
stops at its failed backend stage. The isolated results overlap the aggregate
run and must not be added as unique-test totals.

The native build embeds artifact source `5fd06202ee3b329e211ae83d1d9a22266c383533`;
it is a local development artifact, not a publication. Both tracked trees
remained clean after the builds. Full command outputs and the independent
review record remain in the ignored execution workspace. PR checks and Deep
CI must establish the exact final documentation commit before Phase 3 is
closed. No merge, deployment or release is included in this phase.

## Local services with a Supabase test branch — 2026-10-25

The user chose local Dashboard and isolated OpenScience services connected to
an empty Supabase branch of Dashboard. Fly deployment is deferred. The branch
is persistent, `with_data=false`, and `ACTIVE_HEALTHY`. Its inherited schema
had 51 public tables; current Dashboard migrations passed and the expected
schema hash marker and required usage/receipt tables are present. The resulting
108 public tables include inherited tables; this count is not a new migration
parity result. Only the authorized profile's basic identity fields were copied.
Production records, balances, payment state, consent and credentials were not
copied or changed. The branch has no copied Supabase Auth users.

Dashboard source is `93b56986a58d2e4121530ebb01a6cf4a8aa905f1` (the same tree as
`origin/main` `0cc9b3ce7dfc633f120f04ad816cb06b318d67d7`). OpenScience source is
`f5a858a665e19e83349174a535b1bfe38162a097`; the existing native build uses
`5fd06202ee3b329e211ae83d1d9a22266c383533`, whose later candidate changes are
documentation only. No product source was changed, rebuilt, pushed or released
for this test. All test data and credentials remain in isolated private storage.

The backend uses the branch session pooler on port 5432, because its prepared
statements and session advisory locks require session semantics. Stripe, auto
reload, graph proxy and indexing are disabled. A one-day workspace key and
USD 1 of synthetic promotional credit were created only in the test branch.
The test middleware allows Qwen only, at most eight requests, 512 output tokens
per request and a conservative USD 0.02 allowance. Its counters persist across
the local API restart. Five provider requests used an allowance of 7,138.8
microUSD. No further provider requests were made for the follow-up checks.

**The normal application is not accepted on this local/cloud connection.** The
initial unmodified managed task failed before any upstream dispatch. A direct
database round trip took about 1.1–1.3 seconds; a balance HTTP request took
10.049 seconds. Network and server execution time were not measured separately.
After restoring the backend's normal primary/OAuth pool limits of 12/3, a fresh
unmodified-client probe still recorded these results:

| Read                 | Result                              | Observed elapsed time |
| -------------------- | ----------------------------------- | --------------------- |
| Auth status          | HTTP 200                            | 7,218 ms              |
| Balance              | Timeout, no balance returned        | 8,000 ms              |
| Model catalog        | Aborted, no managed price available | 3,002 ms              |
| Scoped task receipts | HTTP 200, available                 | 4,313 ms              |
| Logging health       | Timeout, unavailable                | 5,001 ms              |

A separate **diagnostic harness** allowed longer deadlines for local account,
catalog and telemetry requests. It did not change product source, financial
rules, authorization, paid chat cancellation or provider limits. Under those
diagnostic conditions, a real parent delegated once to a real worker:

- Two sessions and five completed managed calls had five exact settled receipts.
- Raw provider usage matched all saved token fields, including explicit zeros;
  provider amounts matched local amounts and server projections.
- Every call had one scoped projection and exact call/hold/operation/usage/
  receipt links. Each settled amount matched its actual ledger debit.
- Provider-reported cost totals USD 0.000666922. Test Wallet debits total
  **706 microUSD (USD 0.000706)**. These remain separate sources.
- Receipt lookup with sharing disabled returned the same receipts; delivered
  counts stopped increasing and the queue was empty.
- Missing projection, rejected delivery, pending hold, receipt-only delivery,
  token mismatch and charge mismatch each produced the expected attention or
  incomplete status on the real Supabase branch. Each fault was rolled back,
  and health returned to healthy. Account, workspace and installation scope
  checks passed; unauthenticated HTTP lookup returned 401 and a mismatched
  workspace header returned 403.
- Hash checks confirmed that the original copied source data was unchanged.

The actual local browser opened the recorded session and displayed five
settled receipts, one worker, subtotal USD 0.000706, and zero pending, missing
or inconsistent calls. Dashboard home opened with the copied test profile
after restoring the normal connection-pool limits. Earlier reduced-pool
workspace loading failed. Dashboard Usage was still loading at the last
observation; the OpenScience Usage page showed HTTP 500. The exact server-side
cause of that page error has not been established. These browser cases do not
count as passing acceptance.

Private commands, failures, redacted reconciliation and a local test guide are
retained under the existing execution workspace (`supabase-local-*` and
`supabase-staging/`). The first seed probe used a SQLite integer for a PostgreSQL
boolean; the verification probe initially compared a JSON string to a native
UUID and then used positional columns from the SQLite fixture. These test
harness errors were corrected, the synthetic grant made idempotent, and the
final complete PostgreSQL verification exited successfully. They were not
product defects. No failed run is counted as a pass.

The database diagnostic is complete, but normal-client latency and the browser
page failures remain open. No Fly or production deployment was tested. All
seven roadmap items remain Partial.

## Local Supabase timeout fixes and browser follow-up — 2026-10-25

This follow-up supersedes the open Usage/deadline failures above; the failed
runs remain part of the record. Product fixes are local working-tree changes
based on OpenScience `f5a858a6` and Dashboard `93b56986`. The Dashboard fixes
are isolated on `codex/usage-read-timeouts`. The earlier green PR/CI runs cover
their recorded commits, not these new fixes.

Query profiling showed repeated access and funding reads across a slow database
connection. Dashboard balance now reuses its resolved request-local billing
context and existing aggregate spend query. Balance and model catalog share
one connection with authentication. Workspace receipt/health scope uses one
fresh membership/organization join. Authentication, active membership,
workspace pins and server financial decisions remain authoritative. The
existing telemetry authentication/connection ordering policy is preserved.

OpenScience balance, managed pricing and logging health use the existing
configurable account deadline (15 seconds by default). Pinned managed Usage
reads go directly to the authoritative usage endpoint; legacy unscoped reads
still resolve their workspace within the same deadline. Expiry returns HTTP
503 with no-store, rather than HTTP 500. Dashboard organization Usage has one
30-second attempt; other workspace reads retain their eight-second limits.
A separately reproduced binary floating-point display artifact in the cents
to dollars conversion is corrected with the existing decimal library. This
changes displayed cost evidence, not Wallet settlement or recorded amounts.

The final normal-client probe used no deadline override or diagnostic fetch
extension. All selected reads passed:

| Read                 | Result                           | Observed elapsed time |
| -------------------- | -------------------------------- | --------------------- |
| Auth status          | HTTP 200                         | 14,329 ms             |
| Balance              | HTTP 200, available              | 11,260 ms             |
| Model catalog        | HTTP 200, selected price present | 3,018 ms              |
| Scoped task receipts | HTTP 200, available              | 4,725 ms              |
| Logging health       | HTTP 200, available              | 7,143 ms              |

The rebuilt native managed Usage endpoint returned HTTP 200 in 7,121 ms,
with five calls and 7,039 tokens. The actual Dashboard Usage page loaded five
requests and its model/member breakdown; its rounded Wallet total was
USD 0.0007. The actual OpenScience Usage page also loaded five requests.
The exact ledger/receipt total remains 706 microUSD, separate from provider
cost USD 0.000666922. No additional inference was dispatched for these reads.

Workspace bootstrap remains sensitive to slow responses: one account-context
request took 11,314 ms and exceeded its unchanged eight-second limit. The
normal Try again action succeeded in 3,950 ms, after which Usage loaded.
One authentication SQL read itself took 7,788 ms. Network, pool and server
execution contributions are not separated; these samples do not establish
reliable latency under load or eliminate transient retry requirements.
The original managed task used diagnostic waits. It has not been repeated
with the new native client; the new evidence covers reads of the saved task.

Verification of the timeout fixes: Dashboard backend 2,885 passed / 142 skipped;
Dashboard frontend 435 passed, production build passed; affected OpenScience
backend 647 passed / 2 skipped; SDK 31 passed; docs validation and 8 tests passed;
all seven typechecks, SDK regeneration and native build passed. The decimal
regression then failed with the observed long fraction and passed after the
conversion fix (9 Usage tests). The final rebuilt native endpoint returned
HTTP 200 in 7,172 ms with exact cost evidence `0.000706`. The five real-call
links, scope checks and all six rollback-only Supabase faults also passed
again against the final Dashboard code. Full logs, source-file hashes and the native
binary hash remain in the private execution workspace. A fresh independent
review found no actionable issues. These are local checks; CI for the new
product fixes is still pending. No new full monolithic backend pass is claimed.

Fly and production acceptance remain untested. All seven roadmap items stay
Partial. No push, merge, production data change or release is included.

## Per-call profiling follow-up — 2026-10-25

A new opt-in Dashboard diagnostic profiles the actual account/Usage routes,
authentication, database statements and pool lifecycle. It skips startup jobs
and migrations and verifies read-only test connections after checkout/reset.
It retains no SQL parameters, credential headers or response bodies. Its six
regressions and the full Dashboard backend suite passed: 2,891 passed,
142 skipped. The independent review's unfinished-cleanup finding was reproduced
and fixed before completion.

The final run recorded 55 HTTP-200 requests: first use, two warm passes,
concurrency three and a separate local HTTP pass across eleven endpoints.
Warm version probe and full sync took 8.65 and 9.61 seconds, with 13 and 15
SQL statements respectively. Both endpoints share one 15-second client
workflow deadline. A real native forced-sync probe with no override timed out
after 15.03 seconds while the version request was still pending. A separate
local HTTP full-sync request took 16.46 seconds. Concurrent workspace loading
took 11.44 seconds and exceeded its eight-second bound.

Warm small database round trips took about 0.5 seconds through the session
pool, and 0.56–0.64 seconds through a separate direct connection. Five later
EXPLAIN samples executed in 0.028–0.242 ms on the server. Driver, network and
pooler contributions remain combined; these are not paired measurements.
Setup/reset added roughly 1–2 seconds per warm request; several routes acquired
two connections. Queue wait was at most 0.01 ms. New connections in the
concurrent pass cost about 3.1 seconds each. These small test-branch samples
do not establish production tail latency or an index/CPU bottleneck.

Dashboard's `docs/ACCOUNT_READ_PROFILING.md` explains the reusable test, and
`docs/ACCOUNT_READ_LATENCY_2026-10-25.md` records the full table, limitations
and proposed work. Raw spans, plans, source hashes and native-client results
remain in private local storage. Failed exploratory harness runs were retained;
a read-only startup GUC alone was not accepted by the pooler, so the corrected
setup explicitly sets and verifies it. No new paid model requests were made.
The provider dispatch count remains five.

This profiling task adds no product latency fix. Local acceptance remains
partial due to the observed native sync and workspace limits. All seven
roadmap items remain Partial; no release or production change occurred.

## Resume candidate review and CI — 2026-10-25

The user deferred further performance optimization to a separate feature
branch and resumed the approved usage/tracking roadmap. No optimization was
implemented after that instruction. The profiler, its six tests and detailed
findings are retained on Dashboard branch `codex/account-read-performance`,
commit `f8885d01c5ebaf0c1367313b0a34a3e292fb2300`; they are excluded from the
usage candidate. The private raw report remains available without switching
branches. The observed sync/workspace latency failures remain open.

The Dashboard usage candidate is
`dca54dfbc238b020316cfef81df3f285f6de3333` on
`codex/usage-read-timeouts`, based directly on `origin/main`. Its six changed
files contain the earlier account/Usage fixes and regression tests. A fresh
independent review of both product candidates found no actionable issue.
Fresh OpenScience checks passed: 647 affected backend tests / 2 skipped,
all seven typechecks, formatting, 31 SDK tests, and docs validation plus 8 tests.
The existing exact-source native build remains recorded above; the new commit
metadata must not be confused with the version string of the running process.
Product-only Dashboard checks and exact-candidate CI are being refreshed;
the earlier 2,891-test total includes the six deferred profiler tests.

This is a candidate update, not completion of the normal-client or production
gates. All seven roadmap items remain Partial. No merge, release, production
data mutation or additional paid inference is included.
