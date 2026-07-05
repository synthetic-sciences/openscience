import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { StatusDot } from "@/thesis/shared/StatusDot"
import type { Config, McpStatus } from "@synsci/sdk/v2/client"
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
} from "./_shared"

type McpConfig = NonNullable<Config["mcp"]>[string]
type McpType = "local" | "remote"
type OAuthMode = "off" | "auto" | "client"
type ConfiguredMcp = Extract<McpConfig, { type: McpType }>

function isConfigured(value: McpConfig | undefined): value is ConfiguredMcp {
  return !!value && typeof value === "object" && "type" in value
}

export default function Connectors() {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()

  const [status, setStatus] = createSignal<Record<string, McpStatus>>({})
  const [search, setSearch] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [editing, setEditing] = createSignal<string | undefined>()
  const [form, setForm] = createSignal<FormState | undefined>()

  const entries = createMemo(() =>
    Object.entries(sync.data.config.mcp ?? {})
      .filter((e): e is [string, ConfiguredMcp] => isConfigured(e[1]))
      .filter((e) => !search().trim() || e[0].toLowerCase().includes(search().trim().toLowerCase()))
      .sort((a, b) => a[0].localeCompare(b[0])),
  )

  async function refresh() {
    const res = await sdk.client.mcp.status()
    setStatus(res.data ?? {})
  }
  onMount(() => void refresh().catch(() => undefined))

  function dot(s: McpStatus | undefined): "active" | "muted" | "error" | "pending" {
    if (!s) return "muted"
    if (s.status === "connected") return "active"
    if (s.status === "failed") return "error"
    if (s.status === "needs_auth" || s.status === "needs_client_registration") return "pending"
    return "muted"
  }
  const statusText = (s: McpStatus | undefined) => (s ? s.status.replaceAll("_", " ") : "unknown")

  async function toggle(name: string, on: boolean) {
    setBusy(true)
    try {
      if (on) await sdk.client.mcp.connect({ name })
      else await sdk.client.mcp.disconnect({ name })
      await refresh()
    } catch (err) {
      showToast({ variant: "error", title: `Could not ${on ? "connect" : "disconnect"}`, description: message(err) })
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
      const started = await sdk.client.mcp.auth.start({ name })
      const authUrl = started.data?.authorizationUrl
      if (authUrl) window.open(authUrl, "_blank", "noopener,noreferrer")
      const code = window.prompt("Authorize in the opened tab, then paste the authorization code here.")
      if (!code) return
      await sdk.client.mcp.auth.callback({ name, code })
      await refresh()
    } catch (err) {
      showToast({ variant: "error", title: "Authentication failed", description: message(err) })
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
      await sdk.client.mcp.config.set({ name, config, scope: "global" })
      if (previous && previous !== name) {
        await sdk.client.mcp.config.remove({ name: previous, scope: "global" })
        sync.set("config", "mcp", (current = {}) => {
          const next = { ...current }
          delete next[previous]
          return next
        })
      }
      sync.set("config", "mcp", name, config)
      await refresh()
      showToast({ variant: "success", title: `Connector "${name}" saved` })
      closeForm()
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
        description="Model Context Protocol servers give your agents extra tools. Remote servers can use OAuth; local servers run a command on this machine."
        toolbar={
          <Show when={!form()}>
            <Toolbar>
              <SearchInput value={search()} onInput={setSearch} placeholder="Search connectors" />
              <AddMenu
                label="add connector"
                items={[
                  {
                    icon: "link",
                    label: "remote URL",
                    description: "Connect a hosted MCP server over HTTP",
                    onSelect: () => openForm("remote"),
                  },
                  {
                    icon: "console",
                    label: "local command",
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
              <EmptyState
                icon="mcp"
                title={search() ? "No matching connectors" : "No connectors yet"}
                hint="Add a remote MCP URL like https://mcp.example.com/mcp or a local command like npx -y @modelcontextprotocol/server-filesystem ."
              />
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
                    return (
                      <Row>
                        <StatusDot status={dot(s())} pulse={s()?.status === "connected"} />
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="text-14-medium text-text-strong truncate">{name}</span>
                            <span class="text-11-medium text-text-weak/70 px-1.5 py-0.5 rounded-md bg-surface-raised-base/60">
                              {config.type}
                            </span>
                            <span class="text-11-regular text-text-weak/60">{statusText(s())}</span>
                          </div>
                          <p class="text-12-regular text-text-weak truncate mt-0.5">
                            {config.type === "local" ? config.command.join(" ") : config.url}
                          </p>
                        </div>
                        <div class="flex items-center gap-1">
                          <Show when={config.type === "remote" && config.oauth !== false}>
                            <IconButton
                              icon="providers"
                              variant="ghost"
                              disabled={busy()}
                              aria-label="Authenticate"
                              onClick={() => void authenticate(name)}
                            />
                          </Show>
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
                          <Switch
                            checked={s()?.status === "connected"}
                            onChange={(v) => void toggle(name, v)}
                            hideLabel
                          >
                            {name}
                          </Switch>
                        </div>
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
                <Icon name="enter" size="small" /> refresh status
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
  }
}

function formFromConfig(name: string, config: ConfiguredMcp): FormState {
  const base = blankForm(config.type)
  base.name = name
  if (config.type === "local") {
    base.command = config.command.join(" ")
    base.env = config.environment ? JSON.stringify(config.environment, null, 2) : ""
    return base
  }
  base.url = config.url
  base.headers = config.headers ? JSON.stringify(config.headers, null, 2) : ""
  if (config.oauth === false) base.oauth = "off"
  else if (config.oauth && "clientId" in config.oauth && config.oauth.clientId) {
    base.oauth = "client"
    base.clientId = config.oauth.clientId
    base.clientSecret = config.oauth.clientSecret ?? ""
    base.scope = config.oauth.scope ?? ""
  } else base.oauth = "auto"
  return base
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
  if (state.type === "local") {
    const command = state.command.trim().split(/\s+/).filter(Boolean)
    if (command.length === 0) throw new Error("Command is required")
    return {
      type: "local",
      command,
      ...(state.env.trim() ? { environment: parseRecord(state.env, "Environment") } : {}),
    }
  }
  if (!URL.canParse(state.url.trim())) throw new Error("Remote URL is invalid")
  return {
    type: "remote",
    url: state.url.trim(),
    ...(state.headers.trim() ? { headers: parseRecord(state.headers, "Headers") } : {}),
    ...(state.oauth === "off"
      ? { oauth: false }
      : state.oauth === "client"
        ? {
            oauth: {
              clientId: state.clientId.trim(),
              ...(state.clientSecret.trim() ? { clientSecret: state.clientSecret.trim() } : {}),
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
        <div class="flex items-center gap-2">
          <FormButton
            label={props.busy ? "saving…" : props.editing ? "save connector" : "add connector"}
            disabled={props.busy}
            onClick={props.onSave}
          />
          <FormButton label="cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
        </div>
      </div>
    </div>
  )
}

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}
