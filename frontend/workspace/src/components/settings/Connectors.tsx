import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { IconButton } from "@synsci/ui/icon-button"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import type { Config, McpInspection, McpStatus } from "@synsci/sdk/v2/client"
import "./connectors.css"
import { settingsApi } from "./api"
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
  catalogPresetConfig,
  connectorFormFromCatalog,
  connectorFormFromConfig,
  connectorConflictsWithCatalogPreset,
  connectorIdentity,
  maskConnectorConfig,
  type ConfiguredMcp,
  type ConnectorFormState,
  type McpType,
  type OAuthMode,
} from "./connector-form"
import type { ConnectorCatalogRecord } from "./scientific-tools-state"
import { loadScientificTools } from "./scientific-tools-loader"
import { ProviderLogo } from "./ProviderLogo"

type McpConfig = NonNullable<Config["mcp"]>[string]
type PendingAuthorization = { authorizationUrl: string; flowId: string }
type AuthenticationStart = ({ state: "pending" } & PendingAuthorization) | { state: "settled"; result: McpStatus }

function isConfigured(value: McpConfig | undefined): value is ConfiguredMcp {
  return !!value && typeof value === "object" && "type" in value
}

export default function Connectors() {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const platform = usePlatform()
  const server = useServer()

  const [status, setStatus] = createSignal<Record<string, McpStatus>>({})
  const [details, setDetails] = createSignal<Record<string, McpInspection>>({})
  const [inspectionProblems, setInspectionProblems] = createSignal<Record<string, string>>({})
  const [search, setSearch] = createSignal("")
  const [busyKeys, setBusyKeys] = createSignal(new Set<string>())
  const [problem, setProblem] = createSignal("")
  const [catalog, setCatalog] = createSignal<ConnectorCatalogRecord[]>([])
  const [catalogProblem, setCatalogProblem] = createSignal("")
  const [catalogLoading, setCatalogLoading] = createSignal(true)
  const [catalogExpanded, setCatalogExpanded] = createSignal<string>()
  const [expanded, setExpanded] = createSignal<string>()
  const [editing, setEditing] = createSignal<string | undefined>()
  const [form, setForm] = createSignal<ConnectorFormState | undefined>()
  const [pendingAuthorizations, setPendingAuthorizations] = createSignal<Record<string, PendingAuthorization>>({})
  const busy = (key?: string) => (key ? busyKeys().has(key) : busyKeys().size > 0)
  const setBusy = (key: string, value: boolean) =>
    setBusyKeys((current) => {
      const next = new Set(current)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })

  const configuredEntries = createMemo(() =>
    Object.entries(sync.data.config.mcp ?? {}).filter((e): e is [string, ConfiguredMcp] => isConfigured(e[1])),
  )
  const entries = createMemo(() => {
    const needle = search().trim().toLowerCase()
    return configuredEntries()
      .filter(([name, config]) => {
        if (!needle) return true
        const identity = connectorIdentity(name, config)
        const target = config.type === "local" ? config.command.join(" ") : config.url
        return [name, identity.label, target].some((value) => value.toLowerCase().includes(needle))
      })
      .sort((a, b) => {
        const rank = ([name, config]: [string, ConfiguredMcp]) => {
          if (status()[name]?.status === "connected") return 0
          if (config.enabled !== false) return 1
          return 2
        }
        return rank(a) - rank(b) || a[0].localeCompare(b[0])
      })
  })
  const matchingCatalogEntries = createMemo(() => {
    const needle = search().trim().toLowerCase()
    return catalog().filter(
      (entry) =>
        !needle ||
        [entry.name, entry.provider, entry.summary, ...entry.read_operations].some((value) =>
          value.toLowerCase().includes(needle),
        ),
    )
  })
  const isCatalogConfigured = (entry: ConnectorCatalogRecord) => {
    const providerLogo = entry.id === "s3" ? "aws" : entry.id
    return configuredEntries().some(([name, config]) => {
      if (entry.setup?.name === name) return true
      return connectorIdentity(name, config).providerLogo === providerLogo
    })
  }
  const catalogEntries = createMemo(() =>
    matchingCatalogEntries()
      .filter((entry) => entry.status === "official_setup" && !isCatalogConfigured(entry))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.name.localeCompare(b.name)),
  )
  const manualCatalogEntries = createMemo(() =>
    matchingCatalogEntries()
      .filter((entry) => entry.status === "manual_review" && !isCatalogConfigured(entry))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  async function loadCatalog(refresh = false) {
    setCatalogLoading(true)
    try {
      const fetcher = platform.fetch ?? fetch
      const result = await loadScientificTools(server.url, fetcher, refresh)
      setCatalog(result.connectors)
      setCatalogProblem("")
    } catch (error) {
      setCatalogProblem(message(error))
    } finally {
      setCatalogLoading(false)
    }
  }

  async function refresh() {
    try {
      const res = await sdk.client.mcp.status()
      setStatus(res.data ?? {})
      setProblem("")
    } catch (error) {
      setProblem(message(error))
      throw error
    }
  }
  async function inspect(name: string) {
    const key = `inspect:${name}`
    if (busy(key)) return
    setBusy(key, true)
    setInspectionProblems((current) => ({ ...current, [name]: "" }))
    try {
      const result = await sdk.client.mcp.inspect({ name })
      if (!result.data) throw new Error("The connector returned no capability details.")
      setDetails((current) => ({ ...current, [name]: result.data! }))
    } catch (error) {
      setInspectionProblems((current) => ({ ...current, [name]: message(error) }))
    } finally {
      setBusy(key, false)
    }
  }
  function toggleDetails(name: string) {
    const opening = expanded() !== name
    setExpanded(opening ? name : undefined)
    if (opening && !details()[name]) void inspect(name)
  }
  onMount(() => {
    void refresh().catch(() => undefined)
    void loadCatalog()
    void restorePendingAuthorizations()
  })

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
    const key = `row:${name}`
    if (busy(key)) return
    const config = entries().find(([key]) => key === name)?.[1]
    if (!config) return
    setBusy(key, true)
    try {
      const next = { ...config, enabled: on }
      await sdk.client.mcp.config.set({ name, config: next, scope: "global" })
      sync.set("config", "mcp", name, next)
      await refresh()
    } catch (err) {
      showToast({ variant: "error", title: `Could not turn connector ${on ? "on" : "off"}`, description: message(err) })
    } finally {
      setBusy(key, false)
    }
  }

  async function remove(name: string) {
    const key = `row:${name}`
    if (busy(key)) return
    const confirmed = await confirmDialog(dialog, {
      title: `Remove "${name}"?`,
      message: "This disconnects the connector and deletes it from your global OpenScience configuration.",
      confirmLabel: "Remove connector",
      danger: true,
    })
    if (!confirmed) return
    setBusy(key, true)
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
      setBusy(key, false)
    }
  }

  const authPath = (name: string, suffix = "") => `/mcp/${encodeURIComponent(name)}/auth${suffix}`
  const fetcher = () => platform.fetch ?? fetch
  function setPendingAuthorization(name: string, value?: PendingAuthorization) {
    setPendingAuthorizations((current) => {
      const next = { ...current }
      if (value) next[name] = value
      else delete next[name]
      return next
    })
  }
  async function acceptAuthenticationResult(name: string, result: McpStatus): Promise<McpStatus> {
    if (result.status !== "connected") {
      throw new Error(
        result.status === "failed" ? result.error : `Connector returned ${result.status.replaceAll("_", " ")}`,
      )
    }
    await refresh()
    await inspect(name)
    return result
  }
  async function waitForAuthentication(name: string, operation: PendingAuthorization): Promise<McpStatus> {
    setPendingAuthorization(name, operation)
    try {
      const result = await settingsApi<McpStatus>(
        server.url,
        fetcher(),
        `${authPath(name, "/wait")}?flow_id=${encodeURIComponent(operation.flowId)}`,
        { method: "POST" },
      )
      return await acceptAuthenticationResult(name, result)
    } finally {
      setPendingAuthorization(name)
    }
  }
  async function beginAuthentication(name: string): Promise<McpStatus> {
    const existing = pendingAuthorizations()[name]
    if (existing) return waitForAuthentication(name, existing)
    const key = `auth-start:${name}`
    if (busy(key)) throw new Error("Authorization is already starting")
    setBusy(key, true)
    let started: AuthenticationStart
    try {
      started = await settingsApi<AuthenticationStart>(server.url, fetcher(), authPath(name), { method: "POST" })
      if (started.state === "settled") return await acceptAuthenticationResult(name, started.result)
      setPendingAuthorization(name, started)
      await Promise.resolve(platform.openLink(started.authorizationUrl)).catch(() => undefined)
    } finally {
      setBusy(key, false)
    }
    return waitForAuthentication(name, started)
  }
  async function restorePendingAuthorizations() {
    const configured = Object.entries(sync.data.config.mcp ?? {}).filter(
      (entry): entry is [string, ConfiguredMcp] => isConfigured(entry[1]) && entry[1].type === "remote",
    )
    await Promise.all(
      configured.map(async ([name]) => {
        const result = await settingsApi<{ pending: boolean; authorizationUrl?: string; flowId?: string }>(
          server.url,
          fetcher(),
          authPath(name, "/pending"),
        ).catch(() => undefined)
        if (!result?.pending || !result.authorizationUrl || !result.flowId) return
        const operation = { authorizationUrl: result.authorizationUrl, flowId: result.flowId }
        setPendingAuthorization(name, operation)
        void waitForAuthentication(name, operation).catch(() => undefined)
      }),
    )
  }
  async function cancelAuthentication(name: string) {
    const operation = pendingAuthorizations()[name]
    if (!operation) return
    const key = `auth-cancel:${name}`
    if (busy(key)) return
    setBusy(key, true)
    try {
      await settingsApi<{ success: true }>(
        server.url,
        fetcher(),
        `${authPath(name, "/pending")}?flow_id=${encodeURIComponent(operation.flowId)}`,
        { method: "DELETE" },
      )
      setPendingAuthorization(name)
      showToast({ title: `Authorization for "${name}" cancelled` })
    } catch (error) {
      showToast({ variant: "error", title: "Could not cancel authorization", description: message(error) })
    } finally {
      setBusy(key, false)
    }
  }

  async function authenticate(name: string) {
    const key = `row:${name}`
    if (busy(key) || pendingAuthorizations()[name]) return
    try {
      await beginAuthentication(name)
      showToast({ variant: "success", title: `"${name}" connected` })
    } catch (err) {
      const description = message(err)
      showToast({
        variant: description.toLowerCase().includes("cancel") ? undefined : "error",
        title: description.toLowerCase().includes("cancel") ? "Authorization cancelled" : "Authentication failed",
        description,
      })
    }
  }

  async function disconnectAuth(name: string) {
    const key = `row:${name}`
    if (busy(key)) return
    const confirmed = await confirmDialog(dialog, {
      title: `Disconnect "${name}"?`,
      message: "This removes the connector's OAuth credentials from this machine. Its configuration stays in place.",
      confirmLabel: "Disconnect",
      danger: true,
    })
    if (!confirmed) return
    setBusy(key, true)
    try {
      await sdk.client.mcp.auth.remove({ name })
      await refresh()
      await inspect(name)
      showToast({ variant: "success", title: `"${name}" disconnected` })
    } catch (err) {
      showToast({ variant: "error", title: "Disconnect failed", description: message(err) })
    } finally {
      setBusy(key, false)
    }
  }

  function openForm(type: McpType) {
    setEditing(undefined)
    setForm(blankConnectorForm(type))
  }
  function reviewCatalogSetup(entry: ConnectorCatalogRecord) {
    if (!entry.setup) return
    setEditing(undefined)
    setForm(connectorFormFromCatalog(entry.setup))
  }
  async function addCatalogPreset(entry: ConnectorCatalogRecord) {
    const setup = entry.setup
    if (!setup?.one_click_disabled && !setup?.one_click_connect) return reviewCatalogSetup(entry)
    const key = `catalog:${entry.id}`
    if (busy(key)) return
    const current = sync.data.config.mcp?.[setup.name]
    const configured = isConfigured(current) ? current : undefined
    if (connectorConflictsWithCatalogPreset(configured, setup)) {
      showToast({
        variant: "error",
        title: `Connector name "${setup.name}" is already in use`,
        description: "Review or remove the existing custom configuration before applying the recommended preset.",
      })
      return
    }
    setBusy(key, true)
    setBusy(`row:${setup.name}`, true)
    let created = false
    try {
      const config = catalogPresetConfig(setup)
      if (!configured) {
        await sdk.client.mcp.config.set({ name: setup.name, config, scope: "global" })
        sync.set("config", "mcp", setup.name, maskConnectorConfig(config))
        created = true
      }
      await refresh()
      if (setup.one_click_connect) {
        await beginAuthentication(setup.name)
        sync.set("config", "mcp", setup.name, { ...maskConnectorConfig(config), enabled: true })
        await refresh()
        await inspect(setup.name)
        showToast({
          variant: "success",
          title: `${entry.name} connected`,
          description: "No tool was invoked and no paid compute resource was created during setup.",
        })
        return
      }
      showToast({
        variant: "success",
        title: `${entry.name} added safely off`,
        description: "No network call, OAuth token, tool invocation, or paid resource was created.",
      })
    } catch (error) {
      let rollbackProblem = ""
      if (created && setup.one_click_connect) {
        await sdk.client.mcp.config
          .remove({ name: setup.name, scope: "global" })
          .then(() => {
            sync.set("config", "mcp", (current = {}) => {
              const next = { ...current }
              delete next[setup.name]
              return next
            })
          })
          .catch((cause) => {
            rollbackProblem = message(cause)
          })
        await refresh().catch(() => undefined)
      }
      showToast({
        variant: "error",
        title: setup.one_click_connect ? `${entry.name} was not connected` : `${entry.name} preset was not added`,
        description:
          created && setup.one_click_connect
            ? rollbackProblem
              ? `${message(error)} Automatic cleanup also failed: ${rollbackProblem}. Review the saved connector before retrying.`
              : `${message(error)} The new preset and its local OAuth authority were rolled back.`
            : message(error),
      })
    } finally {
      setBusy(key, false)
      setBusy(`row:${setup.name}`, false)
    }
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
    const key = "form"
    if (busy(key)) return
    const state = form()
    if (!state) return
    const name = state.name.trim()
    if (!name) {
      showToast({ variant: "error", title: "Connector name is required" })
      return
    }
    setBusy(key, true)
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
      } else if (config.enabled === false || live?.status === "disabled") {
        showToast({
          title: `Connector "${name}" saved, still off`,
          description: "Enable it when you are ready to connect, inspect its tools, and review each invocation.",
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
      setBusy(key, false)
    }
  }

  return (
    <PanelScroll>
      <div class="connectors-panel">
        <PanelHeader title="Connectors" description="Use your own MCP servers for research tools and data." />

        <PanelBody>
          <Show when={problem()}>
            <div role="alert" class="settings-alert mb-4" data-tone="critical">
              <span class="text-12-regular">Connector status unavailable. {problem()}</span>
              <button
                type="button"
                class="text-12-medium"
                disabled={busy("refresh")}
                onClick={() => {
                  setBusy("refresh", true)
                  void refresh()
                    .catch(() => undefined)
                    .finally(() => setBusy("refresh", false))
                }}
              >
                Retry
              </button>
            </div>
          </Show>
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
                    label: "Remote server",
                    description: "Connect your MCP endpoint over HTTPS",
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
          <Show when={form()}>
            {(state) => (
              <ConnectorForm
                state={state()}
                editing={!!editing()}
                busy={busy("form")}
                onChange={setForm}
                onSave={save}
                onCancel={closeForm}
              />
            )}
          </Show>

          <Show when={!form()}>
            <Show when={catalogProblem()}>
              <div role="alert" class="settings-alert mb-4" data-tone="critical">
                <span class="text-12-regular">Connector catalog unavailable. {catalogProblem()}</span>
                <button
                  type="button"
                  class="connectors-detail-action"
                  disabled={catalogLoading()}
                  onClick={() => void loadCatalog(true)}
                >
                  Retry
                </button>
              </div>
            </Show>

            <Show when={catalogLoading() && !catalogProblem() && configuredEntries().length === 0}>
              <section class="settings-section connectors-loading" aria-label="Loading connectors">
                <SectionLabel label="Available connectors" />
                <div class="settings-card">
                  <div class="connectors-loading__row" role="status">
                    <Icon name="mcp" size="small" />
                    <span>Loading reviewed setups…</span>
                  </div>
                </div>
              </section>
            </Show>

            <Show when={entries().length > 0}>
              <section class="settings-section connectors-section" aria-label="Configured connectors">
                <SectionLabel label="Your connectors" count={entries().length} />
                <p class="connectors-section__lead">Connected and saved servers appear here first.</p>
                <div class="settings-card connectors-list" role="list">
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
                              <Show when={identity.providerLogo} fallback={<Icon name={identity.icon} size="small" />}>
                                {(provider) => <ProviderLogo id={provider()} label={identity.label} size="small" />}
                              </Show>
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
                              <Show
                                when={
                                  config.type === "remote" &&
                                  config.oauth !== false &&
                                  s()?.status !== "connected" &&
                                  detail()?.auth !== "authenticated"
                                }
                              >
                                <button
                                  type="button"
                                  class="connectors-action"
                                  disabled={
                                    busy(`row:${name}`) || busy(`auth-start:${name}`) || !!pendingAuthorizations()[name]
                                  }
                                  onClick={() => void authenticate(name)}
                                >
                                  {pendingAuthorizations()[name] ? "Waiting…" : "Connect"}
                                </button>
                              </Show>
                              <IconButton
                                icon="edit"
                                variant="ghost"
                                disabled={busy(`row:${name}`)}
                                aria-label={`Edit ${name}`}
                                onClick={() => editConnector(name, config)}
                              />
                              <Switch
                                checked={config.enabled !== false}
                                disabled={busy(`row:${name}`)}
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
                                onClick={() => toggleDetails(name)}
                              />
                            </div>
                          </div>
                          <Show when={pendingAuthorizations()[name]}>
                            {(authorization) => (
                              <div class="connectors-oauth" role="status" aria-live="polite">
                                <div>
                                  <strong>Waiting for browser authorization</strong>
                                  <span>You can reopen the provider page or cancel this exact attempt.</span>
                                </div>
                                <div class="connectors-oauth__actions">
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    onClick={() => platform.openLink(authorization().authorizationUrl)}
                                  >
                                    Open authorization page
                                  </button>
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    disabled={busy(`auth-cancel:${name}`)}
                                    onClick={() => void cancelAuthentication(name)}
                                  >
                                    {busy(`auth-cancel:${name}`) ? "Cancelling…" : "Cancel"}
                                  </button>
                                </div>
                              </div>
                            )}
                          </Show>
                          <Show when={expanded() === name}>
                            <div class="connectors-details">
                              <Show
                                when={!busy(`inspect:${name}`)}
                                fallback={
                                  <div class="connectors-inspection-state" role="status">
                                    Inspecting available tools and resources…
                                  </div>
                                }
                              >
                                <Show
                                  when={!inspectionProblems()[name]}
                                  fallback={
                                    <div class="connectors-inspection-state" role="alert">
                                      <span>Could not inspect this connector. {inspectionProblems()[name]}</span>
                                      <button type="button" onClick={() => void inspect(name)}>
                                        Retry
                                      </button>
                                    </div>
                                  }
                                >
                                  <ConnectorInspection detail={detail()} />
                                </Show>
                              </Show>
                              <div class="connectors-details__actions">
                                <Show when={config.type === "remote" && config.oauth !== false}>
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    disabled={
                                      busy(`row:${name}`) ||
                                      busy(`auth-start:${name}`) ||
                                      !!pendingAuthorizations()[name]
                                    }
                                    onClick={() => void authenticate(name)}
                                  >
                                    Reconnect account
                                  </button>
                                </Show>
                                <Show when={detail()?.auth === "authenticated" || detail()?.auth === "expired"}>
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    disabled={busy(`row:${name}`)}
                                    onClick={() => void disconnectAuth(name)}
                                  >
                                    Disconnect OAuth
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  class="connectors-detail-action"
                                  disabled={busy(`row:${name}`)}
                                  onClick={() => editConnector(name, config)}
                                >
                                  Edit configuration
                                </button>
                                <button
                                  type="button"
                                  class="connectors-detail-action connectors-detail-action--danger"
                                  disabled={busy(`row:${name}`)}
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
                  disabled={busy("refresh")}
                  onClick={() => {
                    setBusy("refresh", true)
                    void refresh()
                      .catch(() => undefined)
                      .finally(() => setBusy("refresh", false))
                  }}
                >
                  <Icon name="refresh" size="small" /> Refresh status
                </button>
              </section>
            </Show>

            <Show when={catalogEntries().length > 0}>
              <section class="settings-section connectors-catalog" aria-label="Available connectors">
                <SectionLabel label="Available connectors" count={catalogEntries().length} />
                <p class="connectors-catalog__lead">
                  Start from a reviewed official setup. OpenScience uses your account and keeps each server under MCP
                  permissions.
                </p>
                <div class="settings-card connectors-catalog__list" role="list">
                  <For each={catalogEntries()}>
                    {(entry) => (
                      <article
                        class="connectors-catalog__row"
                        role="listitem"
                        data-state={entry.status}
                        data-expanded={catalogExpanded() === entry.id ? "true" : undefined}
                      >
                        <div class="connectors-catalog__main">
                          <ProviderLogo id={entry.id === "s3" ? "aws" : entry.id} label={entry.name} size="small" />
                          <div class="connectors-catalog__copy">
                            <div class="connectors-catalog__title">
                              <strong>{entry.name}</strong>
                              <span>{entry.recommended ? "Recommended" : "Official"}</span>
                            </div>
                            <p>{entry.summary}</p>
                          </div>
                          <div class="connectors-catalog__actions">
                            <button
                              type="button"
                              class="connectors-action connectors-action--primary"
                              disabled={busy(`catalog:${entry.id}`)}
                              onClick={() => void addCatalogPreset(entry)}
                            >
                              {entry.setup?.one_click_connect
                                ? busy(`catalog:${entry.id}`)
                                  ? "Connecting…"
                                  : "Connect"
                                : "Set up"}
                            </button>
                            <IconButton
                              icon={catalogExpanded() === entry.id ? "chevron-down" : "chevron-right"}
                              variant="ghost"
                              aria-expanded={catalogExpanded() === entry.id}
                              aria-label={`${catalogExpanded() === entry.id ? "Hide" : "Show"} ${entry.name} details`}
                              onClick={() => setCatalogExpanded(catalogExpanded() === entry.id ? undefined : entry.id)}
                            />
                          </div>
                        </div>
                        <Show when={catalogExpanded() === entry.id}>
                          <div class="connectors-catalog__details">
                            <p>{entry.safety}</p>
                            <dl>
                              <div>
                                <dt>Needs</dt>
                                <dd>{entry.requirements.join(" · ") || "Nothing else"}</dd>
                              </div>
                              <div>
                                <dt>Can write</dt>
                                <dd>{entry.upstream_write_operations.join(" · ") || "No write operations declared"}</dd>
                              </div>
                            </dl>
                            <button
                              type="button"
                              class="connectors-detail-action"
                              onClick={() => platform.openLink(entry.source_url)}
                            >
                              Official documentation
                            </button>
                          </div>
                        </Show>
                      </article>
                    )}
                  </For>
                </div>
              </section>
            </Show>

            <Show when={manualCatalogEntries().length > 0}>
              <details class="connectors-manual">
                <summary>
                  <span>
                    <strong>Manual integrations</strong>
                    <small>
                      {manualCatalogEntries()
                        .map((entry) => entry.name)
                        .join(" · ")}
                    </small>
                  </span>
                  <Icon name="chevron-right" size="small" />
                </summary>
                <div class="settings-card connectors-manual__list" role="list">
                  <For each={manualCatalogEntries()}>
                    {(entry) => (
                      <article class="connectors-manual__row" role="listitem">
                        <ProviderLogo id={entry.id} label={entry.name} size="small" />
                        <div class="connectors-catalog__copy">
                          <div class="connectors-catalog__title">
                            <strong>{entry.name}</strong>
                            <span>Manual setup</span>
                          </div>
                          <p>{entry.summary}</p>
                        </div>
                        <div class="connectors-catalog__actions">
                          <button
                            type="button"
                            class="connectors-detail-action"
                            onClick={() => platform.openLink(entry.source_url)}
                          >
                            Guide
                          </button>
                          <button
                            type="button"
                            class="connectors-action"
                            onClick={() => openForm(entry.id === "dropbox" ? "local" : "remote")}
                          >
                            Add
                          </button>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </details>
            </Show>

            <Show
              when={
                !catalogLoading() &&
                !catalogProblem() &&
                entries().length === 0 &&
                catalogEntries().length === 0 &&
                manualCatalogEntries().length === 0
              }
            >
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
                    <p>Add your own remote MCP endpoint or run a trusted MCP command on this machine.</p>
                  </div>
                  <div class="connectors-empty__actions">
                    <FormButton label="Remote server" onClick={() => openForm("remote")} />
                    <FormButton label="Local process" variant="ghost" onClick={() => openForm("local")} />
                  </div>
                </div>
              </Show>
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
            <strong>{props.state.type === "remote" ? "Remote MCP server" : "Local MCP process"}</strong>
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
                <FormField
                  label="Client ID (required)"
                  value={props.state.clientId}
                  onInput={(v) => set("clientId", v)}
                  mono
                />
              </div>
              <div class="connectors-form__field">
                <FormField
                  label={props.state.requireClientSecret ? "Client secret (required)" : "Client secret"}
                  value={props.state.clientSecret}
                  onInput={(v) => set("clientSecret", v)}
                  mono
                  secret
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
        <Show when={props.state.initiallyDisabled && !props.editing}>
          <p class="connectors-form__hint">
            Catalog setups are saved off. Enable this connector explicitly, then inspect its discovered tools before
            approving any invocation.
          </p>
        </Show>
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
