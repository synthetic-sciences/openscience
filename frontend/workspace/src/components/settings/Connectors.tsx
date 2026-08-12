import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import type { Config, McpInspection, McpStatus } from "@synsci/sdk/v2/client"
import "./connectors.css"
import {
  PanelScroll,
  PanelHeader,
  PanelBody,
  Toolbar,
  SearchInput,
  AddMenu,
  SectionLabel,
  EmptyState,
  FormField,
  FormButton,
} from "./_shared"
import {
  blankConnectorForm,
  buildConnectorConfig,
  connectorFormFromConfig,
  connectorIdentity,
  maskConnectorConfig,
  type ConfiguredMcp,
  type ConnectorFormState,
  type McpType,
  type OAuthMode,
} from "./connector-form"

type McpConfig = NonNullable<Config["mcp"]>[string]

function isConfigured(value: McpConfig | undefined): value is ConfiguredMcp {
  return !!value && typeof value === "object" && "type" in value
}

export default function Connectors() {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const dialog = useDialog()

  const [status, setStatus] = createSignal<Record<string, McpStatus>>({})
  const [details, setDetails] = createSignal<Record<string, McpInspection>>({})
  const [search, setSearch] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal("")
  const [expanded, setExpanded] = createSignal<string>()
  const [editing, setEditing] = createSignal<string | undefined>()
  const [form, setForm] = createSignal<ConnectorFormState | undefined>()

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
  async function toggle(name: string, on: boolean) {
    if (busy()) return
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
    if (busy()) return
    const confirmed = await confirmDialog(dialog, {
      title: `Remove "${name}"?`,
      message: "This disconnects the connector and deletes it from your global OpenScience configuration.",
      confirmLabel: "Remove connector",
      danger: true,
    })
    if (!confirmed) return
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
    if (busy()) return
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
    if (busy()) return
    const confirmed = await confirmDialog(dialog, {
      title: `Disconnect "${name}"?`,
      message: "This removes the connector's OAuth credentials from this machine. Its configuration stays in place.",
      confirmLabel: "Disconnect",
      danger: true,
    })
    if (!confirmed) return
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
    setForm(blankConnectorForm(type))
  }
  function editConnector(name: string, config: ConfiguredMcp) {
    setEditing(name)
    setForm(connectorFormFromConfig(name, config))
  }
  function closeForm() {
    setForm(undefined)
    setEditing(undefined)
  }

  async function save() {
    if (busy()) return
    const state = form()
    if (!state) return
    const name = state.name.trim()
    if (!name) {
      showToast({ variant: "error", title: "Connector name is required" })
      return
    }
    setBusy(true)
    try {
      const config = buildConnectorConfig(state)
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
      sync.set("config", "mcp", name, maskConnectorConfig(config))
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
      <div class="connectors-panel">
        <PanelHeader
          title="Connectors"
          description="Connect MCP servers that provide external research tools and data."
          toolbar={
            <Show when={!form()}>
              <Toolbar>
                <SearchInput
                  value={search()}
                  onInput={setSearch}
                  placeholder="Search connectors"
                  ariaLabel="Search connectors"
                />
                <AddMenu
                  label="Add connector"
                  items={[
                    {
                      icon: "cloud",
                      label: "Hosted server",
                      description: "Connect an MCP endpoint over HTTPS",
                      onSelect: () => openForm("remote"),
                    },
                    {
                      icon: "console",
                      label: "Local process",
                      description: "Run a trusted MCP command on this machine",
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
            <div role="alert" class="settings-alert mb-4" data-tone="critical">
              <span class="text-12-regular">Connector status unavailable. {problem()}</span>
              <button
                type="button"
                class="text-12-medium"
                disabled={busy()}
                onClick={() => void refresh().catch(() => undefined)}
              >
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
                  <div class="connectors-empty">
                    <div class="connectors-empty__icon">
                      <Icon name="mcp" size="normal" />
                    </div>
                    <div class="connectors-empty__copy">
                      <strong>Connect your research tools</strong>
                      <p>Add a hosted MCP server with optional OAuth, or run a trusted MCP command on this machine.</p>
                    </div>
                    <div class="connectors-empty__actions">
                      <FormButton label="Hosted server" onClick={() => openForm("remote")} />
                      <FormButton label="Local process" variant="ghost" onClick={() => openForm("local")} />
                    </div>
                  </div>
                </Show>
              }
            >
              <section class="settings-section connectors-section" aria-label="Configured connectors">
                <SectionLabel label="Connectors" count={entries().length} />
                <div class="connectors-list" role="list">
                  <For each={entries()}>
                    {(entry) => {
                      const name = entry[0]
                      const config = entry[1]
                      const s = () => status()[name]
                      const detail = () => details()[name]
                      const identity = connectorIdentity(name, config)
                      return (
                        <article
                          class="connectors-item"
                          data-expanded={expanded() === name ? "true" : undefined}
                          role="listitem"
                        >
                          <div class="connectors-row">
                            <div class="connectors-identity" data-kind={identity.icon}>
                              <Icon name={identity.icon} size="small" />
                            </div>
                            <div class="connectors-copy">
                              <div class="connectors-copy__title">
                                <strong>{name}</strong>
                                <span>{identity.label}</span>
                              </div>
                              <p title={config.type === "local" ? config.command.join(" ") : config.url}>
                                {config.type === "local" ? config.command.join(" ") : config.url}
                              </p>
                              <Show when={detail()}>
                                {(value) => (
                                  <div class="connectors-capability-summary">
                                    <span>{value().tools.length} tools</span>
                                    <span>{value().resources.length} resources</span>
                                    <span>{value().prompts.length} prompts</span>
                                  </div>
                                )}
                              </Show>
                            </div>
                            <span class="connectors-status" data-tone={dot(s())}>
                              <span aria-hidden="true" />
                              {statusText(s())}
                            </span>
                            <div class="connectors-row__actions">
                              <Show when={config.type === "remote" && config.oauth !== false}>
                                <button
                                  type="button"
                                  class="connectors-action"
                                  disabled={busy()}
                                  onClick={() => void authenticate(name)}
                                >
                                  {detail()?.auth === "authenticated" ? "Reconnect" : "Connect"}
                                </button>
                              </Show>
                              <IconButton
                                icon="edit"
                                variant="ghost"
                                disabled={busy()}
                                aria-label={`Edit ${name}`}
                                onClick={() => editConnector(name, config)}
                              />
                              <Switch
                                checked={config.enabled !== false}
                                disabled={busy()}
                                onChange={(v) => void toggle(name, v)}
                                hideLabel
                              >
                                {name}
                              </Switch>
                              <IconButton
                                icon={expanded() === name ? "chevron-down" : "chevron-right"}
                                variant="ghost"
                                aria-expanded={expanded() === name}
                                aria-label={expanded() === name ? `Hide ${name} details` : `Show ${name} details`}
                                onClick={() => setExpanded((value) => (value === name ? undefined : name))}
                              />
                            </div>
                          </div>
                          <Show when={expanded() === name}>
                            <div class="connectors-details">
                              <ConnectorInspection detail={detail()} />
                              <div class="connectors-details__actions">
                                <Show when={detail()?.auth === "authenticated" || detail()?.auth === "expired"}>
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    disabled={busy()}
                                    onClick={() => void disconnectAuth(name)}
                                  >
                                    Disconnect OAuth
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  class="connectors-detail-action"
                                  disabled={busy()}
                                  onClick={() => editConnector(name, config)}
                                >
                                  Edit configuration
                                </button>
                                <button
                                  type="button"
                                  class="connectors-detail-action connectors-detail-action--danger"
                                  disabled={busy()}
                                  onClick={() => void remove(name)}
                                >
                                  Remove connector
                                </button>
                              </div>
                            </div>
                          </Show>
                        </article>
                      )
                    }}
                  </For>
                </div>
                <button
                  type="button"
                  class="connectors-refresh"
                  disabled={busy()}
                  onClick={() => void refresh().catch(() => undefined)}
                >
                  <Icon name="refresh" size="small" /> Refresh status
                </button>
              </section>
            </Show>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

function ConnectorForm(props: {
  state: ConnectorFormState
  editing: boolean
  busy: boolean
  onChange: (s: ConnectorFormState) => void
  onSave: () => void
  onCancel: () => void
}) {
  const set = <K extends keyof ConnectorFormState>(key: K, value: ConnectorFormState[K]) =>
    props.onChange({ ...props.state, [key]: value })
  return (
    <section class="settings-section connectors-form-section">
      <SectionLabel label={props.editing ? "Edit connector" : `Add ${props.state.type} connector`} />
      <div class="connectors-form">
        <div class="connectors-form__lead">
          <div class="connectors-identity" data-kind={props.state.type === "remote" ? "cloud" : "console"}>
            <Icon name={props.state.type === "remote" ? "cloud" : "console"} size="small" />
          </div>
          <div>
            <strong>{props.state.type === "remote" ? "Hosted MCP server" : "Local MCP process"}</strong>
            <p>
              {props.state.type === "remote"
                ? "Connect over HTTPS and authenticate with OAuth or headers."
                : "Launch a trusted command and pass environment values locally."}
            </p>
          </div>
        </div>
        <div class="connectors-form__grid">
          <div class="connectors-form__field">
            <FormField
              label="Name"
              value={props.state.name}
              onInput={(v) => set("name", v)}
              placeholder="linear, filesystem…"
            />
          </div>
          <div class="connectors-form__field">
            <FormField
              label="Request timeout (ms)"
              value={props.state.timeout}
              onInput={(v) => set("timeout", v)}
              mono
              placeholder="5000"
            />
          </div>
          <Show
            when={props.state.type === "remote"}
            fallback={
              <>
                <div class="connectors-form__field" data-span="full">
                  <FormField
                    label="Command"
                    value={props.state.command}
                    onInput={(v) => set("command", v)}
                    mono
                    placeholder="npx -y @modelcontextprotocol/server-filesystem ."
                  />
                </div>
                <div class="connectors-form__field" data-span="full">
                  <FormField
                    label="Environment (JSON)"
                    value={props.state.env}
                    onInput={(v) => set("env", v)}
                    multiline
                    mono
                    placeholder={'{ "TOKEN": "..." }'}
                  />
                </div>
                <Show when={props.editing && props.state.env}>
                  <p class="connectors-form__hint">
                    Stored values are masked. Keep the mask to preserve a value, replace it to update, or remove its key
                    to delete it.
                  </p>
                </Show>
              </>
            }
          >
            <div class="connectors-form__field" data-span="full">
              <FormField
                label="URL"
                value={props.state.url}
                onInput={(v) => set("url", v)}
                mono
                placeholder="https://mcp.example.com/mcp"
              />
            </div>
            <label class="connectors-form__field connectors-form__select">
              <span>OAuth</span>
              <select
                value={props.state.oauth}
                class="settings-field"
                onInput={(e) => set("oauth", e.currentTarget.value as OAuthMode)}
              >
                <option value="auto">Automatic registration</option>
                <option value="client">Pre-registered client</option>
                <option value="off">No OAuth</option>
              </select>
            </label>
            <div class="connectors-form__field" data-span="full">
              <FormField
                label="Headers (JSON)"
                value={props.state.headers}
                onInput={(v) => set("headers", v)}
                multiline
                mono
                placeholder={'{ "Authorization": "Bearer ..." }'}
              />
            </div>
            <Show when={props.editing && props.state.headers}>
              <p class="connectors-form__hint">
                Stored header values are masked. Keep the mask to preserve a value, replace it to update, or remove its
                key to delete it.
              </p>
            </Show>
            <Show when={props.state.oauth === "client"}>
              <div class="connectors-form__field">
                <FormField label="Client ID" value={props.state.clientId} onInput={(v) => set("clientId", v)} mono />
              </div>
              <div class="connectors-form__field">
                <FormField
                  label="Client secret"
                  value={props.state.clientSecret}
                  onInput={(v) => set("clientSecret", v)}
                  mono
                />
              </div>
              <div class="connectors-form__field" data-span="full">
                <FormField label="Scope" value={props.state.scope} onInput={(v) => set("scope", v)} mono />
              </div>
            </Show>
          </Show>
        </div>
        <div class="connectors-form__actions">
          <FormButton
            label={props.busy ? "Saving…" : props.editing ? "Save connector" : "Add connector"}
            disabled={props.busy}
            onClick={props.onSave}
          />
          <FormButton label="Cancel" variant="ghost" onClick={props.onCancel} disabled={props.busy} />
        </div>
      </div>
    </section>
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
    <div class="connectors-inspection">
      <Show when={props.detail} fallback={<span class="connectors-inspection__loading">Inspecting connector…</span>}>
        {(detail) => (
          <>
            <Show when={failures().length > 0}>
              <div role="alert" class="settings-alert" data-tone="critical" data-stacked="true">
                <For each={failures()}>{(error) => <p class="text-12-regular break-words">{error}</p>}</For>
              </div>
            </Show>
            <div class="connectors-inspection__grid">
              <CapabilityList
                icon="settings-gear"
                title="Tools"
                empty="No tools reported"
                items={detail().tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                }))}
              />
              <CapabilityList
                icon="folder"
                title="Resources"
                empty="No resources reported"
                items={detail().resources.map((resource) => ({
                  name: resource.name,
                  description: resource.description ?? resource.uri,
                }))}
              />
              <CapabilityList
                icon="speech-bubble"
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

function CapabilityList(props: {
  icon: "folder" | "settings-gear" | "speech-bubble"
  title: string
  empty: string
  items: Array<{ name: string; description?: string }>
}) {
  return (
    <section class="connectors-capability">
      <header>
        <Icon name={props.icon} size="small" />
        <h3>{props.title}</h3>
        <span>{props.items.length}</span>
      </header>
      <Show when={props.items.length > 0} fallback={<p class="connectors-capability__empty">{props.empty}</p>}>
        <ul>
          <For each={props.items}>
            {(item) => (
              <li>
                <p class="connectors-capability__name" title={item.name}>
                  {item.name}
                </p>
                <Show when={item.description}>
                  <p class="connectors-capability__description">{item.description}</p>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  )
}
