import type { SettingsBillingGetResponse } from "@synsci/sdk/v2/client"
import { Button } from "@synsci/ui/button"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { URLS } from "@/config/urls"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"

type Mode = SettingsBillingGetResponse["llm"]
type Wallet = {
  signedIn: boolean
  balanceUsd: number
  billingMode: "managed" | "byok" | null
  managedSupported: boolean
}

const MODES: { value: Mode; title: string; body: string }[] = [
  {
    value: "managed",
    title: "Managed",
    body: "Use prepaid OpenScience credits. No provider key is required.",
  },
  {
    value: "byok",
    title: "Own keys",
    body: "Use the provider keys and subscriptions connected below.",
  },
  {
    value: null,
    title: "Automatic",
    body: "Choose from the credential backing each model request.",
  },
]

const money = (value: number) => `$${value.toFixed(value >= 100 ? 0 : 2)}`

/**
 * The write-then-refresh ordering a mode switch depends on: the billing write
 * must resolve and its data must be applied before the provider catalog is
 * refreshed, and the refresh must not run at all when the write comes back
 * without data (a failed save). Pulled out of `update()` and parameterized
 * over `write`/`apply`/`refresh` so the ordering is unit-testable with plain
 * async functions standing in for the SDK call and `refreshProviders()` —
 * no live backend, no mocking `sdk`/`globalSync`.
 */
export async function commitBilling<T>(
  write: () => Promise<{ data?: T }>,
  apply: (data: T) => void,
  refresh: () => Promise<void>,
): Promise<boolean> {
  const result = await write()
  if (!result.data) return false
  apply(result.data)
  await refresh()
  return true
}

export function ManagedInference(props: { onError?: (error: string | undefined) => void }) {
  const sdk = useGlobalSDK()
  const globalSync = useGlobalSync()
  const platform = usePlatform()
  const [wallet, setWallet] = createSignal<Wallet>()
  const [billing, setBilling] = createSignal<SettingsBillingGetResponse>()
  const [busy, setBusy] = createSignal(false)

  const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const fail = (error: unknown) => {
    props.onError?.(reason(error))
  }
  const loadWallet = () =>
    settingsApi<Wallet>(sdk.url, platform.fetch ?? fetch, "/settings/wallet")
      .then(setWallet)
      .catch(fail)
  const loadBilling = () =>
    sdk.client.settings.billing
      .get()
      .then((result) => {
        if (result.data) return setBilling(result.data)
        fail("Couldn't load managed inference settings.")
      })
      .catch(fail)
  const refresh = () => {
    props.onError?.(undefined)
    void Promise.all([loadWallet(), loadBilling()])
  }
  const update = (value: Mode) => {
    if (busy()) return
    setBusy(true)
    props.onError?.(undefined)
    // apply() only runs once the write has data, so a rejection past that
    // point is the catalog refresh failing, not the save — the same split
    // credentialChange draws for the other credential panels. A rejection
    // before apply() is a genuine save failure and keeps the plain wording.
    let saved = false
    void commitBilling(
      () => sdk.client.settings.billing.update({ llm: value }),
      (data) => {
        saved = true
        setBilling(data)
      },
      () => globalSync.refreshProviders(),
    )
      .then((ok) => {
        if (!ok) fail("Couldn't save managed inference settings.")
      })
      .catch((error) => {
        if (!saved) return fail(error)
        props.onError?.(
          `Managed inference settings saved, but the model list could not be reloaded (${reason(error)}). It will catch up on the next refresh.`,
        )
      })
      .finally(() => setBusy(false))
  }

  // The mode can change without this panel touching it: saving an own provider
  // key in Provider keys below makes the server flip billing.llm managed →
  // byok (Auth.set). That happens in the same window, so no `focus` event ever
  // fires and the toggle would keep showing Managed — highlighted, and
  // contradicting the row underneath — until a reload. Every credential change
  // already funnels through refreshProviders, so re-read the mode there.
  const unsubscribe = globalSync.onProvidersRefreshed(() => void loadBilling())

  onMount(() => {
    refresh()
    window.addEventListener("focus", refresh)
  })
  onCleanup(() => {
    window.removeEventListener("focus", refresh)
    unsubscribe()
  })

  const unsupported = (value: Mode) =>
    value === "managed" && wallet() !== undefined && (!wallet()!.signedIn || !wallet()!.managedSupported)

  return (
    <div class="flex flex-col gap-3">
      <div class="flex min-h-12 flex-wrap items-center gap-x-5 gap-y-2 rounded-[4px] border border-border-weak-base bg-surface-base/40 px-4 py-3">
        <div class="flex min-w-[150px] flex-1 flex-col gap-0.5">
          <span class="text-12-regular text-text-weak">OpenScience credits</span>
          <Show when={wallet()} fallback={<span class="text-13-medium text-text-weak">Checking account…</span>}>
            <span class="text-13-medium text-text-strong">
              {wallet()!.signedIn
                ? wallet()!.balanceUsd >= 0
                  ? `${money(wallet()!.balanceUsd)} available`
                  : "Balance unavailable"
                : "Not signed in"}
            </span>
          </Show>
        </div>
        <Button size="small" variant="secondary" onClick={() => platform.openLink(URLS.dashboardBilling)}>
          Add funds
        </Button>
      </div>

      <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <For each={MODES}>
          {(mode) => (
            <button
              type="button"
              aria-pressed={billing() !== undefined && billing()!.llm === mode.value}
              disabled={busy() || billing() === undefined || unsupported(mode.value)}
              class="flex min-h-[92px] flex-col gap-1 rounded-[4px] border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              classList={{
                "border-border-strong-base bg-surface-raised-base":
                  billing() !== undefined && billing()!.llm === mode.value,
                "border-border-weak-base bg-surface-base/40 hover:bg-surface-raised-base":
                  billing() === undefined || billing()!.llm !== mode.value,
              }}
              title={
                unsupported(mode.value)
                  ? "Managed inference requires a signed-in account with managed billing enabled"
                  : undefined
              }
              onClick={() => update(mode.value)}
            >
              <span class="text-13-medium text-text-strong">{mode.title}</span>
              <span class="text-12-regular leading-relaxed text-text-weak">{mode.body}</span>
            </button>
          )}
        </For>
      </div>

      <Show when={wallet() && !wallet()!.signedIn}>
        <p class="text-12-regular text-text-weak">
          Sign in from General to enable managed credits. Own-key and automatic routing remain available.
        </p>
      </Show>
    </div>
  )
}
