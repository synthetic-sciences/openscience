// Local models settings panel — add an Ollama / LM Studio / OpenAI-compatible
// endpoint running on this machine. The server (routes/settings/local.ts) does
// the localhost probing/listing the browser can't do cross-origin, and writes
// the provider config block.
import { Component, For, Show, createResource, createSignal } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"

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
  runtime?: string
}
interface Runtime {
  id: string
  name: string
  baseURL: string
  installed: boolean
  running: boolean
  models: string[]
  install: string
  serveHint: string
}

const LocalModels: Component = () => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch

  const copyCommand = (command: string) => {
    if (!navigator.clipboard) {
      showToast({ title: "Couldn't copy command", description: "Clipboard access is unavailable." })
      return
    }
    return navigator.clipboard.writeText(command).then(
      () => showToast({ title: "Command copied", description: command }),
      (error) =>
        showToast({
          title: "Couldn't copy command",
          description: error instanceof Error ? error.message : String(error),
        }),
    )
  }
  const call = <T,>(path: string, init?: RequestInit) =>
    settingsApi<T>(sdk.url, fetchFn, `/settings/local${path}`, init)

  const [detected, { refetch: refetchDetected }] = createResource(() =>
    call<{ detected: Detected[] }>("/detect").then((r) => r.detected),
  )
  const [configured, { refetch: refetchConfigured }] = createResource(() =>
    call<{ providers: Configured[] }>("").then((r) => r.providers),
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
  const [context, setContext] = createSignal("32768")
  const guard = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    try {
      await fn()
      refetch()
    } catch (err) {
      showToast({ title: failure, description: err instanceof Error ? err.message : String(err) })
    }
    setBusy(false)
  }

  const isOllama = (id: string | undefined, url: string) => {
    if (id === "ollama") return true
    try {
      return new URL(url).port === "11434"
    } catch {
      return false
    }
  }
  const register = async (input: { url: string; models: string[]; id?: string; name?: string; key?: string }) => {
    const ollama = isOllama(input.id, input.url)
    const tokens = Number(context())
    if (ollama && (!Number.isInteger(tokens) || tokens < 1_024 || tokens > 2_097_152)) {
      throw new Error("Context must be an integer between 1,024 and 2,097,152 tokens.")
    }
    const models = ollama
      ? await Promise.all(
          input.models.map((model) =>
            call<{ model: string }>("/context", {
              method: "POST",
              body: JSON.stringify({ url: input.url, model, context: tokens }),
            }).then((result) => result.model),
          ),
        )
      : input.models
    return call("", {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        id: input.id,
        name: input.name,
        key: input.key,
        models,
        contextLimit: ollama ? tokens : undefined,
        runtime: ollama ? "ollama" : undefined,
      }),
    })
  }

  const addRuntime = (d: Detected) =>
    guard(
      () => register({ url: d.baseURL, id: d.id, name: `${d.name} (local)`, models: d.models }),
      "Failed to add local models",
    )

  const removeProvider = (id: string) =>
    guard(() => call(`/${encodeURIComponent(id)}`, { method: "DELETE" }), "Failed to remove provider")

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
        showToast({ title: `${rt.name} isn't installed`, description: `Install it, then start it here.` })
        window.open(r.install ?? rt.install, "_blank", "noopener")
      } else if (r.running && r.models?.length) {
        await register({ url: rt.baseURL, id: rt.id, name: `${rt.name} (local)`, models: r.models })
        showToast({ title: `${rt.name} is running`, description: `Added ${r.models.length} model(s).` })
      } else if (r.running) {
        showToast({ title: `${rt.name} is running`, description: "No models yet — pull one below, then rescan." })
      } else {
        showToast({ title: `Couldn't start ${rt.name}`, description: "The server didn't come up in time." })
      }
      refetch()
    } catch (err) {
      showToast({ title: `Couldn't start ${rt.name}`, description: err instanceof Error ? err.message : String(err) })
    }
    setStarting(undefined)
  }

  const addRunning = (rt: Runtime) =>
    guard(
      () => register({ url: rt.baseURL ?? "", id: rt.id, name: `${rt.name} (local)`, models: rt.models }),
      "Failed to add models",
    )

  // ── Pull a model ──
  const [pullName, setPullName] = createSignal("")
  const pull = () => {
    const m = pullName().trim()
    if (!m) return
    void copyCommand(`ollama pull ${m}`)
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
        showToast({ title: "No models found", description: r.error ?? "The endpoint returned no models." })
      }
      setFound(r.models)
      setSelected(new Set(r.models))
      setListedUrl(r.baseURL)
    }, "Couldn't reach the endpoint")

  const toggle = (m: string) => {
    const next = new Set(selected())
    next.has(m) ? next.delete(m) : next.add(m)
    setSelected(next)
  }

  const addCustom = () =>
    guard(async () => {
      const models = [...selected()]
      if (!models.length) throw new Error("Select at least one model.")
      await register({ url: url().trim(), key: key().trim() || undefined, models })
      setUrl("")
      setKey("")
      setFound([])
      setSelected(new Set<string>())
      setListedUrl("")
    }, "Failed to add local models")

  return (
    <PanelScroll>
      <PanelHeader
        title="Local models"
        description="Run Ollama, LM Studio, llama.cpp, vLLM, or another OpenAI-compatible endpoint on this machine."
      />
      <PanelBody>
        <div class="flex flex-col gap-8">
          {/* ── Run locally (host it for the user) ── */}
          <section class="flex flex-col gap-3">
            <h3 class="text-13-medium text-text-strong">Run a model locally</h3>
            <p class="text-12-regular text-text-weak/70">
              Let OpenScience start and host a runtime for you — no terminal needed.
            </p>
            <div class="flex flex-col gap-2 border border-border-weak-base rounded-[4px] p-3 bg-surface-base/40">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-13-medium text-text-strong">Ollama context window</span>
                  <span class="text-11-regular text-text-weak">Applied when an Ollama model is added.</span>
                </div>
                <div class="flex items-center gap-2">
                  <input
                    class="w-32 rounded-[4px] border border-border-weak-base bg-surface-base px-3 py-2 text-right font-mono text-13-regular text-text-strong"
                    type="number"
                    min="1024"
                    max="2097152"
                    step="1024"
                    aria-label="Ollama context window in tokens"
                    value={context()}
                    onInput={(event) => setContext(event.currentTarget.value)}
                  />
                  <span class="text-11-regular text-text-weak">tokens</span>
                </div>
              </div>
              <p class="text-11-regular text-text-weak/70">
                OpenScience creates a lightweight tuned alias, so Ollama applies the real <code>num_ctx</code> value.
                Larger windows use more memory.
              </p>
            </div>
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
                        fallback={rt.running ? `running · ${rt.models.length} model(s)` : "installed · not running"}
                      >
                        not installed — <code>{rt.serveHint}</code>
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
                        Install
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
                          {starting() === rt.id ? "Starting…" : "Start"}
                        </Button>
                      }
                    >
                      <Button
                        size="small"
                        variant="primary"
                        disabled={busy() || rt.models.length === 0}
                        onClick={() => addRunning(rt)}
                      >
                        Add {rt.models.length}
                      </Button>
                    </Show>
                  </Show>
                </div>
              )}
            </For>
          </section>

          {/* ── Pull a model (Ollama) ── */}
          <section class="flex flex-col gap-2">
            <h3 class="text-13-medium text-text-strong">Pull a model</h3>
            <p class="text-12-regular text-text-weak/70">
              Copy an <code>ollama pull</code> command, then run it in your terminal to download the model.
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
                Copy command
              </Button>
            </div>
            <p class="text-11-regular text-text-weak/60">
              Need to start Ollama first? Copy this command:{" "}
              <button
                class="underline hover:text-text-strong"
                aria-label="Copy ollama serve command"
                onClick={() => void copyCommand("ollama serve")}
              >
                ollama serve
              </button>
            </p>
          </section>

          {/* ── Detected runtimes ── */}
          <section class="flex flex-col gap-3">
            <div class="flex items-center justify-between">
              <h3 class="text-13-medium text-text-strong">Detected on this machine</h3>
              <Button size="small" variant="secondary" disabled={busy()} onClick={refetch}>
                Rescan
              </Button>
            </div>
            <Show
              when={(detected()?.length ?? 0) > 0}
              fallback={
                <p class="text-12-regular text-text-weak/70">
                  Nothing running yet. Start a server (e.g. <code>ollama serve</code>) and select Rescan, or add a
                  custom endpoint below.
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
                        {d.baseURL} · {d.models.length} model(s)
                      </span>
                    </div>
                    <Button size="small" variant="primary" disabled={busy()} onClick={() => addRuntime(d)}>
                      Add {d.models.length}
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </section>

          {/* ── Custom endpoint ── */}
          <section class="flex flex-col gap-3">
            <h3 class="text-13-medium text-text-strong">Custom endpoint</h3>
            <div class="flex flex-col gap-2">
              <input
                class="w-full rounded-[4px] border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
                placeholder="http://localhost:11434/v1"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
              <input
                class="w-full rounded-[4px] border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
                placeholder="API key (optional — most local servers need none)"
                value={key()}
                onInput={(e) => setKey(e.currentTarget.value)}
              />
              <div class="flex gap-2">
                <Button size="small" variant="secondary" disabled={busy() || !url().trim()} onClick={listCustom}>
                  List models
                </Button>
                <Show when={found().length > 0}>
                  <Button size="small" variant="primary" disabled={busy() || selected().size === 0} onClick={addCustom}>
                    Add {selected().size} selected
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
            <h3 class="text-13-medium text-text-strong">Configured</h3>
            <Show
              when={(configured()?.length ?? 0) > 0}
              fallback={<p class="text-12-regular text-text-weak/70">No local providers yet.</p>}
            >
              <For each={configured()}>
                {(p) => (
                  <div class="flex items-center justify-between border border-border-weak-base rounded-[4px] p-3 bg-surface-base/40">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-13-medium text-text-strong">{p.id}</span>
                      <span class="text-11-regular text-text-weak">
                        {p.baseURL} · {p.models.length} model(s)
                      </span>
                    </div>
                    <Button
                      size="small"
                      variant="ghost"
                      icon="trash"
                      disabled={busy()}
                      onClick={() => removeProvider(p.id)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </section>
        </div>
      </PanelBody>
    </PanelScroll>
  )
}

export default LocalModels
