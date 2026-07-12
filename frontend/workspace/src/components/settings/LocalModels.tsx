// Local models settings panel — add an Ollama / LM Studio / OpenAI-compatible
// endpoint running on this machine. The server (routes/settings/local.ts) does
// the localhost probing/listing the browser can't do cross-origin, and writes
// the provider config block.
import { Component, For, Show, createResource, createSignal } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { uiStore } from "@/atlas/store/ui"
import { settingsApi } from "./api"

interface Detected {
  id: string
  name: string
  baseURL: string
  models: string[]
}
interface Configured {
  id: string
  name: string
  baseURL: string
  models: string[]
}
interface Runtime {
  id: string
  name: string
  baseURL?: string
  installed: boolean
  running: boolean
  models: string[]
  install: string
  serveHint: string
}

const LocalModels: Component = () => {
  const lang = useLanguage()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const fetchFn = platform.fetch ?? fetch

  // Run a command in the workspace terminal (opens a new tab, reveals the pane)
  // and close Settings so the user sees it — for people who prefer the terminal.
  const runInTerminal = (command: string, args: string[], title: string) => {
    uiStore.setTerminalCommand({ command, args, title })
    dialog.close()
  }
  const call = <T,>(path: string, init?: RequestInit) =>
    settingsApi<T>(sdk.url, fetchFn, `/settings/local${path}`, init)

  const [detected, { refetch: refetchDetected }] = createResource(() =>
    call<{ detected: Detected[] }>("/detect").then((r) => r.detected),
  )
  const [configured, { refetch: refetchConfigured }] = createResource(() =>
    call<{ providers: Configured[] }>("/").then((r) => r.providers),
  )
  const [status, { refetch: refetchStatus }] = createResource(() =>
    call<{ runtimes: Runtime[] }>("/status").then((r) => r.runtimes),
  )
  const refetch = () => {
    refetchDetected()
    refetchConfigured()
    refetchStatus()
  }

  const [busy, setBusy] = createSignal(false)
  const guard = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await fn()
      refetch()
    } catch (err) {
      showToast({ title: lang.t(failure), description: err instanceof Error ? err.message : String(err) })
    }
    setBusy(false)
  }

  const addRuntime = (d: Detected) =>
    guard(
      () =>
        call("/", {
          method: "POST",
          body: JSON.stringify({ url: d.baseURL, id: d.id, name: `${d.name} (local)`, models: d.models }),
        }),
      "settings.localModels.toast.addFailed",
    )

  const removeProvider = (id: string) =>
    guard(() => call(`/${encodeURIComponent(id)}`, { method: "DELETE" }), "settings.localModels.toast.removeFailed")

  // ── Start a runtime for the user (host it) ──
  const [starting, setStarting] = createSignal<string>()
  const startRuntime = async (rt: Runtime) => {
    setStarting(rt.id)
    try {
      const r = await call<{
        id: string
        running: boolean
        installed?: boolean
        install?: string
        models?: string[]
      }>("/start", { method: "POST", body: JSON.stringify({ id: rt.id }) })
      if (r.installed === false) {
        showToast({ title: lang.t("settings.localModels.toast.notInstalled", { name: rt.name }), description: lang.t("settings.localModels.toast.notInstalled.description") })
        window.open(r.install ?? rt.install, "_blank", "noopener")
      } else if (r.running && r.models?.length) {
        await call("/", {
          method: "POST",
          body: JSON.stringify({ url: rt.baseURL, id: rt.id, name: `${rt.name} (local)`, models: r.models }),
        })
        showToast({ title: lang.t("settings.localModels.toast.running", { name: rt.name }), description: lang.t("settings.localModels.toast.running.description", { count: r.models.length }) })
      } else if (r.running) {
        showToast({ title: lang.t("settings.localModels.toast.runningNoModels", { name: rt.name }), description: lang.t("settings.localModels.toast.runningNoModels.description") })
      } else {
        showToast({ title: lang.t("settings.localModels.toast.couldNotStart", { name: rt.name }), description: lang.t("settings.localModels.toast.couldNotStart.description") })
      }
      refetch()
    } catch (err) {
      showToast({ title: lang.t("settings.localModels.toast.couldNotStart", { name: rt.name }), description: err instanceof Error ? err.message : String(err) })
    }
    setStarting(undefined)
  }

  const addRunning = (rt: Runtime) =>
    guard(
      () =>
        call("/", {
          method: "POST",
          body: JSON.stringify({ url: rt.baseURL, id: rt.id, name: `${rt.name} (local)`, models: rt.models }),
        }),
      "settings.localModels.toast.addRunningFailed",
    )

  // ── Pull a model (in the terminal, with visible progress) ──
  const [pullName, setPullName] = createSignal("")
  const pull = () => {
    const m = pullName().trim()
    if (!m) return
    runInTerminal("ollama", ["pull", m], `ollama pull ${m}`)
  }

  // ── Custom endpoint flow ──
  const [url, setUrl] = createSignal("")
  const [key, setKey] = createSignal("")
  const [found, setFound] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal<Set<string>>(new Set<string>())
  const [listedUrl, setListedUrl] = createSignal("")

  const listCustom = () =>
    guard(async () => {
      const r = await call<{ baseURL: string; models: string[]; error?: string }>("/models", {
        method: "POST",
        body: JSON.stringify({ url: url().trim(), key: key().trim() || undefined }),
      })
      if (r.error || !r.models.length) {
        showToast({ title: lang.t("settings.localModels.toast.noModelsFound"), description: r.error ?? lang.t("settings.localModels.toast.noModelsFound.description") })
      }
      setFound(r.models)
      setSelected(new Set(r.models))
      setListedUrl(r.baseURL)
    }, "settings.localModels.toast.couldNotReachEndpoint")

  const toggle = (m: string) => {
    const next = new Set(selected())
    next.has(m) ? next.delete(m) : next.add(m)
    setSelected(next)
  }

  const addCustom = () =>
    guard(async () => {
      const models = [...selected()]
      if (!models.length) throw new Error(lang.t("settings.localModels.toast.selectAtLeastOne"))
      await call("/", {
        method: "POST",
        body: JSON.stringify({ url: url().trim(), key: key().trim() || undefined, models }),
      })
      setUrl("")
      setKey("")
      setFound([])
      setSelected(new Set<string>())
      setListedUrl("")
    }, "settings.localModels.toast.addFailed")

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[820px]">
          <h2 class="text-16-medium text-text-strong">{lang.t("settings.localModels.heading")}</h2>
          <p class="text-13-regular text-text-weak">
            {lang.t("settings.localModels.description")}
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 px-4 pb-12 sm:px-8 max-w-[820px]">
        {/* ── Run locally (host it for the user) ── */}
        <section class="flex flex-col gap-3">
          <h3 class="text-13-medium text-text-strong">{lang.t("settings.localModels.section.runLocally")}</h3>
          <p class="text-12-regular text-text-weak/70">
            {lang.t("settings.localModels.section.runLocally.description")}
          </p>
          <For each={status()}>
            {(rt) => (
              <div class="flex items-center justify-between border border-border-weak-base rounded-[4px] p-3 bg-surface-base/40">
                <div class="flex flex-col gap-0.5">
                  <span class="text-13-medium text-text-strong flex items-center gap-1.5">
                    <Show when={rt.running}>
                      <Icon name="check" class="text-text-success" />
                    </Show>
                    {rt.name}
                  </span>
                  <span class="text-11-regular text-text-weak">
                    <Show
                      when={!rt.installed}
                      fallback={rt.running ? lang.t("settings.localModels.status.runningWithModels", { count: rt.models.length }) : lang.t("settings.localModels.status.installedNotRunning")}
                    >
                      {lang.t("settings.localModels.status.notInstalled")} — <code>{rt.serveHint}</code>
                    </Show>
                  </span>
                </div>
                <Show
                  when={rt.installed}
                  fallback={
                    <Button
                      size="small"
                      variant="secondary"
                      onClick={() => window.open(rt.install, "_blank", "noopener")}
                    >
                      {lang.t("settings.localModels.action.install")}
                    </Button>
                  }
                >
                  <Show
                    when={rt.running}
                    fallback={
                      <Button
                        size="small"
                        variant="primary"
                        disabled={busy() || !!starting()}
                        onClick={() => startRuntime(rt)}
                      >
                        {starting() === rt.id ? lang.t("settings.localModels.status.starting") : lang.t("settings.localModels.action.start")}
                      </Button>
                    }
                  >
                    <Button
                      size="small"
                      variant="primary"
                      disabled={busy() || rt.models.length === 0}
                      onClick={() => addRunning(rt)}
                    >
                      {lang.t("settings.localModels.action.addModels", { count: rt.models.length })}
                    </Button>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </section>

        {/* ── Pull a model (Ollama, via the terminal) ── */}
        <section class="flex flex-col gap-2">
          <h3 class="text-13-medium text-text-strong">{lang.t("settings.localModels.section.pullModel")}</h3>
          <p class="text-12-regular text-text-weak/70">
            {lang.t("settings.localModels.section.pullModel.description")}
          </p>
          <div class="flex gap-2">
            <input
              class="flex-1 rounded-[4px] border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
              placeholder="llama3.1  ·  qwen2.5-coder  ·  phi3"
              value={pullName()}
              onInput={(e) => setPullName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && pull()}
            />
            <Button size="small" variant="secondary" disabled={!pullName().trim()} onClick={pull}>
              {lang.t("settings.localModels.action.pullInTerminal")}
            </Button>
          </div>
          <p class="text-11-regular text-text-weak/60">
            {lang.t("settings.localModels.section.pullModel.terminalHint")}{" "}
            <button
              class="underline hover:text-text-strong"
              onClick={() => runInTerminal("ollama", ["serve"], "ollama serve")}
            >
              ollama serve
            </button>
          </p>
        </section>

        {/* ── Detected runtimes ── */}
        <section class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <h3 class="text-13-medium text-text-strong">{lang.t("settings.localModels.section.detected")}</h3>
            <Button size="small" variant="secondary" disabled={busy()} onClick={refetch}>
              {lang.t("settings.localModels.action.rescan")}
            </Button>
          </div>
          <Show
            when={(detected()?.length ?? 0) > 0}
            fallback={
              <p class="text-12-regular text-text-weak/70">
                {lang.t("settings.localModels.empty.nothingRunning")}
              </p>
            }
          >
            <For each={detected()}>
              {(d) => (
                <div class="flex items-center justify-between border border-border-weak-base rounded-[4px] p-3 bg-surface-base/40">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-13-medium text-text-strong flex items-center gap-1.5">
                      <Icon name="check" class="text-text-success" /> {d.name}
                    </span>
                    <span class="text-11-regular text-text-weak">
                      {d.baseURL} · {lang.t("settings.localModels.status.modelCount", { count: d.models.length })}
                    </span>
                  </div>
                  <Button size="small" variant="primary" disabled={busy()} onClick={() => addRuntime(d)}>
                    {lang.t("settings.localModels.action.addModels", { count: d.models.length })}
                  </Button>
                </div>
              )}
            </For>
          </Show>
        </section>

        {/* ── Custom endpoint ── */}
        <section class="flex flex-col gap-3">
          <h3 class="text-13-medium text-text-strong">{lang.t("settings.localModels.section.customEndpoint")}</h3>
          <div class="flex flex-col gap-2">
            <input
              class="w-full rounded-[4px] border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
              placeholder="http://localhost:11434/v1"
              value={url()}
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
            <input
              class="w-full rounded-[4px] border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
              placeholder={lang.t("settings.localModels.placeholder.apiKey")}
              value={key()}
              onInput={(e) => setKey(e.currentTarget.value)}
            />
            <div class="flex gap-2">
              <Button size="small" variant="secondary" disabled={busy() || !url().trim()} onClick={listCustom}>
                {lang.t("settings.localModels.action.listModels")}
              </Button>
              <Show when={found().length > 0}>
                <Button size="small" variant="primary" disabled={busy() || selected().size === 0} onClick={addCustom}>
                  {lang.t("settings.localModels.action.addSelected", { count: selected().size })}
                </Button>
              </Show>
            </div>
          </div>
          <Show when={found().length > 0}>
            <div class="flex flex-col gap-1 border border-border-weak-base rounded-[4px] p-2 bg-surface-base/40">
              <span class="text-11-regular text-text-weak px-1">{listedUrl()}</span>
              <For each={found()}>
                {(m) => (
                  <label class="flex items-center gap-2 px-1 py-1 text-13-regular text-text-strong cursor-pointer">
                    <input type="checkbox" checked={selected().has(m)} onChange={() => toggle(m)} />
                    {m}
                  </label>
                )}
              </For>
            </div>
          </Show>
        </section>

        {/* ── Configured ── */}
        <section class="flex flex-col gap-3">
          <h3 class="text-13-medium text-text-strong">{lang.t("settings.localModels.section.configured")}</h3>
          <Show
            when={(configured()?.length ?? 0) > 0}
            fallback={<p class="text-12-regular text-text-weak/70">{lang.t("settings.localModels.empty.noProviders")}</p>}
          >
            <For each={configured()}>
              {(p) => (
                <div class="flex items-center justify-between border border-border-weak-base rounded-[4px] p-3 bg-surface-base/40">
                  <div class="flex flex-col gap-0.5">
                    <span class="text-13-medium text-text-strong">{p.id}</span>
                    <span class="text-11-regular text-text-weak">
                      {p.baseURL} · {lang.t("settings.localModels.status.modelCount", { count: p.models.length })}
                    </span>
                  </div>
                  <Button
                    size="small"
                    variant="ghost"
                    icon="trash"
                    disabled={busy()}
                    onClick={() => removeProvider(p.id)}
                    >
                      {lang.t("common.remove")}
                    </Button>
                </div>
              )}
            </For>
          </Show>
        </section>
      </div>
    </div>
  )
}

export default LocalModels
