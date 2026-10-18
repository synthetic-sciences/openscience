# Traces, usage and cost: local acceptance

Verified on 2026-10-18 against OpenScience `9fac1706` and Dashboard `83ae327f`.
These checks use explicitly synthetic local fixtures. They do not establish
real provider invoice reconciliation or hosted deployment acceptance.

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
- Actual BYOK billing exports or a read-only billing account, including native
  export conversion and reconciliation acceptance.
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
