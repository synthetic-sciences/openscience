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
