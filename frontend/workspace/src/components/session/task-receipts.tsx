import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Button } from "@synsci/ui/button"
import type { SessionReceiptsResponses } from "@synsci/sdk/v2/client"

type Report = SessionReceiptsResponses[200]
const amount = (value: string) => {
  const micro = BigInt(value)
  return `USD ${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`
}
const reasons = {
  signed_out: "Sign in to check Wallet settlement.",
  unsupported: "This server does not support per-call receipts yet.",
  unauthorized: "Wallet receipts are unavailable for the current account or workspace.",
  server_unavailable: "The receipt server is unavailable. Please retry.",
  invalid_report: "The server returned incomplete or inconsistent receipt identities. Please retry.",
  account_changed: "The account or workspace changed. Check again for the current account.",
}

export function TaskReceipts(props: { sessionID: string; load: () => Promise<Report> }) {
  const [report, setReport] = createSignal<Report>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let revision = 0
  const reset = () => {
    revision++
    setReport(undefined)
    setError(undefined)
    setBusy(false)
  }
  createEffect(on(() => props.sessionID, reset))
  window.addEventListener("openscience:account-changed", reset)
  onCleanup(() => {
    revision++
    window.removeEventListener("openscience:account-changed", reset)
  })
  const load = async () => {
    if (busy()) return
    const current = revision
    setBusy(true)
    setReport(undefined)
    setError(undefined)
    await props
      .load()
      .then((value) => {
        if (current === revision) setReport(value)
      })
      .catch(() => {
        if (current === revision) setError("Could not check settled charges. Please retry.")
      })
      .finally(() => {
        if (current === revision) setBusy(false)
      })
  }
  const counts = createMemo(() => {
    const calls = report()?.calls ?? []
    return {
      pending: calls.filter((call) => call.state === "pending").length,
      unknown:
        calls.filter((call) => call.state === "missing" || call.state === "unknown").length +
        (report()?.missingCallIDs ?? 0),
      inconsistent: calls.filter((call) => call.state === "inconsistent").length,
      released: calls.filter((call) => call.state === "not_charged").length,
    }
  })
  return (
    <section class="context-panel__section" aria-label="Settled Ace charges">
      <h3 class="context-panel__title">Settled Ace charges</h3>
      <p class="context-panel__note">
        Wallet ledger receipts for this task and its workers. Calculated amounts and BYOK costs are shown separately
        above.
      </p>
      <Button size="small" variant="secondary" disabled={busy()} onClick={load}>
        {busy() ? "Checking…" : "Check settled charges"}
      </Button>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={report()}>
        {(result) => (
          <>
            <Show when={result().state === "unavailable"}>
              <p role="status">{reasons[result().reason ?? "server_unavailable"]}</p>
            </Show>
            <Show when={result().state === "available"}>
              <p>
                Includes {Math.max(0, result().sessions - 1)} worker sessions · checked{" "}
                {result().checkedAt ? new Date(result().checkedAt!).toLocaleString() : "Unknown"}
              </p>
              <Show when={result().receipts.length > 0} fallback={<p>No settled receipts available.</p>}>
                <p>Settled receipts subtotal: {amount(result().chargedMicrousd!)}</p>
                <ul>
                  <For each={result().receipts}>
                    {(receipt) => (
                      <li>
                        {receipt.model} · {amount(receipt.charged_microusd)}
                        <br />
                        Receipt {receipt.receipt_id} · Hold {receipt.hold_id}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <p>
                Pending: {counts().pending} · Unknown or missing: {counts().unknown} · Inconsistent:{" "}
                {counts().inconsistent} · Released or expired: {counts().released}
              </p>
              <Show when={counts().pending + counts().unknown + counts().inconsistent > 0}>
                <p class="context-panel__note">
                  This subtotal is incomplete. Pending and unknown calls are not treated as free.
                </p>
              </Show>
              <Show when={result().managedCalls === 0}>
                <p>No managed calls are recorded for this task.</p>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  )
}
