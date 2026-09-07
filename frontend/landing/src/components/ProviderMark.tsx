/* Provider marks come from the same sprite the Synthetic Sciences dashboard
   ships (public/provider-logos.svg). No third-party requests. */

export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "xai",
  "deepseek",
  "moonshotai",
  "zai",
  "minimax",
  "meta",
  "nvidia",
] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google",
  xai: "xAI",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  zai: "Z.ai",
  minimax: "MiniMax",
  meta: "Meta",
  nvidia: "NVIDIA",
  qwen: "Qwen",
}

export function ProviderMark({ id, title }: { id: string; title?: string }) {
  return (
    <span
      data-slot="model-logo"
      title={title ?? PROVIDER_NAMES[id] ?? id}
      aria-label={title ?? PROVIDER_NAMES[id] ?? id}
    >
      <svg focusable="false" aria-hidden>
        <use href={`/provider-logos.svg#${id}`} />
      </svg>
    </span>
  )
}

export function ProviderRow({ ids = PROVIDER_IDS }: { ids?: readonly string[] }) {
  return (
    <div data-slot="model-logos" aria-label="Model providers">
      {ids.map((id) => (
        <ProviderMark key={id} id={id} />
      ))}
    </div>
  )
}
