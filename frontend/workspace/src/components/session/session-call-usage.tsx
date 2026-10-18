import { For, Show, createMemo } from "solid-js"
import type { StepFinishPart } from "@synsci/sdk/v2/client"
import { sessionCostFormatter } from "./session-usage"

const labels = {
  subscription: "Subscription covered",
  provider_response: "Provider reported",
  wallet_calculated: "Ace calculated · not a settled receipt",
  catalog_estimate: "Catalog estimate",
  unknown: "Unknown",
  recorded_unclassified: "Historical accounting · basis unknown",
}

export function SessionCallUsage(props: { steps: StepFinishPart[]; locale: string }) {
  const usd = createMemo(() => sessionCostFormatter(props.locale))
  const number = (value: number | null | undefined) => (value == null ? "Unknown" : value.toLocaleString(props.locale))
  const totals = createMemo(() => {
    return (["provider_response", "wallet_calculated", "catalog_estimate"] as const).flatMap((source) => {
      const values = props.steps.filter((step) => step.usage?.cost?.source === source)
      if (!values.length) return []
      const known = values.filter((step) => step.usage?.cost?.amountUSD != null)
      return [
        {
          source,
          amount: known.reduce((sum, step) => sum + (step.usage?.cost?.amountUSD ?? 0), 0),
          complete: known.length === values.length,
        },
      ]
    })
  })

  return (
    <Show when={props.steps.length > 0}>
      <section class="context-panel__section" aria-label="Model call usage">
        <h3 class="context-panel__title">Model call usage</h3>
        <p class="context-panel__note">
          Calls recorded in this session. Workers have their own sessions. Unknown means the provider did not report a
          field or the older record did not preserve it. Cost categories are separate; none confirms a settled Ace
          charge.
        </p>
        <For each={totals()}>
          {(total) => (
            <p>
              {labels[total.source]}: {usd().format(total.amount)}
              {total.complete ? "" : " (partial)"}
            </p>
          )}
        </For>
        <div style={{ "overflow-x": "auto" }}>
          <table class="context-panel__calls">
            <caption class="context-panel__note">Provider token counts and cost basis for each completed step</caption>
            <thead>
              <tr>
                <th scope="col">Route / model</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Reasoning</th>
                <th scope="col">Cache read</th>
                <th scope="col">Cache write</th>
                <th scope="col">Cost</th>
                <th scope="col">Call / Ace hold</th>
              </tr>
            </thead>
            <tbody>
              <For each={props.steps}>
                {(step) => {
                  const source = () =>
                    step.usage?.route === "chatgpt" || step.usage?.route === "subscription"
                      ? "subscription"
                      : (step.usage?.cost?.source ?? "recorded_unclassified")
                  const amount = () =>
                    source() === "subscription" ? null : step.usage?.cost ? step.usage.cost.amountUSD : step.cost
                  return (
                    <tr>
                      <td>
                        {step.usage?.route ?? "Unknown"}
                        <br />
                        {step.usage?.model ?? "Unknown"}
                      </td>
                      <td>{number(step.usage?.reported?.input_tokens)}</td>
                      <td>{number(step.usage?.reported?.output_tokens)}</td>
                      <td>{number(step.usage?.reported?.reasoning_tokens)}</td>
                      <td>{number(step.usage?.reported?.cached_input_tokens)}</td>
                      <td>{number(step.usage?.reported?.cache_creation_input_tokens)}</td>
                      <td>
                        {labels[source()]}
                        <Show when={amount() != null}>
                          <br />
                          {usd().format(amount()!)}
                        </Show>
                        <Show when={step.usage?.reportedCostUSD != null && source() !== "provider_response"}>
                          <br />
                          Provider reported: {usd().format(step.usage!.reportedCostUSD!)}
                        </Show>
                      </td>
                      <td>
                        {step.usage?.call ?? "Unknown"}
                        <br />
                        {step.usage?.hold ?? "No hold recorded"}
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
      </section>
    </Show>
  )
}
