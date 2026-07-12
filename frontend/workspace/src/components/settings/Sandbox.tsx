// Execution sandbox settings — the permission system decides *whether* the agent
// runs a shell command; it is not an isolation boundary. This panel turns on a
// real one: macOS Seatbelt / Linux bubblewrap that confines the agent's writes
// to the workspace and can deny network egress. The server
// (routes/settings/sandbox.ts) reports backend availability, persists the
// config, and runs the empirical self-test the browser can't. Mirrors the
// `openscience sandbox` CLI.
import { Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { Select } from "@synsci/ui/select"
import { Button } from "@synsci/ui/button"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"

interface SandboxConfig {
  enabled?: boolean
  network?: "allow" | "deny"
  allowWrite?: string[]
  onUnavailable?: "warn" | "error" | "allow"
}
interface Status {
  platform: string
  backend: "seatbelt" | "bubblewrap" | "none"
  available: boolean
  tool?: string
  reason?: string
}
interface Payload {
  config: SandboxConfig
  status: Status
}
interface Check {
  name: string
  pass: boolean
  skipped?: boolean
  detail?: string
}
interface SelfTest {
  backend: string
  available: boolean
  checks: Check[]
  ok: boolean
}

const NETWORK_OPTS = [
  { value: "allow" as const, label: "settings.sandbox.network.allow" },
  { value: "deny" as const, label: "settings.sandbox.network.deny" },
]
const UNAVAILABLE_OPTS = [
  { value: "warn" as const, label: "settings.sandbox.unavailable.warn" },
  { value: "error" as const, label: "settings.sandbox.unavailable.refuse" },
  { value: "allow" as const, label: "settings.sandbox.unavailable.allow" },
]

const Sandbox: Component = () => {
  const lang = useLanguage()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const call = <T,>(path: string, init?: RequestInit) =>
    settingsApi<T>(sdk.url, fetchFn, `/settings/sandbox${path}`, init)

  const [data, { mutate, refetch }] = createResource(() => call<Payload>(""))
  const [busy, setBusy] = createSignal(false)
  const [test, setTest] = createSignal<SelfTest>()
  const [testing, setTesting] = createSignal(false)
  const [newPath, setNewPath] = createSignal("")

  const networkOpts = createMemo(() => NETWORK_OPTS.map((o) => ({ value: o.value, label: lang.t(o.label) })))
  const unavailableOpts = createMemo(() => UNAVAILABLE_OPTS.map((o) => ({ value: o.value, label: lang.t(o.label) })))

  const config = () => data()?.config ?? {}
  const status = () => data()?.status

  const patch = async (body: SandboxConfig, failure: string) => {
    setBusy(true)
    try {
      mutate(await call<Payload>("", { method: "PUT", body: JSON.stringify(body) }))
    } catch (err) {
      showToast({ title: lang.t(failure), description: err instanceof Error ? err.message : String(err) })
      refetch()
    }
    setBusy(false)
  }

  const runTest = async () => {
    setTesting(true)
    try {
      setTest(await call<SelfTest>("/test", { method: "POST" }))
    } catch (err) {
      showToast({ title: lang.t("settings.sandbox.toast.selfTestFailed"), description: err instanceof Error ? err.message : String(err) })
    }
    setTesting(false)
  }

  const addPath = () => {
    const p = newPath().trim()
    if (!p) return
    if (!p.startsWith("/")) {
      showToast({ title: lang.t("settings.sandbox.toast.absolutePathRequired"), description: lang.t("settings.sandbox.toast.absolutePathRequired.description") })
      return
    }
    const next = [...(config().allowWrite ?? [])]
    if (!next.includes(p)) next.push(p)
    setNewPath("")
    patch({ allowWrite: next }, "settings.sandbox.toast.couldNotAddPath")
  }
  const removePath = (p: string) =>
    patch({ allowWrite: (config().allowWrite ?? []).filter((x) => x !== p) }, "settings.sandbox.toast.couldNotRemovePath")

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[820px]">
          <h2 class="text-16-medium text-text-strong">{lang.t("settings.sandbox.heading")}</h2>
          <p class="text-13-regular text-text-weak">
            {lang.t("settings.sandbox.description")}
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 px-4 pb-12 sm:px-8 max-w-[820px]">
        {/* ── Backend availability ── */}
        <Show when={status()}>
          {(s) => (
            <div
              class="flex items-center gap-2 rounded-[4px] border px-4 py-3 text-12-regular"
              classList={{
                "border-border-weak-base bg-surface-base/40 text-text-weak": s().available,
                "border-text-warning/30 bg-text-warning/5 text-text-warning": !s().available,
              }}
            >
              <Icon name={s().available ? "check" : "stop"} class={s().available ? "text-text-success" : ""} />
              <Show
                when={s().available}
                fallback={
                  <span>
                    {lang.t("settings.sandbox.status.noBackend", { platform: s().platform, reason: s().reason ?? "" })}
                  </span>
                }
              >
                <span>
                  {lang.t("settings.sandbox.status.backendReady", { backend: s().backend ?? "", tool: s().tool ?? "", platform: s().platform })}
                </span>
              </Show>
            </div>
          )}
        </Show>

        {/* ── Enable ── */}
        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between border border-border-weak-base rounded-[4px] px-4 py-3.5 bg-surface-base/40">
            <div class="flex flex-col gap-0.5 min-w-0 pr-4">
              <span class="text-14-medium text-text-strong">{lang.t("settings.sandbox.row.sandboxCommands.title")}</span>
              <span class="text-12-regular text-text-weak">
                {config().enabled
                  ? lang.t("settings.sandbox.status.on")
                  : lang.t("settings.sandbox.status.off")}
              </span>
            </div>
            <Switch
              checked={config().enabled === true}
              disabled={busy()}
              onChange={(checked) => patch({ enabled: checked }, "settings.sandbox.toast.couldNotUpdateSandbox")}
            />
          </div>
        </section>

        {/* ── Options (only when enabled) ── */}
        <Show when={config().enabled}>
          <section class="flex flex-col gap-4">
            <h3 class="text-13-medium text-text-strong">{lang.t("settings.sandbox.section.policy")}</h3>

            <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
              <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5 border-b border-border-weak-base">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="text-14-medium text-text-strong">{lang.t("settings.sandbox.row.networkEgress.title")}</span>
                  <span class="text-12-regular text-text-weak">
                    {lang.t("settings.sandbox.row.networkEgress.description")}
                  </span>
                </div>
                <Select
                  options={networkOpts()}
                  current={networkOpts().find((o) => o.value === (config().network ?? "allow"))}
                  value={(o) => o.value}
                  label={(o) => o.label}
                  onSelect={(o) => o && patch({ network: o.value }, "settings.sandbox.toast.couldNotUpdateNetwork")}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </div>

              <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="text-14-medium text-text-strong">{lang.t("settings.sandbox.row.noBackend.title")}</span>
                  <span class="text-12-regular text-text-weak">
                    {lang.t("settings.sandbox.row.noBackend.description")}
                  </span>
                </div>
                <Select
                  options={unavailableOpts()}
                  current={unavailableOpts().find((o) => o.value === (config().onUnavailable ?? "warn"))}
                  value={(o) => o.value}
                  label={(o) => o.label}
                  onSelect={(o) => o && patch({ onUnavailable: o.value }, "settings.sandbox.toast.couldNotUpdateFallback")}
                  variant="secondary"
                  size="small"
                  triggerVariant="settings"
                />
              </div>
            </div>

            {/* extra writable paths */}
            <div class="flex flex-col gap-2">
              <span class="text-13-medium text-text-strong">{lang.t("settings.sandbox.section.extraWritablePaths")}</span>
              <span class="text-12-regular text-text-weak/70">
                {lang.t("settings.sandbox.section.extraWritablePaths.description")}
              </span>
              <For each={config().allowWrite ?? []}>
                {(p) => (
                  <div class="flex items-center justify-between border border-border-weak-base rounded-[4px] px-3 py-2 bg-surface-base/40">
                    <code class="text-12-regular text-text-strong truncate">{p}</code>
                    <Button size="small" variant="secondary" disabled={busy()} onClick={() => removePath(p)}>
                      <Icon name="trash" />
                    </Button>
                  </div>
                )}
              </For>
              <div class="flex items-center gap-2">
                <input
                  class="flex-1 bg-surface-base/40 border border-border-weak-base rounded-[4px] px-3 py-2 text-12-regular text-text-strong outline-none focus:border-border-strong"
                  placeholder="/absolute/path"
                  value={newPath()}
                  onInput={(e) => setNewPath(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && addPath()}
                />
                <Button size="small" variant="secondary" disabled={busy() || !newPath().trim()} onClick={addPath}>
                  {lang.t("settings.sandbox.action.add")}
                </Button>
              </div>
            </div>

            {/* self-test */}
            <div class="flex flex-col gap-3 border border-border-weak-base rounded-[4px] p-4 bg-surface-base/40">
              <div class="flex items-center justify-between gap-4">
                <div class="flex flex-col gap-0.5">
                  <span class="text-14-medium text-text-strong">{lang.t("settings.sandbox.row.verifyContainment.title")}</span>
                  <span class="text-12-regular text-text-weak">
                    {lang.t("settings.sandbox.row.verifyContainment.description")}
                  </span>
                </div>
                <Button size="small" variant="secondary" disabled={testing() || !status()?.available} onClick={runTest}>
                  {testing() ? lang.t("settings.sandbox.status.testing") : lang.t("settings.sandbox.action.runSelfTest")}
                </Button>
              </div>
              <Show when={test()}>
                {(t) => (
                  <div class="flex flex-col gap-1.5 pt-1">
                    <For each={t().checks}>
                      {(c) => (
                        <div class="flex items-center gap-2 text-12-regular">
                          <Icon
                            name={c.skipped ? "dash" : c.pass ? "check" : "close"}
                            class={c.skipped ? "text-text-weak" : c.pass ? "text-text-success" : "text-text-danger"}
                          />
                          <span class="text-text-strong">{c.name}</span>
                          <Show when={c.detail}>
                            <span class="text-text-weak/70">— {c.detail}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                    <span
                      class="text-12-medium pt-1"
                      classList={{ "text-text-success": t().ok, "text-text-danger": !t().ok }}
                    >
                      {t().ok ? lang.t("settings.sandbox.status.containmentVerified") : lang.t("settings.sandbox.status.containmentFailed")}
                    </span>
                  </div>
                )}
              </Show>
            </div>
          </section>
        </Show>
      </div>
    </div>
  )
}

export default Sandbox
