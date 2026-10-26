import { For, Show } from "solid-js"
import type { SessionReceiptsResponses, StepFinishPart } from "@synsci/sdk/v2/client"
import { walletAmount } from "./session-usage"

export function SessionCallUsage(props: {
  steps: StepFinishPart[]
  locale: string
  report?: SessionReceiptsResponses[200]
}) {
  const number = (value: number | null | undefined) => (value == null ? "Unknown" : value.toLocaleString(props.locale))
  const charge = (step: StepFinishPart) => {
    const report = props.report
    if (!report) return "Not checked"
    if (report.state !== "available") return "Unavailable"
    const call = report.calls.find((call) => call.call_id === step.usage?.call)
    if (!call) return "Unknown"
    if (call.state === "pending") return "Pending"
    if (call.state === "not_charged") return "No charge"
    if (call.state !== "settled") return "Unknown"
    const receipt = report.receipts.find(
      (receipt) =>
        receipt.receipt_id === call.receipt_id &&
        receipt.hold_id === call.hold_id &&
        receipt.hold_id === step.usage?.hold,
    )
    return receipt ? walletAmount(receipt.charged_microusd) : "Unknown"
  }
  return (
    <Show when={props.steps.length > 0}>
      <section class="context-panel__section" aria-label="Model call usage">
        <h3 class="context-panel__title">Model call usage</h3>
        <table class="context-panel__calls">
          <caption class="context-panel__note">This session · Wallet deductions only</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Tokens</th>
              <th scope="col">Wallet cost</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.steps}>
              {(step) => (
                <tr>
                  <td>
                    {step.usage?.model ?? "Unknown"}
                    <details class="context-panel__call-details">
                      <summary>Details</summary>
                      <dl>
                        <dt>Route</dt>
                        <dd>{step.usage?.route ?? "Unknown"}</dd>
                        <dt>Reasoning</dt>
                        <dd>{number(step.usage?.reported?.reasoning_tokens)}</dd>
                        <dt>Cache read</dt>
                        <dd>{number(step.usage?.reported?.cached_input_tokens)}</dd>
                        <dt>Cache write</dt>
                        <dd>{number(step.usage?.reported?.cache_creation_input_tokens)}</dd>
                        <dt>Call</dt>
                        <dd>{step.usage?.call ?? "Unknown"}</dd>
                        <dt>Hold</dt>
                        <dd>{step.usage?.hold ?? "Unknown"}</dd>
                      </dl>
                    </details>
                  </td>
                  <td>
                    {number(step.usage?.reported?.input_tokens)} in
                    <br />
                    {number(step.usage?.reported?.output_tokens)} out
                  </td>
                  <td>{charge(step)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </section>
    </Show>
  )
}
