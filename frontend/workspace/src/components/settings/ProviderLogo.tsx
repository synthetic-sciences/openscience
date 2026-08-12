import { ProviderIcon } from "@synsci/ui/provider-icon"
import type { IconName } from "@synsci/ui/icons/provider"
import { Show, type Component } from "solid-js"

type Vector = {
  body: string
  viewBox: string
}

type Source =
  | { kind: "provider"; id: IconName }
  | { kind: "vector"; id: keyof typeof VECTORS }
  | { kind: "image"; src: string }
  | { kind: "fallback" }

const OPENALEX =
  "data:image/png;base64,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"
const TINKER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAMAAAAADbN2wMAAACZklEQVRoBe1aQWsTURCeednEH9Amm81VSPWvWNS/4FERWvTgwYtooSKiYEG9Cv0NHvTgT1B61avZzWZ7MvQgee50BnrowZ1tGJPdyhsIJJmded983+xbeLMIbEQUTSaTq4idB+hwm3+PENGJr0VWMpa0JPjkoHyVJMkPxuhRwKdpfgeQnvIfoxYBroRCAAWU8Pjk5Nch/iyKLef9FyJIuACsjGqRg0knRppx69yK0PsdAOSWaRHCGihnRI/A4T3HuG/XXN9eN9ENJ63TXoQ6MsYeO5ajbbuNjvqcV7BH535Xfl0sFjCbFbDwvvKaf+noRhH0+5vQ6/Vq09YWMCuO4eDte0izKRBvwuswfhZBEsewc/8uxPFAXRIZWCUqYf7Z/gv4+u1ITbIq5/VrW/B87wl0u93KJdT+F/bTNKsMXrUjY9UFg2ZqAX+458s1tc3fQPLzCgSDZmoBWmBbfKGAppUICgQFjAyEFjISaA4PCpgpNCYIChgJNIcHBcwUGhMEBYwEmsODAmYKjQmCAkYCzeFBATOFxgRBASOB5vD/W4EOnxI7GYE0ZDLxEgyaqQr0NzdgOIy1+JX65GRaMGimnk5L4DTP4eXrA8imfLxeeY6tLbG8T+Z18WAAjx7uQpIM1QS1BUi0HLPnPODwNQet6kpLOKOzAceVCww4LlTAEmuv/VK5B2QCflmt5AKouQmGmTbKRYGP5jwNJeBt9rPjreWNvHsg4/uGcCy9rGAVzIz9neO3Pr7LixOc5fK0EuKxYJ7P50cy6Pby1gdQ5yZR+YFrm/KndTe2kM4mI9VDpHJbMI/H49+nQiDWMpPTYxAAAAAASUVORK5CYII="

const VECTORS = {
  aws: {
    viewBox: "0 0 24 24",
    body: '<path fill="currentColor" d="M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zM21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z"/>',
  },
  gcp: {
    viewBox: "0 0 24 24",
    body: '<path fill="currentColor" d="M12.19 2.38a9.344 9.344 0 0 0-9.234 6.893c.053-.02-.055.013 0 0-3.875 2.551-3.922 8.11-.247 10.941l.006-.007-.007.03a6.717 6.717 0 0 0 4.077 1.356h5.173l.03.03h5.192c6.687.053 9.376-8.605 3.835-12.35a9.365 9.365 0 0 0-2.821-4.552l-.043.043.006-.05A9.344 9.344 0 0 0 12.19 2.38zm-.358 4.146c1.244-.04 2.518.368 3.486 1.15a5.186 5.186 0 0 1 1.862 4.078v.518c3.53-.07 3.53 5.262 0 5.193h-5.193l-.008.009v-.04H6.785a2.59 2.59 0 0 1-1.067-.23h.001a2.597 2.597 0 1 1 3.437-3.437l3.013-3.012A6.747 6.747 0 0 0 8.11 8.24c.018-.01.04-.026.054-.023a5.186 5.186 0 0 1 3.67-1.69z"/>',
  },
  github: {
    viewBox: "0 0 24 24",
    body: '<path fill="currentColor" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>',
  },
  literature: {
    viewBox: "0 0 24 24",
    body: '<path fill="currentColor" d="M24 8.609c-.848.536-1.436.83-2.146 1.245-4.152 2.509-8.15 5.295-11.247 8.981l-1.488 1.817-4.568-7.268c1.021.814 3.564 3.098 4.603 3.599l3.356-2.526c2.336-1.644 8.946-5.226 11.49-5.848ZM8.046 15.201c.346.277.692.537.969.744.761-3.668.121-7.613-1.886-11.039 3.374-.052 6.731-.087 10.105-.139a14.794 14.794 0 0 1 1.298 5.295c.294-.156.588-.294.883-.433-.104-1.868-.641-3.91-1.662-6.263-4.602-.018-9.188-.018-13.79-.018 2.993 3.547 4.36 7.839 4.083 11.853Zm-.623-.484c.087.086.191.155.277.225-.138-3.409-1.419-6.887-3.824-9.881H1.73c3.098 2.855 4.984 6.299 5.693 9.656Zm-.744-.658c.104.087.208.173.329.277-.9-2.526-2.492-5.018-4.741-7.198H0c2.89 2.076 5.122 4.481 6.679 6.921Z"/>',
  },
  meta: {
    viewBox: "0 0 24 24",
    body: '<path fill="currentColor" d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973.14.604.351 1.15.636 1.621.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.942-1.664c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843C23.6 18.001 24 16.489 24 14.41c0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303Zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602Zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285Z"/>',
  },
  modal: {
    viewBox: "0 0 24 24",
    body: '<path fill="currentColor" d="M4.89 5.57 0 14.002l2.521 4.4h5.05l4.396-7.718 4.512 7.709 4.996.037L24 14.057l-4.857-8.452-5.073-.015-2.076 3.598L9.94 5.57Zm.837.729h3.787l1.845 3.252H7.572Zm9.189.021 3.803.012 4.228 7.355-3.736-.027zm-9.82.346L6.94 9.914l-4.209 7.389-1.892-3.3Zm9.187.014 4.297 7.343-1.892 3.282-4.3-7.344zm-6.713 3.6h3.79l-4.212 7.394H3.361Zm11.64 4.109 3.74.027-1.893 3.281-3.74-.027Z"/>',
  },
  pinecone: {
    viewBox: "0 0 220 220",
    body: '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="m127 6.4c-2.1-2.5-5.6-3.1-8.4-1.5l-2.6 1.4-28.3 16.1 6.6 11.6 18.4-10.5-4.5 24.6 13.1 2.4 4.6-24.7 13.6 16.2 10.2-8.6-20.6-24.6h-.1zm-39.7 207.5c6.8 0 12.3-5.4 12.3-12s-5.5-12-12.3-12-12.3 5.4-12.3 12c-.1 6.6 5.5 12 12.3 12zm16.5-65.9-4.4 24.7-13.2-2.4 4.4-24.6-18.4 10.6-6.7-11.6 28.1-16.1 2.6-1.5c2.8-1.6 6.3-1 8.4 1.5l2 2.4 20.9 24.5-10.2 8.7zm10.7-59-4.4 24.7-13.2-2.4 4.4-24.5-18.3 10.5-6.6-11.6 28-16v-.2h.2l2.6-1.5c2.8-1.6 6.3-1 8.4 1.5l2 2.3 20.8 24.6-10.2 8.7zm-86.3 97.6h-.1l-2.7-.8c-2.9-.8-4.8-3.6-4.6-6.6l2.4-33.4 12.7.9-1.5 20.3 19.7-13.4 7.1 10.5-19.3 13.1 19.7 5.7-3.5 12.2zm130.7 13.8-.9 2.9c-.9 2.8-3.5 4.7-6.5 4.5l-2.8-.2-.2.1-.1-.1-31-2.1.8-12.7 20.6 1.4-13.5-18.9 10.3-7.4 13.8 19.4 6-19.6 12.1 3.7zm36.4-68.8 1.5 2.7c1.5 2.7.9 6.1-1.5 8.1l-2.2 1.9v.1h-.1l-24.1 20.4-8.4-9.9 15.8-13.4-23.7-4.2 2.3-12.8 23.9 4.2-10-18 11.3-6.3zm-24.5-55.8-21.4 11.5-6.2-11.4 21.1-11.3-19.3-7.9 4.9-12 29.4 11.9.1-.1.1.2 2.7 1.1c2.9 1.2 4.5 4.2 4 7.2l-.5 3-5.5 30.5-12.8-2.3zm-143.6 26.8 23.8 4-2.2 12.8-24-4.1 10.2 18-11.3 6.4-15.4-27.1-1.5-2.6c-1.5-2.7-.9-6.1 1.4-8.1l2.2-1.9v-.1h.1l23.8-20.5 8.5 9.9zm35.9-55.4 15.8 17.6-9.7 8.7-16.2-18-3.7 20.5-12.8-2.3 5.6-30.4.6-3.1c.5-3 3.1-5.2 6.1-5.3l2.8-.1.1-.1.1.1 31.8-1.3.5 13Z"/>',
  },
  langsmith: {
    viewBox: "0 0 98 98",
    body: '<path fill="#161F34" d="M78.4 0H19.6C8.775 0 0 8.775 0 19.6v58.8C0 89.225 8.775 98 19.6 98h58.8C89.225 98 98 89.225 98 78.4V19.6C98 8.775 89.225 0 78.4 0Z"/><path fill="#7FC8FF" fill-rule="evenodd" clip-rule="evenodd" d="M37.659 59.312c-5.3.065-10.62-1.921-14.66-5.96-7.948-7.949-7.948-20.856 0-28.805 7.95-7.948 20.856-7.948 28.805 0 4.04 4.04 6.026 9.36 5.96 14.66-3.883.223-7.715 1.5-11.032 3.828 1.63-3.729.921-8.237-2.129-11.287-3.974-3.974-10.428-3.974-14.402 0-3.975 3.974-3.975 10.427 0 14.402 3.049 3.05 7.558 3.759 11.286 2.13 1.131-.495 2.19-1.205 3.116-2.13 3.65-3.649 8.343-5.623 13.123-5.921.34-.022.68-.034 1.022-.039 5.299-.066 10.62 1.921 14.659 5.96 7.949 7.949 7.949 20.856 0 28.804-7.949 7.949-20.855 7.949-28.804 0-4.04-4.04-6.027-9.36-5.96-14.659 3.882-.224 7.714-1.5 11.032-3.828-1.63 3.728-.921 8.237 2.129 11.286 3.974 3.975 10.428 3.975 14.402 0 3.974-3.974 3.974-10.427 0-14.402-3.05-3.049-7.558-3.759-11.287-2.13-1.13.495-2.19 1.205-3.115 2.13-3.65 3.65-8.343 5.623-13.123 5.922-.34.021-.681.034-1.022.039Z"/>',
  },
} satisfies Record<string, Vector>

const SOURCES: Record<string, Source> = {
  anthropic: { kind: "provider", id: "anthropic" },
  openai: { kind: "provider", id: "openai" },
  "openai-codex": { kind: "provider", id: "openai" },
  google: { kind: "provider", id: "google" },
  gemini: { kind: "provider", id: "google" },
  xai: { kind: "provider", id: "xai" },
  meta: { kind: "vector", id: "meta" },
  llama: { kind: "provider", id: "llama" },
  openrouter: { kind: "provider", id: "openrouter" },
  togetherai: { kind: "provider", id: "togetherai" },
  groq: { kind: "provider", id: "groq" },
  "fireworks-ai": { kind: "provider", id: "fireworks-ai" },
  mistral: { kind: "provider", id: "mistral" },
  deepseek: { kind: "provider", id: "deepseek" },
  moonshotai: { kind: "provider", id: "moonshotai" },
  zai: { kind: "provider", id: "zai" },
  cerebras: { kind: "provider", id: "cerebras" },
  perplexity: { kind: "provider", id: "perplexity" },
  aws: { kind: "vector", id: "aws" },
  gcp: { kind: "vector", id: "gcp" },
  azure: { kind: "provider", id: "azure" },
  nvidia: { kind: "provider", id: "nvidia" },
  modal: { kind: "vector", id: "modal" },
  github: { kind: "vector", id: "github" },
  literature: { kind: "vector", id: "literature" },
  openalex: { kind: "image", src: OPENALEX },
  huggingface: { kind: "provider", id: "huggingface" },
  tinker: { kind: "image", src: TINKER },
  wandb: { kind: "provider", id: "wandb" },
  pinecone: { kind: "vector", id: "pinecone" },
  langsmith: { kind: "vector", id: "langsmith" },
}

// Provider catalogs and OpenRouter vendor slugs do not always use the same id
// as the icon pack. Normalize the known spellings so a real provider never
// falls back to a generic initial (notably DeepSeek, Kimi, and Z.AI).
const ALIASES: Record<string, keyof typeof SOURCES> = {
  "deep-seek": "deepseek",
  "deepseek-ai": "deepseek",
  together: "togetherai",
  fireworks: "fireworks-ai",
  moonshot: "moonshotai",
  kimi: "moonshotai",
  "z-ai": "zai",
  zhipuai: "zai",
  "x-ai": "xai",
  "google-gemini": "google",
  "meta-llama": "llama",
}

export const PROVIDER_LOGO_IDS = Object.keys(SOURCES)

export function providerLogoSource(id: string) {
  const normalized = id.trim().toLowerCase()
  return SOURCES[ALIASES[normalized] ?? normalized] ?? ({ kind: "fallback" } as const)
}

const Mark: Component<{ source: Source; label: string; small?: boolean }> = (props) => {
  if (props.source.kind === "provider") {
    return <ProviderIcon id={props.source.id} class={props.small ? "size-[15px]" : "size-[18px]"} aria-hidden="true" />
  }
  if (props.source.kind === "vector") {
    const vector = VECTORS[props.source.id]
    return (
      <svg
        viewBox={vector.viewBox}
        class={props.small ? "size-[15px]" : "size-[18px]"}
        aria-hidden="true"
        innerHTML={vector.body}
      />
    )
  }
  if (props.source.kind === "image") {
    return (
      <img src={props.source.src} alt="" class={props.small ? "size-[16px] object-contain" : "size-5 object-contain"} />
    )
  }
  return (
    <span class={props.small ? "text-[9px] font-medium" : "text-11-medium"}>
      {props.label.trim().charAt(0).toUpperCase()}
    </span>
  )
}

export const ProviderLogo: Component<{
  id: string
  label?: string
  connected?: boolean
  size?: "small" | "default"
}> = (props) => {
  const label = () => props.label ?? props.id
  const small = () => props.size === "small"
  const source = () => providerLogoSource(props.id)
  return (
    <span
      class="settings-provider-logo"
      data-size={small() ? "small" : "default"}
      role="img"
      aria-label={`${label()} logo`}
      data-provider-logo={props.id}
      data-provider-logo-source={source().kind}
    >
      <Mark source={source()} label={label()} small={small()} />
      <Show when={props.connected}>
        <span
          aria-hidden="true"
          class="absolute bottom-[2px] right-[2px] size-1.5 rounded-full border border-surface-base bg-icon-success-base"
        />
      </Show>
    </span>
  )
}
