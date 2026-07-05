// Usage — managed-compute wallet, plan, weekly/session spend, and a real
// "where tokens go" breakdown. Everything is wired to a real endpoint:
//   • Wallet + plan + billing mode → client.account.get (OpenScience getBalance +
//     subscription). Managed compute is billed from this wallet.
//   • Weekly / session bars + per-model breakdown → /settings/usage, which sums
//     the actual cost + tokens recorded on assistant messages across sessions.
//   • Extra usage budget → /settings/preferences (real JSON store).
//   • Buy credits → opens the Atlas top-up / checkout (URLS.dashboardCli).
import { Component, For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { useParams } from "@solidjs/router"
import { Button } from "@synsci/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { URLS } from "@/config/urls"
import { FONT_CODE, FONT_SANS, sectionTitle } from "@/styles/tokens"
import { decode64 } from "@/utils/base64"
import { settingsApi } from "./api"

type Account = {
  session?: boolean
  user?: { subscription_plan?: string } & Record<string, unknown>
  balance_usd?: number
  billing_mode?: { mode: "byok" | "managed" } | null
}

type Tokens = { input: number; output: number; reasoning: number; cache_read: number; cache_write: number }
type Usage = {
  sessions: number
  total: { cost: number; tokens: Tokens }
  latest: { id: string; title: string; cost: number; tokens: Tokens } | null
  weekly: { date: string; cost: number; tokens: number }[]
  by_model: { key: string; provider: string; model: string; cost: number; tokens: number }[]
}
type Preferences = { extra_budget_usd: number }

const money = (n: number) => `$${(n < 0 ? 0 : n).toFixed(n >= 100 ? 0 : 2)}`
const compact = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}
const tokenSum = (t: Tokens) => t.input + t.output + t.reasoning + t.cache_read + t.cache_write

export default function Usage() {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()
  const params = useParams()

  const fetchFn = () => platform.fetch ?? fetch
  const base = () => server.url
  const directory = () => decode64(params.dir) ?? ""

  const [account, setAccount] = createSignal<Account>()
  const [usage, setUsage] = createSignal<Usage>()
  const [budget, setBudget] = createSignal(0)
  const [budgetDraft, setBudgetDraft] = createSignal("")
  const [error, setError] = createSignal<string>()

  const load = async () => {
    try {
      const acc = await sdk.client.account.get()
      setAccount(((acc as any).data ?? acc) as Account)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    try {
      const dir = directory()
      const q = dir ? `?directory=${encodeURIComponent(dir)}` : ""
      setUsage(await settingsApi<Usage>(base(), fetchFn(), `/settings/usage${q}`))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    try {
      const prefs = await settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences")
      setBudget(prefs.extra_budget_usd)
      setBudgetDraft(prefs.extra_budget_usd ? String(prefs.extra_budget_usd) : "")
    } catch {}
  }
  // Refetch when the window regains focus so a dashboard top-up (buy credits
  // opens a new tab) shows up as soon as the user comes back.
  const focus = () => void load()
  onMount(() => {
    void load()
    window.addEventListener("focus", focus)
  })
  onCleanup(() => window.removeEventListener("focus", focus))

  const saveBudget = async () => {
    const value = Math.max(0, Number(budgetDraft()) || 0)
    try {
      const next = await settingsApi<Preferences>(base(), fetchFn(), "/settings/preferences", {
        method: "PATCH",
        body: JSON.stringify({ extra_budget_usd: value }),
      })
      setBudget(next.extra_budget_usd)
      setBudgetDraft(next.extra_budget_usd ? String(next.extra_budget_usd) : "")
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Distinguish "no data yet" and "signed out" from real account values — the
  // panel must not present "Free"/"byok" defaults as if they came from Atlas.
  const loading = () => account() === undefined
  const signedOut = () => account()?.session === false
  const plan = () => (account()?.user?.subscription_plan as string | undefined) ?? "Free"
  const balance = () => account()?.balance_usd
  const managed = () => account()?.billing_mode?.mode === "managed"
  const weekTotal = createMemo(() => usage()?.weekly.reduce((a, d) => a + d.cost, 0) ?? 0)
  const weekMax = createMemo(() => Math.max(0.0001, ...(usage()?.weekly ?? []).map((d) => d.cost)))
  const modelMax = createMemo(() => Math.max(0.0001, ...(usage()?.by_model ?? []).map((m) => m.cost)))

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-8">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-8 pb-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">Usage</h2>
          <p class="text-13-regular text-text-weak">
            Managed compute is billed from your wallet. Track spend, top up, and see where tokens go.
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

        {/* Plan + wallet */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-13-medium text-text-weak tracking-wide">Plan &amp; wallet</h3>
            <p class="text-12-regular text-text-weak">Your subscription and managed-compute balance.</p>
          </div>
          <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
            <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-4 border-b border-border-weak-base">
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Plan</span>
                <Show
                  when={!loading() && !signedOut()}
                  fallback={<span class="text-16-medium text-text-weak">{loading() ? "…" : "—"}</span>}
                >
                  <span class="text-16-medium text-text-strong capitalize">{plan()}</span>
                </Show>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Wallet balance</span>
                <Show
                  when={!loading() && !signedOut() && typeof balance() === "number" && balance()! >= 0}
                  fallback={<span class="text-16-medium text-text-weak">{loading() ? "…" : "—"}</span>}
                >
                  <span class="text-16-medium text-text-strong">{money(balance()!)}</span>
                </Show>
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-12-regular text-text-weak">Billing</span>
                <Show
                  when={!loading() && !signedOut()}
                  fallback={<span class="text-13-medium text-text-weak">{loading() ? "…" : "—"}</span>}
                >
                  <span class="text-13-medium text-text-strong capitalize">
                    {account()?.billing_mode?.mode ?? "byok"}
                  </span>
                </Show>
              </div>
              <Button size="small" variant="primary" onClick={() => platform.openLink(URLS.dashboardCli)}>
                buy credits
              </Button>
            </div>
            <div class="px-4 py-3">
              <p class="text-12-regular text-text-weak">
                <Show when={!loading()} fallback="Checking your Atlas account…">
                  <Show
                    when={!signedOut()}
                    fallback={
                      <>
                        Not connected — run{" "}
                        <code style={{ "font-family": FONT_CODE, "font-size": "11px" }}>openscience connect login</code>{" "}
                        in a terminal to see your plan and wallet.
                      </>
                    }
                  >
                    <Show
                      when={managed()}
                      fallback="You're on BYOK — provider calls are billed directly by each provider. Switch LLM spend to managed in Settings → Spend to bill from this wallet."
                    >
                      Managed calls debit this wallet. Top up any time — credits never expire.
                    </Show>
                  </Show>
                </Show>
              </p>
            </div>
          </div>
        </div>

        {/* This week */}
        <div class="flex flex-col gap-3">
          <div class="flex items-baseline justify-between">
            <h3 class="text-13-medium text-text-weak tracking-wide">This week</h3>
            <span class="text-12-regular text-text-weak">
              {money(weekTotal())} · {compact(usage()?.weekly.reduce((a, d) => a + d.tokens, 0) ?? 0)} tokens
            </span>
          </div>
          <div class="border border-border-weak-base rounded-[4px] bg-surface-base/40 px-4 py-4">
            <div class="flex items-end justify-between gap-2 h-[104px]">
              <For each={usage()?.weekly ?? []}>
                {(d) => (
                  <div class="flex flex-col items-center gap-1.5 flex-1 min-w-0 h-full justify-end">
                    <div
                      class="w-full max-w-[34px] rounded-xs"
                      style={{
                        height: `${Math.max(3, (d.cost / weekMax()) * 84)}px`,
                        background:
                          d.cost > 0
                            ? "var(--color-text-interactive-base, var(--icon-strong-base))"
                            : "var(--color-border-strong)",
                        opacity: d.cost > 0 ? 1 : 0.4,
                        transition: "height 160ms",
                      }}
                      title={`${d.date}: ${money(d.cost)}`}
                    />
                    <span class="text-11-regular text-text-weak/80">{d.date.slice(5)}</span>
                  </div>
                )}
              </For>
            </div>
          </div>
        </div>

        {/* Extra usage budget */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-13-medium text-text-weak tracking-wide">Extra usage budget</h3>
            <p class="text-12-regular text-text-weak">
              A personal managed-compute ceiling. Set 0 for no extra budget beyond your plan.
            </p>
          </div>
          <div class="border border-border-weak-base rounded-[4px] bg-surface-base/40 px-4 py-4 flex flex-col gap-3">
            <form
              class="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void saveBudget()
              }}
            >
              <label class="flex flex-col gap-1 w-[160px]">
                <span style={sectionTitle}>Budget (USD)</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={budgetDraft()}
                  onInput={(e) => setBudgetDraft(e.currentTarget.value)}
                  placeholder="0"
                  style={fieldStyle()}
                />
              </label>
              <Button
                type="submit"
                size="small"
                variant="secondary"
                disabled={String(budget()) === (budgetDraft() || "0")}
              >
                save
              </Button>
            </form>
            <Show when={budget() > 0}>
              <div class="flex flex-col gap-1">
                <div class="h-2 rounded-full overflow-hidden bg-surface-base">
                  <div
                    class="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, (weekTotal() / budget()) * 100)}%`,
                      background:
                        weekTotal() >= budget()
                          ? "var(--color-error)"
                          : "var(--color-text-interactive-base, var(--icon-strong-base))",
                    }}
                  />
                </div>
                <span class="text-11-regular text-text-weak">
                  {money(weekTotal())} of {money(budget())} used this week
                </span>
              </div>
            </Show>
          </div>
        </div>

        {/* Current session */}
        <Show when={usage()?.latest}>
          {(latest) => (
            <div class="flex flex-col gap-3">
              <h3 class="text-13-medium text-text-weak tracking-wide">Most recent session</h3>
              <div class="border border-border-weak-base rounded-[4px] bg-surface-base/40 px-4 py-4 flex items-center justify-between gap-4">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="text-13-medium text-text-strong truncate">{latest().title}</span>
                  <span class="text-12-regular text-text-weak">{compact(tokenSum(latest().tokens))} tokens</span>
                </div>
                <span class="text-14-medium text-text-strong">{money(latest().cost)}</span>
              </div>
            </div>
          )}
        </Show>

        {/* Where tokens go */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-0.5">
            <h3 class="text-13-medium text-text-weak tracking-wide">Where tokens go</h3>
            <p class="text-12-regular text-text-weak">
              Spend per model across {usage()?.sessions ?? 0} local sessions.
            </p>
          </div>
          <Show
            when={(usage()?.by_model.length ?? 0) > 0}
            fallback={
              <div
                class="text-12-regular text-text-weak"
                style={{ border: "1px dashed var(--color-border-strong)", "border-radius": "4px", padding: "16px" }}
              >
                No local usage recorded yet. Run a session and spend will show up here.
              </div>
            }
          >
            <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
              <For each={usage()?.by_model ?? []}>
                {(m) => (
                  <div class="flex flex-col gap-1.5 px-4 py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-13-regular text-text-strong truncate">{m.model}</span>
                      <span class="text-13-regular text-text-weak flex-shrink-0">
                        {money(m.cost)} · {compact(m.tokens)}
                      </span>
                    </div>
                    <div class="h-1.5 rounded-full overflow-hidden bg-surface-base">
                      <div
                        class="h-full rounded-full"
                        style={{
                          width: `${Math.max(2, (m.cost / modelMax()) * 100)}%`,
                          background: "var(--color-text-interactive-base, var(--icon-strong-base))",
                        }}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

function fieldStyle(): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    width: "100%",
    height: "36px",
    padding: "0 12px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid, var(--color-bg))",
    "font-family": FONT_CODE,
    "font-size": "13px",
    color: "var(--color-text)",
    cursor: "text",
  }
}
