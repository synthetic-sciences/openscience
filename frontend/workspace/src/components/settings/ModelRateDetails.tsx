import { For } from "solid-js"
import { modelPricing, pricingUpstream } from "@/context/model-pricing"

export function ModelRateDetails(
  props: Parameters<typeof modelPricing>[0] & {
    label: string
    provider: string
    limit: { context: number; output: number }
  },
) {
  const pricing = () => modelPricing(props)
  return (
    <div class="models-rate-route">
      <strong class="text-12-medium text-text-base">
        {props.access === "managed" ? "Ace" : `${props.label} · ${pricingUpstream(props.pricing) ?? props.provider}`}
      </strong>
      <dl>
        <div>
          <dt>Context</dt>
          <dd>{props.limit.context.toLocaleString()} tokens</dd>
        </div>
        <div>
          <dt>Max output</dt>
          <dd>{props.limit.output.toLocaleString()} tokens</dd>
        </div>
        <For each={pricing().lines}>
          {(line) => (
            <div>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          )}
        </For>
      </dl>
      <p>{pricing().note}</p>
    </div>
  )
}
