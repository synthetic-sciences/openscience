// Spend — managed (Atlas wallet) vs bring-your-own-key, toggled independently
// for LLM inference and compute. Everything is wired to a real endpoint:
//   • State + wallet → GET /settings/billing (client.settings.billing.get).
//   • Toggles → PUT /settings/billing (client.settings.billing.update), which
//     persists `billing.llm` / `billing.compute` in the global config AND keeps
//     the account-scoped server billing mode in sync — one source of truth.
//   • Buy credits → opens the Atlas top-up / checkout (URLS.dashboardCli).
import { Component, Show, createSignal, onMount, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import type { SettingsBillingGetResponse } from "@synsci/sdk/v2/client"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { URLS } from "@/config/urls"
import { FONT_SANS } from "@/styles/tokens"

type Billing = SettingsBillingGetResponse

const money = (n: number) => `$${(n < 0 ? 0 : n).toFixed(n >= 100 ? 0 : 2)}`

const LLM_MODES = [
  {
    value: "managed" as const,
    title: "Managed",
    body: "LLM calls route through your Atlas wallet — metered credits, no API keys needed.",
  },
  {
    value: "byok" as const,
    title: "BYOK",
    body: "Your own provider keys or OAuth subscriptions (Claude Pro, ChatGPT, Copilot). Never billed here.",
  },
  {
    value: null,
    title: "Auto",
    body: "Detect from the credential backing each call — managed proxy tokens bill the wallet, your own keys don't.",
  },
]

const COMPUTE_MODES = [
  {
    value: "managed" as const,
    title: "Managed",
    body: "Atlas-provisioned GPUs, billed to your wallet.",
  },
  {
    value: "byok" as const,
    title: "BYOK",
    body: "Your own connected GPU providers (Settings → Compute). Your provider bills you directly.",
  },
]

export default function Spend() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()

  const [billing, setBilling] = createSignal<Billing>()
  const [error, setError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const load = async () => {
    const res = await sdk.client.settings.billing.get()
    if (res.data) return setBilling(res.data)
    setError("Couldn't load spend settings.")
  }
  onMount(() => void load())

  const update = async (patch: { llm?: "managed" | "byok" | null; compute?: "managed" | "byok" }) => {
    setBusy(true)
    setError(undefined)
    const res = await sdk.client.settings.billing.update(patch)
    if (res.data) setBilling(res.data)
    if (!res.data) setError("Couldn't save spend settings.")
    setBusy(false)
  }

  const wallet = () => billing()?.wallet
  const balance = () => {
    const w = wallet()
    if (!w || !w.signedIn || w.balanceUsd < 0) return "—"
    return money(w.balanceUsd)
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-8">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-8 pb-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">Spend</h2>
          <p class="text-13-regular text-text-weak">
            Choose what runs on your Atlas wallet and what runs on your own keys — independently for LLM inference and
            compute.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 w-full max-w-[760px]">
        <Show when={error()}>
          <div
            style={{
              "font-family": FONT_SANS,
              "font-size": "12px",
              color: "var(--color-error)",
              border: "1px solid var(--color-error-muted)",
              "border-radius": "4px",
              padding: "10px 12px",
            }}
          >
            {error()}
          </div>
        </Show>

        {/* Wallet */}
        <Section title="Wallet" description="Managed spend debits this balance.">
          <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
            <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-4">
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Atlas session</span>
                <span class="text-13-medium text-text-strong">
                  {wallet() ? (wallet()!.signedIn ? "Signed in" : "Signed out") : "—"}
                </span>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Wallet balance</span>
                <span class="text-16-medium text-text-strong">{balance()}</span>
              </div>
              <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardCli)}>
                buy credits
              </Button>
            </div>
            <Show when={wallet() && !wallet()!.signedIn}>
              <div class="px-4 py-3 border-t border-border-weak-base">
                <p class="text-12-regular text-text-weak">
                  Not connected to Atlas — run <span class="text-text-strong">openscience login</span> to use managed
                  spend. BYOK works without an account.
                </p>
              </div>
            </Show>
          </div>
        </Section>

        {/* LLM spend */}
        <Section title="LLM spend" description="How model inference is paid for.">
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {LLM_MODES.map((mode) => (
              <ModeCard
                active={billing() !== undefined && billing()!.llm === mode.value}
                disabled={busy() || billing() === undefined}
                title={mode.title}
                body={mode.body}
                onClick={() => void update({ llm: mode.value })}
              />
            ))}
          </div>
        </Section>

        {/* Compute spend */}
        <Section title="Compute spend" description="How GPU provisioning and training runs are paid for.">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {COMPUTE_MODES.map((mode) => (
              <ModeCard
                active={billing()?.compute === mode.value}
                disabled={busy() || billing() === undefined}
                title={mode.title}
                body={mode.body}
                onClick={() => void update({ compute: mode.value })}
              />
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}

const Section: Component<{ title: string; description?: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-col gap-3">
    <div class="flex flex-col gap-0.5">
      <h3 class="text-13-medium text-text-weak tracking-wide">{props.title}</h3>
      <Show when={props.description}>
        <p class="text-12-regular text-text-weak">{props.description}</p>
      </Show>
    </div>
    {props.children}
  </div>
)

const ModeCard: Component<{ active: boolean; disabled: boolean; title: string; body: string; onClick: () => void }> = (
  props,
) => (
  <button
    type="button"
    disabled={props.disabled}
    onClick={props.onClick}
    style={{
      all: "unset",
      cursor: props.disabled ? "default" : "pointer",
      opacity: props.disabled ? 0.6 : 1,
      display: "flex",
      "flex-direction": "column",
      gap: "5px",
      padding: "14px 16px",
      "border-radius": "4px",
      border: "1px solid var(--color-border)",
      "box-shadow": props.active ? "inset 0 0 0 1px var(--color-text-interactive-base, var(--color-text))" : "none",
      background: props.active ? "var(--color-surface-interactive-weak, var(--color-accent-subtle))" : "transparent",
      transition: "border-color 120ms, box-shadow 120ms, background 120ms",
    }}
  >
    <div style={{ display: "flex", "align-items": "center", "justify-content": "space-between" }}>
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <Show when={props.active}>
        <span style={{ "font-family": FONT_SANS, "font-size": "11px", color: "var(--color-text-muted)" }}>active</span>
      </Show>
    </div>
    <span class="text-12-regular text-text-weak" style={{ "line-height": 1.5 }}>
      {props.body}
    </span>
  </button>
)
