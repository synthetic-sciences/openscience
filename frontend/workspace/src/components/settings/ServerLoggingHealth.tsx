import { For, Show, createEffect, on, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import type { SettingsUsageLoggingHealthResponses } from "@synsci/sdk/v2/client"
import { Card, Row, RowCopy } from "./_shared"

type Result = SettingsUsageLoggingHealthResponses[200]
const reasons = {
  signed_out: "Sign in to check server evidence.",
  unsupported: "This server does not support logging-health reports yet.",
  unauthorized: "The server could not authorize this account or workspace. Check your connection and try again.",
  server_unavailable: "The server could not be reached or did not complete the check. Try again.",
  invalid_report: "The server returned an unreadable health report. Try again.",
  account_changed: "The account or workspace changed during this check. Check again for the current connection.",
}
const labels = {
  missing_call_id: "Missing call IDs",
  missing_link: "Missing call-to-hold links",
  ambiguous_link: "Ambiguous call-to-hold links",
  missing_hold: "Missing holds",
  hold_mismatch: "Hold identity mismatches",
  settled_missing_charge: "Settled holds without charges",
  duplicate_charge: "Duplicate charges",
  token_mismatch: "Provider/ledger token evidence gaps or mismatches",
  charge_amount_mismatch: "Hold/ledger charge mismatches",
}
const summaries = {
  healthy: "No discrepancies found in the stored evidence checked.",
  attention: "Stored evidence needs attention. Review the findings below.",
  incomplete: "Some call outcomes, token counts or settlement evidence are still unavailable.",
  no_data: "No stored model-call evidence found for this device and workspace in the checked window.",
}

export function ServerLoggingHealth(props: {
  signedIn: boolean
  queued: number
  quarantined: number
  check: () => Promise<Result>
}) {
  const [state, setState] = createStore<{ result?: Result; busy: boolean; error?: string; revision: number }>({
    busy: false,
    revision: 0,
  })
  const clear = () => setState({ result: undefined, error: undefined, busy: false, revision: state.revision + 1 })
  createEffect(on(() => props.signedIn, clear, { defer: true }))
  onMount(() => window.addEventListener("openscience:account-changed", clear))
  onCleanup(() => window.removeEventListener("openscience:account-changed", clear))
  const check = async () => {
    if (state.busy || !props.signedIn) return
    const revision = state.revision
    setState({ busy: true, result: undefined, error: undefined })
    await props
      .check()
      .then((result) => {
        if (revision === state.revision) setState({ result })
      })
      .catch(() => {
        if (revision === state.revision) setState({ error: "Could not check server logging health. Please retry." })
      })
      .finally(() => {
        if (revision === state.revision) setState({ busy: false })
      })
  }
  const report = () => (state.result?.state === "available" ? state.result.report : undefined)
  return (
    <Card>
      <Row>
        <RowCopy
          title="Server reconciliation"
          description={
            state.error ??
            (state.busy
              ? "Checking…"
              : !props.signedIn
                ? reasons.signed_out
                : state.result?.state === "unavailable"
                  ? reasons[state.result.reason]
                  : report()
                    ? summaries[report()!.status]
                    : "Check stored evidence for this account, device and workspace over the last 24 hours.")
          }
        />
        <button
          type="button"
          class="settings-preference-action"
          disabled={state.busy || !props.signedIn}
          onClick={() => void check()}
        >
          Check server
        </button>
      </Row>
      <Show when={report()}>
        {(value) => (
          <>
            <Row>
              <RowCopy
                title="Checked window"
                description={`${value().since} to ${value().until} · checked ${value().checked_at}`}
              />
            </Row>
            <Row>
              <RowCopy
                title="Delivery receipts"
                description={`${value().receipts.deliveries} deliveries · ${value().receipts.receipt_only} without stored events (${value().receipts.replayed_only} replay-only) · ${value().receipts.anomalous} inconsistent receipts · ${value().receipts.orphaned_events} events without receipts`}
              />
            </Row>
            <Row>
              <RowCopy
                title="Server usage"
                description={`${value().usage.responses} model responses · ${value().usage.projected} usage records · ${value().usage.missing_projection} missing usage records`}
              />
            </Row>
            <Row>
              <RowCopy
                title="HTTP attempts"
                description={
                  value().attempts
                    ? `${value().attempts!.calls} calls · ${value().attempts!.dispatched} dispatches · ${value().attempts!.completed} completed · ${value().attempts!.failed} failed · ${value().attempts!.cancelled} cancelled · ${value().attempts!.timed_out} timed out · ${value().attempts!.pending} without a terminal outcome · ${value().attempts!.unclassified_requests} requests without HTTP attempt evidence`
                    : "This server does not report pre-response attempt coverage. Failure and cancellation coverage is unknown."
                }
              />
            </Row>
            <Row>
              <RowCopy
                title="Unknown provider fields"
                description={`Input ${value().usage.unknown_input} · output ${value().usage.unknown_output} · reasoning ${value().usage.unknown_reasoning} · cache read ${value().usage.unknown_cache_read} · cache write ${value().usage.unknown_cache_write}. An omitted field is not a token-count mismatch.`}
              />
            </Row>
            <Row>
              <RowCopy
                title="Ace settlement evidence"
                description={`${value().managed.settled} settled holds · ${value().managed.pending} pending · ${value().managed.not_charged} released or expired · ${value().managed.unknown_charge_amount} settled amounts unknown`}
              />
            </Row>
            <Show when={value().managed.attempts_without_response !== undefined}>
              <Row>
                <RowCopy
                  title="Ace calls without responses"
                  description={`${value().managed.attempts_without_response} HTTP attempts checked · ${value().managed.unknown_attempt_charge ?? 0} without a known call-to-hold link. An absent link does not establish a zero charge.`}
                />
              </Row>
            </Show>
            <For each={(Object.keys(labels) as Array<keyof typeof labels>).filter((key) => value().managed[key] > 0)}>
              {(key) => (
                <Row>
                  <RowCopy title={labels[key]} description={String(value().managed[key])} />
                </Row>
              )}
            </For>
            <Show when={props.queued + props.quarantined > 0}>
              <Row>
                <RowCopy
                  title="Still on this device"
                  description={`${props.queued} queued and ${props.quarantined} rejected records are outside the server report. Server evidence cannot prove these records arrived.`}
                />
              </Row>
            </Show>
          </>
        )}
      </Show>
    </Card>
  )
}
