import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { Button } from "@synsci/ui/button"
import type { SessionReceiptsResponses } from "@synsci/sdk/v2/client"

import { formatUsd } from "@synsci/util/money"
import { walletAmount } from "./session-usage"

type Report = SessionReceiptsResponses[200]
const reasons = {
  signed_out: "Sign in to check Wallet settlement.",
  unsupported: "This server does not support per-call receipts yet.",
  unauthorized: "Wallet receipts are unavailable for the current account or workspace.",
  server_unavailable: "The receipt server is unavailable. Please retry.",
  invalid_report: "The server returned incomplete or inconsistent receipt identities. Please retry.",
  account_changed: "The account or workspace changed. Check again for the current account.",
}

export function TaskReceipts(props: {
  sessionID: string
  load: () => Promise<Report>
  onReport?: (report: Report | undefined) => void
}) {
  const [report, setReport] = createSignal<Report>()
  createEffect(() => props.onReport?.(report()))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let revision = 0
  const load = async () => {
    const current = ++revision
    setBusy(true)
    setError(undefined)
    await props
      .load()
      .then((value) => {
        if (current === revision) setReport(value)
      })
      .catch(() => {
        if (current === revision) setError("Could not check settled charges.")
      })
      .finally(() => {
        if (current === revision) setBusy(false)
      })
  }
  // The Wallet is asked once each time the panel opens (and again for a new conversation or
  // account), not on every model step, to keep load off the receipt server. Reopen to re-check.
  const restart = () => {
    setReport(undefined)
    void load()
  }
  createEffect(on(() => props.sessionID, restart))
  window.addEventListener("openscience:account-changed", restart)
  onCleanup(() => {
    revision++
    window.removeEventListener("openscience:account-changed", restart)
  })
  const checked = () => {
    const at = report()?.checkedAt
    return at ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : undefined
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
  const settled = createMemo(() => {
    const value = report()
    return value?.state === "available" && value.receipts.length > 0 ? value.chargedMicrousd : undefined
  })
  const incomplete = () => counts().pending + counts().unknown + counts().inconsistent > 0
  // Plain-language reasons the total is not final, only for the states that occur.
  const unsettled = () =>
    [
      counts().pending && `${counts().pending} pending`,
      counts().unknown && `${counts().unknown} missing`,
      counts().inconsistent && `${counts().inconsistent} inconsistent`,
    ]
      .filter(Boolean)
      .join(", ")
  // Settled charges for the task and its workers, grouped by model, largest first.
  const models = createMemo(() => {
    const value = report()
    if (value?.state !== "available") return []
    const totals = new Map<string, { micro: bigint; calls: number }>()
    for (const receipt of value.receipts) {
      const item = totals.get(receipt.model) ?? { micro: 0n, calls: 0 }
      item.micro += BigInt(receipt.charged_microusd)
      item.calls++
      totals.set(receipt.model, item)
    }
    return [...totals.entries()]
      .map(([model, item]) => ({ model, ...item }))
      .sort((a, b) => (b.micro > a.micro ? 1 : b.micro < a.micro ? -1 : a.model.localeCompare(b.model)))
  })
  const headline = () => {
    const value = settled()
    if (value != null) return formatUsd(Number(value) / 1_000_000)
    if (report()) return "Unknown"
    return busy() ? "Checking…" : "Not checked"
  }
  return (
    <section class="context-panel__section" aria-label="Cost so far">
      <h3 class="context-panel__title">Cost so far</h3>
      <div class="context-panel__tokens">
        <strong title={settled() != null ? walletAmount(settled()!) : undefined}>{headline()}</strong>
      </div>
      <p class="receipts__status">
        <Show when={settled() != null}>
          <span>Deducted from Wallet</span>
        </Show>
        <Show when={report()?.state === "available" && report()!.sessions > 1}>
          <span>Includes workers</span>
        </Show>
        <Show when={checked()}>{(at) => <span>Checked {at()}</span>}</Show>
      </p>
      <Show when={report()?.state === "available" && incomplete()}>
        <p role="status" class="receipts__status">
          <span data-tone="warning">
            Some charges are not final ({unsettled()}). The total may rise; unsettled calls are not treated as free.
          </span>
        </p>
      </Show>
      <Show when={models().length > 0}>
        <ul class="context-panel__legend receipts__models" aria-label="Wallet cost by model">
          <For each={models()}>
            {(item) => (
              <li>
                <span class="label" title={item.model}>
                  {item.model}
                </span>
                <span class="share">
                  {item.calls} {item.calls === 1 ? "call" : "calls"}
                </span>
                <span class="value" title={walletAmount(item.micro.toString())}>
                  {formatUsd(Number(item.micro) / 1_000_000)}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={report()?.state === "available" && report()!.managedCalls === 0}>
        <p class="context-panel__note">No managed calls are recorded for this task.</p>
      </Show>
      <Show when={report()?.state === "available" && report()!.managedCalls > 0 && !report()!.receipts.length}>
        <p class="context-panel__note">No settled receipts yet.</p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="allowance__error">
          {error()}
        </p>
        <div class="allowance__actions">
          <Button size="small" variant="secondary" disabled={busy()} onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Show>
      <Show when={report()?.state === "unavailable"}>
        <p role="status" class="context-panel__note">
          {reasons[report()!.reason ?? "server_unavailable"]}
        </p>
      </Show>
    </section>
  )
}
