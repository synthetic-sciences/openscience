// Local models settings panel — add an Ollama / LM Studio / OpenAI-compatible
// endpoint running on this machine. The server (routes/settings/local.ts) does
// the localhost probing/listing the browser can't do cross-origin, and writes
// the provider config block.
import { Component, For, Show, createEffect, createMemo, createResource, createSignal, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Checkbox } from "@synsci/ui/checkbox"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { usePlatform } from "@/context/platform"
import { productPreferences } from "@/context/product-preferences"
import { settingsApi } from "./api"
import { prepareOllamaModels, selectableLocalModels } from "./local-model-selection"
import { Card, PanelBody, PanelHeader, PanelScroll, RowCopy, Section } from "./_shared"

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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
      (error) => showToast({ title: "Couldn't copy command", description: message(error) }),
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

  // Load failures and action failures surface inline, like Models, instead of
  // disappearing into a toast.
  const [error, setError] = createSignal<string>()
  const problem = () => error() ?? [detected, configured, status].find((resource) => resource.error)?.error
  const recover = () => {
    setError(undefined)
    refetch()
  }

  const [busy, setBusy] = createSignal(false)
  const [context, setContext] = createSignal("32768")
  const guard = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true)
    setError(undefined)
    try {
      await fn()
      refetch()
    } catch (err) {
      setError(`${failure}. ${message(err)}`)
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
    }, "Couldn't add local models")

  const removeProvider = (id: string) =>
    guard(async () => {
      await call(`/${encodeURIComponent(id)}`, { method: "DELETE" })
      await sync.refreshProviders()
    }, "Couldn't remove the provider")

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
      .catch((cause) => {
        productPreferences.sync({ show_local_models: previous })
        setError(`Couldn't update model visibility. ${message(cause)}`)
      })
      .finally(() => setVisibilityBusy(false))
  }

  // ── Start a runtime for the user (host it) ──
  const [starting, setStarting] = createSignal<string>()
  const startRuntime = async (rt: Runtime) => {
    setStarting(rt.id)
    setError(undefined)
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
        setError(`Couldn't start ${rt.name}. The server didn't come up in time.`)
      }
      refetch()
    } catch (err) {
      setError(`Couldn't start ${rt.name}. ${message(err)}`)
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
    }, "Couldn't add local models")

  const runtimeDetail = (rt: Runtime) => {
    if (!rt.installed) return `Not installed · ${rt.serveHint}`
    if (rt.running) return `Running · ${rt.models.length} model(s)`
    return "Installed · not running"
  }

  return (
    <PanelScroll>
      <PanelHeader
        title="Local models"
        description="Run models on this machine or connect a self-hosted OpenAI-compatible server on your own GPU."
      />
      <PanelBody>
        <Show when={problem()}>
          {(value) => (
            <div role="alert" class="settings-alert" data-tone="critical">
              <span>{String(value())}</span>
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action"
                disabled={busy()}
                onClick={recover}
              >
                Retry
              </Button>
            </div>
          )}
        </Show>

        <Section title="Catalog" description="Local models are listed after connected providers in Models.">
          <Card>
            <div class="settings-row">
              <RowCopy
                title="Show local models in Models"
                description="Hide locally hosted models from the catalog without removing them."
              />
              <Switch
                hideLabel
                checked={productPreferences.localModels()}
                disabled={visibilityBusy() || preferences.loading}
                onChange={setVisibility}
              >
                Show local models in Models
              </Switch>
            </div>
          </Card>
        </Section>

        {/* ── Run locally (host it for the user) ── */}
        <Section title="Run a model locally" description="OpenScience starts and hosts a runtime for you.">
          <Card>
            <Show
              when={!status.loading}
              fallback={
                <div class="settings-panel-loading__rows" role="status" aria-label="Loading local runtimes">
                  <span />
                  <span />
                </div>
              }
            >
              <For
                each={status()}
                fallback={
                  <p class="settings-card-empty" role="status">
                    No supported local runtime was found on this machine.
                  </p>
                }
              >
                {(rt) => (
                  <div class="settings-row">
                    <RowCopy title={rt.name} description={runtimeDetail(rt)} />
                    <div class="ml-auto flex max-w-full shrink-0 items-center gap-2">
                      <Show when={rt.running}>
                        <span class="settings-status" data-tone="ready">
                          <span class="settings-status__dot" aria-hidden="true" />
                          Running
                        </span>
                      </Show>
                      <Show
                        when={rt.installed}
                        fallback={
                          <Button
                            size="small"
                            variant="secondary"
                            class="settings-panel-action"
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
                              class="settings-panel-action"
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
                            class="settings-panel-action"
                            disabled={busy() || rt.models.length === 0}
                            onClick={() => choose(rt)}
                          >
                            Choose models
                          </Button>
                        </Show>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Card>
        </Section>

        {/* ── Pull a model (Ollama) ── */}
        <Section title="Pull a model" description="Copy an ollama pull command, then run it in your terminal.">
          <Card>
            <div class="settings-row">
              <input
                class="settings-field min-w-0 flex-1 basis-[220px] font-mono"
                aria-label="Model to pull with Ollama"
                placeholder="llama3.1 · qwen2.5-coder · phi3"
                value={pullName()}
                onInput={(e) => setPullName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && pull()}
              />
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action shrink-0"
                disabled={!pullName().trim()}
                onClick={pull}
              >
                Copy command
              </Button>
            </div>
            <div class="settings-row">
              <RowCopy title="Start Ollama" description="Run this first if the server isn't up yet." />
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action settings-panel-action--quiet ml-auto shrink-0 font-mono"
                aria-label="Copy ollama serve command"
                onClick={() => void copyCommand("ollama serve")}
              >
                ollama serve
              </Button>
            </div>
          </Card>
        </Section>

        {/* ── Detected runtimes ── */}
        <Section
          title="Detected on this machine"
          action={
            <Button size="small" variant="secondary" class="settings-panel-action" disabled={busy()} onClick={refetch}>
              Rescan
            </Button>
          }
        >
          <Card>
            <Show
              when={!detected.loading && !status.loading}
              fallback={
                <div class="settings-panel-loading__rows" role="status" aria-label="Scanning for local servers">
                  <span />
                  <span />
                </div>
              }
            >
              <For
                each={discoveries()}
                fallback={
                  <p class="settings-card-empty" role="status">
                    Nothing running yet. Start a server such as <code>ollama serve</code>, then rescan or add an
                    endpoint below.
                  </p>
                }
              >
                {(d) => (
                  <div class="settings-row">
                    <RowCopy title={d.name} description={`${d.baseURL} · ${d.models.length} model(s)`} />
                    <Button
                      size="small"
                      variant="primary"
                      class="settings-panel-action ml-auto shrink-0"
                      disabled={busy()}
                      onClick={() => choose(d)}
                    >
                      Choose models
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </Card>
        </Section>

        <Show when={choice()}>
          {(source) => (
            <Section
              title={`Choose ${source().name} models`}
              description="Only the models you select appear in Models."
              action={
                <div class="flex items-center gap-2">
                  <Button
                    size="small"
                    variant="ghost"
                    class="settings-panel-action settings-panel-action--quiet"
                    disabled={chosen().size === source().models.length}
                    onClick={() => setChosen(new Set(source().models))}
                  >
                    Select all
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    class="settings-panel-action settings-panel-action--quiet"
                    disabled={chosen().size === 0}
                    onClick={() => setChosen(new Set<string>())}
                  >
                    Clear
                  </Button>
                </div>
              }
            >
              <div class="settings-card settings-form-card" aria-label={`Choose ${source().name} models`}>
                <div class="flex max-h-52 flex-col gap-1 overflow-y-auto">
                  <For each={source().models}>
                    {(model) => (
                      <Checkbox checked={chosen().has(model)} onChange={() => toggleChoice(model)}>
                        <span class="min-w-0 truncate font-mono text-12-regular">{model}</span>
                      </Checkbox>
                    )}
                  </For>
                </div>
                <Show when={isOllama(source().id, source().baseURL)}>
                  <div class="settings-row">
                    <RowCopy
                      title="Context window"
                      description="Applied to the selected models. Larger windows use more memory; the tuned alias stays out of the catalog."
                    />
                    <div class="ml-auto flex shrink-0 items-center gap-2">
                      <input
                        class="settings-field w-32 text-right font-mono"
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
                </Show>
                <div class="flex justify-end gap-2">
                  <Button
                    size="small"
                    variant="secondary"
                    class="settings-panel-action"
                    disabled={busy()}
                    onClick={() => setChoice(undefined)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="small"
                    variant="primary"
                    class="settings-panel-action"
                    disabled={busy() || chosen().size === 0}
                    onClick={addChoice}
                  >
                    Add {chosen().size} selected
                  </Button>
                </div>
              </div>
            </Section>
          )}
        </Show>

        <Section
          title="Connect over SSH"
          description="Open an encrypted local-forward to a model server on a remote GPU. The host must already work with your SSH config and keys."
        >
          <div class="settings-card settings-form-card">
            <div class="settings-form-grid">
              <Field
                label="SSH host"
                span="full"
                placeholder="research-gpu or user@gpu.example.org"
                value={sshHost()}
                onInput={setSshHost}
              />
              <Field
                label="Remote model port"
                type="number"
                min="1"
                max="65535"
                placeholder="11434"
                value={sshRemotePort()}
                onInput={setSshRemotePort}
              />
              <Field
                label="Local tunnel port"
                type="number"
                min="1024"
                max="65535"
                placeholder="12434"
                value={sshLocalPort()}
                onInput={setSshLocalPort}
              />
              <Field
                label="Endpoint key (optional)"
                span="full"
                type="password"
                placeholder="Only if the remote model server requires one"
                value={sshKey()}
                onInput={setSshKey}
              />
            </div>
            <div class="flex justify-end">
              <Button
                size="small"
                variant="primary"
                class="settings-panel-action"
                disabled={busy() || !sshHost().trim()}
                onClick={connectSSH}
              >
                Connect models
              </Button>
            </div>
          </div>
        </Section>

        {/* ── Custom endpoint ── */}
        <Section
          title="Direct endpoint"
          description="Connect a local, LAN, VPN, or HTTPS OpenAI-compatible endpoint directly."
        >
          <div class="settings-card settings-form-card">
            <div class="settings-form-grid">
              <Field
                label="Endpoint URL"
                span="full"
                inputMode="url"
                placeholder="http://localhost:11434/v1"
                value={url()}
                onInput={setUrl}
              />
              <Field
                label="API key (optional)"
                span="full"
                type="password"
                placeholder="Most local servers need none"
                value={key()}
                onInput={setKey}
              />
            </div>
            <div class="flex flex-wrap justify-end gap-2">
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action"
                disabled={busy() || !url().trim()}
                onClick={listCustom}
              >
                List models
              </Button>
              <Show when={found().length > 0}>
                <Button
                  size="small"
                  variant="primary"
                  class="settings-panel-action"
                  disabled={busy() || selected().size === 0}
                  onClick={addCustom}
                >
                  Add {selected().size} selected
                </Button>
              </Show>
            </div>
            <Show when={found().length > 0}>
              <div class="flex flex-col gap-1">
                <span class="text-11-regular text-text-weak">{listedUrl()}</span>
                <For each={found()}>
                  {(m) => (
                    <Checkbox checked={selected().has(m)} onChange={() => toggle(m)}>
                      <span class="min-w-0 truncate font-mono text-12-regular">{m}</span>
                    </Checkbox>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Section>

        {/* ── Configured ── */}
        <Section title="Configured" count={configured()?.length}>
          <Card>
            <Show
              when={!configured.loading}
              fallback={
                <div class="settings-panel-loading__rows" role="status" aria-label="Loading configured providers">
                  <span />
                </div>
              }
            >
              <For
                each={configured()}
                fallback={
                  <p class="settings-card-empty" role="status">
                    No local or self-hosted providers yet.
                  </p>
                }
              >
                {(p) => (
                  <div class="settings-row">
                    <RowCopy
                      title={p.id}
                      description={`${p.baseURL} · ${p.models.length} model(s)${p.runtime?.startsWith("ssh:") ? " · SSH tunnel" : ""}`}
                    />
                    <Button
                      size="small"
                      variant="ghost"
                      icon="trash"
                      class="settings-panel-action settings-panel-action--danger-quiet ml-auto shrink-0"
                      disabled={busy()}
                      onClick={() => removeProvider(p.id)}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </For>
            </Show>
          </Card>
        </Section>
      </PanelBody>
    </PanelScroll>
  )
}

export default LocalModels

const Field: Component<{
  label: string
  value: string
  placeholder: string
  onInput: (value: string) => void
  span?: "full"
  type?: JSX.InputHTMLAttributes<HTMLInputElement>["type"]
  inputMode?: JSX.InputHTMLAttributes<HTMLInputElement>["inputMode"]
  min?: string
  max?: string
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1.5" data-span={props.span}>
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <input
      class="settings-field"
      type={props.type}
      inputMode={props.inputMode}
      min={props.min}
      max={props.max}
      autocomplete={props.type === "password" ? "off" : undefined}
      value={props.value}
      placeholder={props.placeholder}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)
