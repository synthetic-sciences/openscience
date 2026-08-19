// Local models settings panel — add an Ollama / LM Studio / OpenAI-compatible
// endpoint running on this machine. The server (routes/settings/local.ts) does
// the localhost probing/listing the browser can't do cross-origin, and writes
// the provider config block.
import { Component, For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { productPreferences } from "@/context/product-preferences"
import { settingsApi } from "./api"
import { prepareOllamaModels, selectableLocalModels } from "./local-model-selection"
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

type Source = Pick<Detected, "id" | "name" | "baseURL" | "models">

const LocalModels: Component = () => {
  const sdk = useGlobalSDK()
  const sync = useGlobalSync()
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
  const [preferences, { mutate: setPreferences }] = createResource(() =>
    settingsApi<{ show_local_models: boolean }>(sdk.url, fetchFn, "/settings/preferences"),
  )
  createEffect(() => {
    const value = preferences()?.show_local_models
    if (value !== undefined) productPreferences.sync({ show_local_models: value })
  })
  const discoveries = createMemo(
    () => detected()?.filter((item) => !status()?.some((runtime) => runtime.id === item.id && runtime.running)) ?? [],
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
    const prepared = ollama
      ? await prepareOllamaModels(input.models, (model) =>
          call<{ model: string }>("/context", {
            method: "POST",
            body: JSON.stringify({ url: input.url, model, context: tokens }),
          }).then((result) => result.model),
        )
      : { models: input.models, aliases: {}, tuned: true }
    const result = await call<{ id: string; baseURL: string; models: string[] }>("", {
      method: "POST",
      body: JSON.stringify({
        url: input.url,
        id: input.id,
        name: input.name,
        key: input.key,
        models: prepared.models,
        aliases: prepared.aliases,
        contextLimit: ollama ? tokens : undefined,
        runtime: ollama ? "ollama" : undefined,
        merge: true,
      }),
    })
    return { ...result, tuned: prepared.tuned }
  }

  const [choice, setChoice] = createSignal<Source>()
  const [chosen, setChosen] = createSignal<Set<string>>(new Set<string>())
  const choose = (source: Source) => {
    setChoice({ ...source, models: selectableLocalModels(source.models) })
    setChosen(new Set<string>())
  }
  const toggleChoice = (model: string) => {
    const next = new Set(chosen())
    next.has(model) ? next.delete(model) : next.add(model)
    setChosen(next)
  }
  const addChoice = () =>
    guard(async () => {
      const source = choice()
      if (!source) return
      const models = source.models.filter((model) => chosen().has(model))
      if (!models.length) throw new Error("Select at least one model.")
      const result = await register({
        url: source.baseURL,
        id: source.id,
        name: `${source.name} (local)`,
        models,
      })
      await sync.refreshProviders()
      showToast({
        variant: "success",
        title: models.length === 1 ? "Model added" : "Models added",
        description: result.tuned
          ? `Added ${models.length} to the end of the Models catalog.`
          : `Added ${models.length} to the end of the Models catalog. Restart the local server to enable custom Ollama context tuning.`,
      })
      setChoice(undefined)
      setChosen(new Set<string>())
    }, "Failed to add local models")

  const removeProvider = (id: string) =>
    guard(async () => {
      await call(`/${encodeURIComponent(id)}`, { method: "DELETE" })
      await sync.refreshProviders()
    }, "Failed to remove provider")

  const [visibilityBusy, setVisibilityBusy] = createSignal(false)
  const setVisibility = (visible: boolean) => {
    if (visibilityBusy()) return
    const previous = productPreferences.localModels()
    productPreferences.sync({ show_local_models: visible })
    setVisibilityBusy(true)
    void settingsApi<{ show_local_models: boolean }>(sdk.url, fetchFn, "/settings/preferences", {
      method: "PATCH",
      body: JSON.stringify({ show_local_models: visible }),
    })
      .then((value) => {
        setPreferences(value)
        productPreferences.sync(value)
      })
      .catch((error) => {
        productPreferences.sync({ show_local_models: previous })
        showToast({
          title: "Couldn't update model visibility",
          description: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => setVisibilityBusy(false))
  }

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
        choose({ ...rt, models: r.models })
        showToast({ title: `${rt.name} is running`, description: "Choose which models to add." })
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
  const [sshHost, setSshHost] = createSignal("")
  const [sshRemotePort, setSshRemotePort] = createSignal("11434")
  const [sshLocalPort, setSshLocalPort] = createSignal("12434")
  const [sshKey, setSshKey] = createSignal("")

  const connectSSH = () =>
    guard(async () => {
      const remotePort = Number(sshRemotePort())
      const localPort = Number(sshLocalPort())
      if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
        throw new Error("Remote port must be between 1 and 65,535.")
      }
      if (!Number.isInteger(localPort) || localPort < 1_024 || localPort > 65_535) {
        throw new Error("Local port must be between 1,024 and 65,535.")
      }
      const result = await call<{ models: string[] }>("/ssh", {
        method: "POST",
        body: JSON.stringify({
          host: sshHost().trim(),
          remotePort,
          localPort,
          key: sshKey().trim() || undefined,
        }),
      })
      await sync.refreshProviders()
      showToast({
        variant: "success",
        title: "SSH models connected",
        description: `Added ${result.models.length} model(s) through the encrypted tunnel.`,
      })
    }, "Couldn't connect the SSH model host")

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
      await sync.refreshProviders()
      showToast({
        variant: "success",
        title: models.length === 1 ? "Model added" : "Models added",
        description: `Added ${models.length} to the end of the Models catalog.`,
      })
      setUrl("")
      setKey("")
      setFound([])
      setSelected(new Set<string>())
      setListedUrl("")
    }, "Failed to add local models")

  return (
    <PanelScroll>
      <PanelHeader
        title="Local and self-hosted models"
        description="Run models on this machine or connect an OpenAI-compatible server on your own GPU."
      />
      <PanelBody>
        <div class="flex flex-col gap-8">
          <section class="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-4 rounded-sm border border-border-weak-base bg-surface-base p-3">
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="text-13-medium text-text-strong">Show local models in Models</span>
                <span class="text-11-regular text-text-weak">
                  Keep locally hosted models visible or temporarily hide them from the Models catalog.
                </span>
              </div>
              <Switch
                hideLabel
                checked={productPreferences.localModels()}
                disabled={visibilityBusy() || preferences.loading}
                onChange={setVisibility}
              >
                Show local models in Models
              </Switch>
            </div>
          </section>

          {/* ── Run locally (host it for the user) ── */}
          <section class="flex flex-col gap-3">
            <h3 class="text-13-medium text-text-strong">Run a model locally</h3>
            <p class="text-12-regular text-text-weak/70">
              Let OpenScience start and host a runtime for you — no terminal needed.
            </p>
            <For each={status()}>
              {(rt) => (
                <div class="flex items-center justify-between rounded-sm border border-border-weak-base bg-surface-base p-3">
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
                        onClick={() => choose(rt)}
                      >
                        Choose models
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
                class="flex-1 rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
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
              when={discoveries().length > 0}
              fallback={
                <p class="text-12-regular text-text-weak/70">
                  Nothing running yet. Start a server (e.g. <code>ollama serve</code>) and select Rescan, or add a
                  custom endpoint below.
                </p>
              }
            >
              <For each={discoveries()}>
                {(d) => (
                  <div class="flex items-center justify-between rounded-sm border border-border-weak-base bg-surface-base p-3">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-13-medium text-text-strong flex items-center gap-1.5">
                        <Icon name="check" class="text-text-success" /> {d.name}
                      </span>
                      <span class="text-11-regular text-text-weak">
                        {d.baseURL} · {d.models.length} model(s)
                      </span>
                    </div>
                    <Button size="small" variant="primary" disabled={busy()} onClick={() => choose(d)}>
                      Choose models
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </section>

          <Show when={choice()}>
            {(source) => (
              <section
                class="flex flex-col gap-3 rounded-md border border-border-strong-base bg-surface-base p-4"
                aria-label={`Choose ${source().name} models`}
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="flex flex-col gap-0.5">
                    <h3 class="text-13-medium text-text-strong">Choose {source().name} models</h3>
                    <p class="text-11-regular text-text-weak">Only the models you select will appear in Models.</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={chosen().size === source().models.length}
                      onClick={() => setChosen(new Set(source().models))}
                    >
                      Select all
                    </Button>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={chosen().size === 0}
                      onClick={() => setChosen(new Set<string>())}
                    >
                      Clear
                    </Button>
                  </div>
                </div>
                <div class="max-h-52 overflow-y-auto rounded-sm border border-border-weak-base p-2">
                  <For each={source().models}>
                    {(model) => (
                      <label class="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-13-regular text-text-strong hover:bg-surface-raised-base">
                        <input type="checkbox" checked={chosen().has(model)} onChange={() => toggleChoice(model)} />
                        <span class="min-w-0 truncate font-mono text-12-regular">{model}</span>
                      </label>
                    )}
                  </For>
                </div>
                <Show when={isOllama(source().id, source().baseURL)}>
                  <div class="flex flex-col gap-2 rounded-sm border border-border-weak-base bg-surface-raised-base p-3">
                    <div class="flex flex-wrap items-center justify-between gap-3">
                      <div class="flex min-w-0 flex-col gap-0.5">
                        <span class="text-12-medium text-text-strong">Context window</span>
                        <span class="text-11-regular text-text-weak">Applied to the models selected above.</span>
                      </div>
                      <div class="flex items-center gap-2">
                        <input
                          class="w-32 rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-right font-mono text-13-regular text-text-strong"
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
                      Larger windows use more memory. OpenScience keeps the tuned runtime alias out of the Models
                      catalog and shows the original model name.
                    </p>
                  </div>
                </Show>
                <div class="flex justify-end gap-2">
                  <Button size="small" variant="secondary" disabled={busy()} onClick={() => setChoice(undefined)}>
                    Cancel
                  </Button>
                  <Button size="small" variant="primary" disabled={busy() || chosen().size === 0} onClick={addChoice}>
                    Add {chosen().size} selected
                  </Button>
                </div>
              </section>
            )}
          </Show>

          <section class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
              <h3 class="text-13-medium text-text-strong">Connect over SSH</h3>
              <p class="text-12-regular text-text-weak/70">
                Open an encrypted local-forward to a model server running on a remote GPU. The host must already work
                with your normal SSH config and keys.
              </p>
            </div>
            <div class="grid grid-cols-1 gap-2 rounded-md border border-border-weak-base bg-surface-base p-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1 sm:col-span-2">
                <span class="text-11-medium text-text-weak">SSH host</span>
                <input
                  class="w-full rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
                  placeholder="research-gpu or user@gpu.example.org"
                  value={sshHost()}
                  onInput={(event) => setSshHost(event.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-11-medium text-text-weak">Remote model port</span>
                <input
                  class="w-full rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong"
                  type="number"
                  min="1"
                  max="65535"
                  value={sshRemotePort()}
                  onInput={(event) => setSshRemotePort(event.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-11-medium text-text-weak">Local tunnel port</span>
                <input
                  class="w-full rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong"
                  type="number"
                  min="1024"
                  max="65535"
                  value={sshLocalPort()}
                  onInput={(event) => setSshLocalPort(event.currentTarget.value)}
                />
              </label>
              <label class="flex flex-col gap-1 sm:col-span-2">
                <span class="text-11-medium text-text-weak">Endpoint key (optional)</span>
                <input
                  class="w-full rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
                  type="password"
                  autocomplete="off"
                  placeholder="Only if the remote model server requires one"
                  value={sshKey()}
                  onInput={(event) => setSshKey(event.currentTarget.value)}
                />
              </label>
              <div class="sm:col-span-2">
                <Button size="small" variant="primary" disabled={busy() || !sshHost().trim()} onClick={connectSSH}>
                  Connect models
                </Button>
              </div>
            </div>
          </section>

          {/* ── Custom endpoint ── */}
          <section class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
              <h3 class="text-13-medium text-text-strong">Direct endpoint</h3>
              <p class="text-12-regular text-text-weak/70">
                Connect a local, LAN, VPN, or HTTPS OpenAI-compatible endpoint directly.
              </p>
            </div>
            <div class="flex flex-col gap-2">
              <input
                class="w-full rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
                placeholder="http://localhost:11434/v1"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
              <input
                class="w-full rounded-sm border border-border-weak-base bg-surface-base px-3 py-2 text-13-regular text-text-strong placeholder:text-text-weak/60"
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
              <div class="flex flex-col gap-1 rounded-sm border border-border-weak-base bg-surface-base p-2">
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
              fallback={<p class="text-12-regular text-text-weak/70">No local or self-hosted providers yet.</p>}
            >
              <For each={configured()}>
                {(p) => (
                  <div class="flex items-center justify-between rounded-sm border border-border-weak-base bg-surface-base p-3">
                    <div class="flex flex-col gap-0.5">
                      <span class="text-13-medium text-text-strong">{p.id}</span>
                      <span class="text-11-regular text-text-weak">
                        {p.baseURL} · {p.models.length} model(s)
                        <Show when={p.runtime?.startsWith("ssh:")}> · SSH tunnel</Show>
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
