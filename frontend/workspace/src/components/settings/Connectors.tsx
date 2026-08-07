import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import type { Config, McpInspection, McpStatus } from "@synsci/sdk/v2/client"
import {
  PanelScroll,
  PanelHeader,
  PanelBody,
  Toolbar,
  SearchInput,
  AddMenu,
  Card,
  Row,
  SectionLabel,
  EmptyState,
  FormField,
  FormButton,
  Avatar,
  Chip,
} from "./_shared"
import { formatConnectorCommand, parseConnectorCommand } from "./connector-command"

type McpConfig = NonNullable<Config["mcp"]>[string]
type McpType = "local" | "remote"
type OAuthMode = "off" | "auto" | "client"
type ConfiguredMcp = Extract<McpConfig, { type: McpType }>
const MASK = "••••••••"

function isConfigured(value: McpConfig | undefined): value is ConfiguredMcp {
  return !!value && typeof value === "object" && "type" in value
}

export default function Connectors() {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()

  const [status, setStatus] = createSignal<Record<string, McpStatus>>({})
  const [details, setDetails] = createSignal<Record<string, McpInspection>>({})
  const [search, setSearch] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal("")
  const [expanded, setExpanded] = createSignal<string>()
  const [editing, setEditing] = createSignal<string | undefined>()
  const [form, setForm] = createSignal<FormState | undefined>()

  const entries = createMemo(() =>
    Object.entries(sync.data.config.mcp ?? {})
      .filter((e): e is [string, ConfiguredMcp] => isConfigured(e[1]))
      .filter((e) => !search().trim() || e[0].toLowerCase().includes(search().trim().toLowerCase()))
      .sort((a, b) => a[0].localeCompare(b[0])),
  )

  async function refresh() {
    try {
      const res = await sdk.client.mcp.status()
      setStatus(res.data ?? {})
      const inspected = await Promise.all(
        entries().map(async ([name]) => {
          const result = await sdk.client.mcp.inspect({ name }).catch(() => undefined)
          return result?.data ? ([name, result.data] as const) : undefined
        }),
      )
      setDetails(Object.fromEntries(inspected.filter((entry) => entry !== undefined)))
      setProblem("")
    } catch (error) {
      setProblem(message(error))
      throw error
    }
  }
  onMount(() => void refresh().catch(() => undefined))

  function dot(s: McpStatus | undefined): "active" | "muted" | "error" | "pending" {
    if (!s) return "muted"
    if (s.status === "connected") return "active"
    if (s.status === "failed") return "error"
    if (s.status === "needs_auth" || s.status === "needs_client_registration") return "pending"
    return "muted"
  }
  const statusText = (s: McpStatus | undefined) => {
    if (!s) return "Checking"
    if (s.status === "connected") return "Connected"
    if (s.status === "disabled") return "Off"
    if (s.status === "failed") return "Error"
    if (s.status === "needs_auth") return "Needs authentication"
    return "Needs client registration"
  }
  // Wash the connector's avatar tile by connection state so status reads at a
  // glance; a muted/off connector stays neutral.
  function statusTint(s: McpStatus | undefined): string | undefined {
    const d = dot(s)
    if (d === "active") return "var(--color-success)"
    if (d === "error") return "var(--color-error)"
    if (d === "pending") return "var(--color-warning)"
    return undefined
  }

  async function toggle(name: string, on: boolean) {
    const config = entries().find(([key]) => key === name)?.[1]
    if (!config) return
    setBusy(true)
    try {
      const next = { ...config, enabled: on }
      await sdk.client.mcp.config.set({ name, config: next, scope: "global" })
      sync.set("config", "mcp", name, next)
      await refresh()
    } catch (err) {
      showToast({ variant: "error", title: `Could not turn connector ${on ? "on" : "off"}`, description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Remove connector "${name}"? It will be disconnected and deleted from config.`)) return
    setBusy(true)
    try {
      await sdk.client.mcp.config.remove({ name, scope: "global" })
      sync.set("config", "mcp", (current = {}) => {
        const next = { ...current }
        delete next[name]
        return next
      })
      await refresh()
      if (editing() === name) closeForm()
    } catch (err) {
      showToast({ variant: "error", title: "Remove failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function authenticate(name: string) {
    setBusy(true)
    try {
      const result = await sdk.client.mcp.auth.authenticate({ name })
      if (!result.data) throw new Error("The connector did not return an authentication result.")
      await refresh()
      if (result.data.status !== "connected") {
        throw new Error(
          result.data.status === "failed"
            ? result.data.error
            : `Connector returned ${result.data.status.replaceAll("_", " ")}`,
        )
      }
      showToast({ variant: "success", title: `"${name}" connected` })
    } catch (err) {
      showToast({ variant: "error", title: "Authentication failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  async function disconnectAuth(name: string) {
    if (!window.confirm(`Disconnect "${name}" and remove its OAuth credentials from this machine?`)) return
    setBusy(true)
    try {
      await sdk.client.mcp.auth.remove({ name })
      await refresh()
      showToast({ variant: "success", title: `"${name}" disconnected` })
    } catch (err) {
      showToast({ variant: "error", title: "Disconnect failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  function openForm(type: McpType) {
    setEditing(undefined)
    setForm(blankForm(type))
  }
  function editConnector(name: string, config: ConfiguredMcp) {
    setEditing(name)
    setForm(formFromConfig(name, config))
  }
  function closeForm() {
    setForm(undefined)
    setEditing(undefined)
  }

  async function save() {
    const state = form()
    if (!state) return
    const name = state.name.trim()
    if (!name) {
      showToast({ variant: "error", title: "Connector name is required" })
      return
    }
    setBusy(true)
    try {
      const config = buildConfig(state)
      const previous = editing()
      const result = await sdk.client.mcp.config.set({ name, config, scope: "global" })
      if (previous && previous !== name) {
        await sdk.client.mcp.config.remove({ name: previous, scope: "global" })
        sync.set("config", "mcp", (current = {}) => {
          const next = { ...current }
          delete next[previous]
          return next
        })
      }
      sync.set("config", "mcp", name, maskConfig(config))
      const latest = result.data ?? {}
      setStatus(latest)
      closeForm()
      await Promise.resolve()
      await refresh().catch(() => undefined)
      const live = result.data?.[name]
      if (live?.status === "failed") {
        showToast({
          variant: "error",
          title: `Connector "${name}" saved, but could not connect`,
          description: live.error,
        })
      } else if (live?.status === "needs_auth" || live?.status === "needs_client_registration") {
        showToast({
          title: `Connector "${name}" saved`,
          description:
            live.status === "needs_auth" ? "Authentication is required before its tools are available." : live.error,
        })
      } else {
        showToast({ variant: "success", title: `Connector "${name}" saved and connected` })
      }
    } catch (err) {
      showToast({ variant: "error", title: "Save failed", description: message(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <PanelScroll>
      <PanelHeader
        title="Connectors"
        description="Connect real MCP servers to give research agents access to external tools and data."
        toolbar={
          <Show when={!form()}>
            <Toolbar>
              <SearchInput value={search()} onInput={setSearch} placeholder="Search connectors" />
              <AddMenu
                label="Add connector"
                items={[
                  {
                    icon: "link",
                    label: "Remote URL",
                    description: "Connect a hosted MCP server over HTTP",
                    onSelect: () => openForm("remote"),
                  },
                  {
                    icon: "console",
                    label: "Local command",
                    description: "Run an MCP server process locally",
                    onSelect: () => openForm("local"),
                  },
                ]}
              />
            </Toolbar>
          </Show>
        }
      />

      <PanelBody>
        <Show when={problem()}>
          <div
            role="alert"
            class="mb-4 flex items-center justify-between gap-3 rounded-[4px] border border-border-weak-base px-3 py-2"
            style={{ color: "var(--color-error)" }}
          >
            <span class="text-12-regular">Connector status unavailable. {problem()}</span>
            <button type="button" class="text-12-medium" disabled={busy()} onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        </Show>
        <Show when={form()}>
          {(state) => (
            <ConnectorForm
              state={state()}
              editing={!!editing()}
              busy={busy()}
              onChange={setForm}
              onSave={save}
              onCancel={closeForm}
            />
          )}
        </Show>

        <Show when={!form()}>
          <Show
            when={entries().length > 0}
            fallback={
              <Show
                when={!search()}
                fallback={
                  <EmptyState
                    icon="mcp"
                    title="No matching connectors"
                    hint="Try a different name or clear the search."
                  />
                }
              >
                <div class="flex flex-col items-center gap-3 py-12 text-center">
                  <div class="flex size-10 items-center justify-center rounded-[6px] bg-surface-raised-base text-icon-weak-base">
                    <Icon name="mcp" size="normal" />
                  </div>
                  <div class="flex flex-col gap-1">
                    <span class="text-14-medium text-text-strong">Connect your research tools</span>
                    <p class="max-w-[380px] text-12-regular leading-relaxed text-text-weak">
                      Add a hosted MCP server with optional OAuth, or run a trusted MCP command on this machine.
                    </p>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
                    <FormButton label="Add remote server" onClick={() => openForm("remote")} />
                    <FormButton label="Add local command" variant="ghost" onClick={() => openForm("local")} />
                  </div>
                </div>
              </Show>
            }
          >
            <div class="flex flex-col gap-2">
              <SectionLabel label="Connectors" count={entries().length} />
              <Card>
                <For each={entries()}>
                  {(entry) => {
                    const name = entry[0]
                    const config = entry[1]
                    const s = () => status()[name]
                    const detail = () => details()[name]
                    return (
                      <Row>
                        <Avatar icon={config.type === "remote" ? "link" : "console"} tint={statusTint(s())} />
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="text-14-medium text-text-strong truncate">{name}</span>
                            <Chip>{config.type}</Chip>
                            <span
                              class="text-11-medium text-text-weak/70 truncate"
                              style={{ color: s()?.status === "failed" ? "var(--color-error)" : undefined }}
                            >
                              {statusText(s())}
                            </span>
                          </div>
                          <p class="text-12-regular text-text-weak truncate mt-0.5">
                            {config.type === "local" ? config.command.join(" ") : config.url}
                          </p>
                          <Show when={detail()}>
                            {(value) => (
                              <p class="text-11-regular text-text-weak/70 mt-1">
                                {value().tools.length} tools · {value().resources.length} resources ·{" "}
                                {value().prompts.length} prompts
                                <Show when={value().auth}> · {value().auth?.replaceAll("_", " ")}</Show>
                              </p>
                            )}
                          </Show>
                        </div>
                        <div class="flex items-center gap-1">
                          <Show when={config.type === "remote" && config.oauth !== false}>
                            <button
                              type="button"
                              class="rounded-[4px] border border-border-weak-base px-2 py-1 text-11-medium text-text-weak hover:text-text-strong"
                              disabled={busy()}
                              onClick={() => void authenticate(name)}
                            >
                              {detail()?.auth === "authenticated" ? "Reconnect" : "Connect"}
                            </button>
                            <Show when={detail()?.auth === "authenticated" || detail()?.auth === "expired"}>
                              <button
                                type="button"
                                class="rounded-[4px] px-2 py-1 text-11-medium text-text-weak hover:text-text-strong"
                                disabled={busy()}
                                onClick={() => void disconnectAuth(name)}
                              >
                                Disconnect
                              </button>
                            </Show>
                          </Show>
                          <IconButton
                            icon="chevron-down"
                            variant="ghost"
                            aria-label={
                              expanded() === name ? "Hide discovered capabilities" : "Show discovered capabilities"
                            }
                            onClick={() => setExpanded((value) => (value === name ? undefined : name))}
                          />
                          <IconButton
                            icon="edit"
                            variant="ghost"
                            disabled={busy()}
                            aria-label="Edit"
                            onClick={() => editConnector(name, config)}
                          />
                          <IconButton
                            icon="trash"
                            variant="ghost"
                            disabled={busy()}
                            aria-label="Remove"
                            onClick={() => void remove(name)}
                          />
                          <Switch checked={config.enabled !== false} onChange={(v) => void toggle(name, v)} hideLabel>
                            {name}
                          </Switch>
                        </div>
                        <Show when={expanded() === name}>
                          <ConnectorInspection detail={detail()} />
                        </Show>
                      </Row>
                    )
                  }}
                </For>
              </Card>
              <button
                type="button"
                class="self-start text-12-medium text-text-weak hover:text-text-strong flex items-center gap-1.5 mt-1"
                disabled={busy()}
                onClick={() => void refresh()}
              >
                <Icon name="enter" size="small" /> Refresh status
              </button>
            </div>
          </Show>
        </Show>
      </PanelBody>
    </PanelScroll>
  )
}

// ── form ──────────────────────────────────────────────────────────────────

interface FormState {
  name: string
  type: McpType
  command: string
  url: string
  env: string
  headers: string
  oauth: OAuthMode
  clientId: string
  clientSecret: string
  scope: string
  timeout: string
  previous?: ConfiguredMcp
}

function blankForm(type: McpType): FormState {
  return {
    name: "",
    type,
    command: "",
    url: "",
    env: "",
    headers: "",
    oauth: "auto",
    clientId: "",
    clientSecret: "",
    scope: "",
    timeout: "",
  }
}

function formFromConfig(name: string, config: ConfiguredMcp): FormState {
  const base = blankForm(config.type)
  base.name = name
  base.previous = config
  base.timeout = config.timeout ? String(config.timeout) : ""
  if (config.type === "local") {
    base.command = formatConnectorCommand(config.command)
    base.env = config.environment ? JSON.stringify(maskRecord(config.environment), null, 2) : ""
    return base
  }
  base.url = config.url
  base.headers = config.headers ? JSON.stringify(maskRecord(config.headers), null, 2) : ""
  if (config.oauth === false) base.oauth = "off"
  else if (config.oauth && "clientId" in config.oauth && config.oauth.clientId) {
    base.oauth = "client"
    base.clientId = config.oauth.clientId
    base.clientSecret = config.oauth.clientSecret ? MASK : ""
    base.scope = config.oauth.scope ?? ""
  } else base.oauth = "auto"
  return base
}

function maskRecord(value: Record<string, string>) {
  return Object.fromEntries(Object.keys(value).map((key) => [key, MASK]))
}

function maskConfig(value: ConfiguredMcp): ConfiguredMcp {
  if (value.type === "local") {
    return {
      ...value,
      environment: value.environment ? maskRecord(value.environment) : undefined,
    }
  }
  return {
    ...value,
    headers: value.headers ? maskRecord(value.headers) : undefined,
    oauth:
      value.oauth && typeof value.oauth === "object"
        ? {
            ...value.oauth,
            clientSecret: value.oauth.clientSecret ? MASK : undefined,
          }
        : value.oauth,
  }
}

function restoreRecord(value: Record<string, string> | undefined, previous: Record<string, string> | undefined) {
  if (!value) return undefined
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (entry !== MASK) return [key, entry]
      const stored = previous?.[key]
      if (stored === undefined) throw new Error(`Replace the masked value for ${key} before saving`)
      return [key, stored]
    }),
  )
}

function parseRecord(text: string, label: string) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const parsed = JSON.parse(trimmed)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`)
  for (const [k, v] of Object.entries(parsed))
    if (typeof v !== "string") throw new Error(`${label}.${k} must be a string`)
  return parsed as Record<string, string>
}

function buildConfig(state: FormState): ConfiguredMcp {
  const timeout = state.timeout.trim() ? Number(state.timeout) : undefined
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
    throw new Error("Timeout must be a positive whole number of milliseconds")
  }
  const enabled = state.previous?.enabled
  if (state.type === "local") {
    const command = parseConnectorCommand(state.command)
    if (command.length === 0) throw new Error("Command is required")
    const previous = state.previous?.type === "local" ? state.previous : undefined
    const environment = restoreRecord(parseRecord(state.env, "Environment"), previous?.environment)
    return {
      type: "local",
      command,
      ...(environment ? { environment } : {}),
      ...(enabled === false ? { enabled } : {}),
      ...(timeout ? { timeout } : {}),
    }
  }
  if (!URL.canParse(state.url.trim())) throw new Error("Remote URL is invalid")
  const previous = state.previous?.type === "remote" ? state.previous : undefined
  const headers = restoreRecord(parseRecord(state.headers, "Headers"), previous?.headers)
  const oauth = typeof previous?.oauth === "object" ? previous.oauth : undefined
  const secret = state.clientSecret.trim() === MASK ? oauth?.clientSecret : state.clientSecret.trim()
  return {
    type: "remote",
    url: state.url.trim(),
    ...(headers ? { headers } : {}),
    ...(enabled === false ? { enabled } : {}),
    ...(timeout ? { timeout } : {}),
    ...(state.oauth === "off"
      ? { oauth: false }
      : state.oauth === "client"
        ? {
            oauth: {
              clientId: state.clientId.trim(),
              ...(secret ? { clientSecret: secret } : {}),
              ...(state.scope.trim() ? { scope: state.scope.trim() } : {}),
            },
          }
        : { oauth: {} }),
  }
}

function ConnectorForm(props: {
  state: FormState
  editing: boolean
  busy: boolean
  onChange: (s: FormState) => void
  onSave: () => void
  onCancel: () => void
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    props.onChange({ ...props.state, [key]: value })
  return (
    <div class="flex flex-col gap-4">
      <SectionLabel label={props.editing ? "Edit connector" : `Add ${props.state.type} connector`} />
      <div class="flex flex-col gap-4 p-5 border border-border-weak-base rounded-[4px] bg-surface-base/40">
        <FormField
          label="Name"
          value={props.state.name}
          onInput={(v) => set("name", v)}
          placeholder="linear, filesystem…"
        />
        <Show
          when={props.state.type === "remote"}
          fallback={
            <>
              <FormField
                label="Command"
                value={props.state.command}
                onInput={(v) => set("command", v)}
                mono
                placeholder="npx -y @modelcontextprotocol/server-filesystem ."
              />
              <FormField
                label="Environment (JSON)"
                value={props.state.env}
                onInput={(v) => set("env", v)}
                multiline
                mono
                placeholder={'{ "TOKEN": "..." }'}
              />
              <Show when={props.editing && props.state.env}>
                <p class="text-11-regular text-text-weak">
                  Stored values are masked. Keep the mask to preserve a value, replace it to update, or remove its key
                  to delete it.
                </p>
              </Show>
            </>
          }
        >
          <FormField
            label="URL"
            value={props.state.url}
            onInput={(v) => set("url", v)}
            mono
            placeholder="https://mcp.example.com/mcp"
          />
          <label class="flex flex-col gap-1.5">
            <span class="text-12-medium text-text-strong">OAuth</span>
            <select
              value={props.state.oauth}
              class="h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base text-13-regular text-text-strong outline-none focus:border-border-strong-base"
              onInput={(e) => set("oauth", e.currentTarget.value as OAuthMode)}
            >
              <option value="auto">Auto (dynamic registration)</option>
              <option value="client">Pre-registered client</option>
              <option value="off">Off</option>
            </select>
          </label>
          <FormField
            label="Headers (JSON)"
            value={props.state.headers}
            onInput={(v) => set("headers", v)}
            multiline
            mono
            placeholder={'{ "Authorization": "Bearer ..." }'}
          />
          <Show when={props.editing && props.state.headers}>
            <p class="text-11-regular text-text-weak">
              Stored header values are masked. Keep the mask to preserve a value, replace it to update, or remove its
              key to delete it.
            </p>
          </Show>
          <Show when={props.state.oauth === "client"}>
            <FormField label="Client ID" value={props.state.clientId} onInput={(v) => set("clientId", v)} mono />
            <FormField
              label="Client secret"
              value={props.state.clientSecret}
              onInput={(v) => set("clientSecret", v)}
              mono
            />
            <FormField label="Scope" value={props.state.scope} onInput={(v) => set("scope", v)} mono />
          </Show>
        </Show>
        <FormField
          label="Request timeout (ms)"
          value={props.state.timeout}
          onInput={(v) => set("timeout", v)}
          mono
          placeholder="5000"
        />
        <div class="flex items-center gap-2">
          <FormButton
            label={props.busy ? "Saving…" : props.editing ? "Save connector" : "Add connector"}
            disabled={props.busy}
            onClick={props.onSave}
          />
          <FormButton label="Cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
        </div>
      </div>
    </div>
  )
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function ConnectorInspection(props: { detail?: McpInspection }) {
  const failures = () => {
    if (!props.detail) return []
    const status = props.detail.status.status === "failed" ? [props.detail.status.error] : []
    return [...status, ...Object.values(props.detail.errors).filter((error) => error !== undefined)]
  }
  return (
    <div class="basis-full w-full border-t border-border-weak-base pt-3 mt-1 flex flex-col gap-3">
      <Show when={props.detail} fallback={<span class="text-12-regular text-text-weak">Inspecting connector…</span>}>
        {(detail) => (
          <>
            <Show when={failures().length > 0}>
              <div
                class="rounded-[4px] px-3 py-2"
                style={{
                  color: "var(--color-error)",
                  border: "1px solid var(--color-error-muted)",
                  background: "color-mix(in srgb, var(--color-error) 8%, transparent)",
                }}
              >
                <For each={failures()}>{(error) => <p class="text-12-regular break-words">{error}</p>}</For>
              </div>
            </Show>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <CapabilityList
                title="Tools"
                empty="No tools reported"
                items={detail().tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                }))}
              />
              <CapabilityList
                title="Resources"
                empty="No resources reported"
                items={detail().resources.map((resource) => ({
                  name: resource.name,
                  description: resource.description ?? resource.uri,
                }))}
              />
              <CapabilityList
                title="Prompts"
                empty="No prompts reported"
                items={detail().prompts.map((prompt) => ({
                  name: prompt.name,
                  description: prompt.description,
                }))}
              />
            </div>
          </>
        )}
      </Show>
    </div>
  )
}

function CapabilityList(props: { title: string; empty: string; items: Array<{ name: string; description?: string }> }) {
  return (
    <section class="min-w-0">
      <h3 class="text-11-medium tracking-[0.01em] text-text-weak mb-1.5">{props.title}</h3>
      <Show when={props.items.length > 0} fallback={<p class="text-11-regular text-text-weak/70">{props.empty}</p>}>
        <ul class="flex flex-col gap-1.5">
          <For each={props.items}>
            {(item) => (
              <li class="min-w-0">
                <p class="text-12-medium text-text-strong truncate" title={item.name}>
                  {item.name}
                </p>
                <Show when={item.description}>
                  <p class="text-11-regular text-text-weak line-clamp-2">{item.description}</p>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
