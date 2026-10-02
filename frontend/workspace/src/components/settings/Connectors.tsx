import { ConnectorFormError } from "./form-error"
import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { confirmDialog } from "@/atlas/dialogs"
import { useGlobalSync } from "@/context/global-sync"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
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

const OAUTH_OPTIONS = [
  { value: "auto", label: "settings.connectors.oauthMode.auto" },
  { value: "client", label: "settings.connectors.oauthMode.client" },
  { value: "off", label: "settings.connectors.oauthMode.off" },
] as const satisfies ReadonlyArray<{ value: OAuthMode; label: string }>

export default function Connectors() {
  const sync = useGlobalSync()
  const sdk = useGlobalSDK()
  const dialog = useDialog()
  const platform = usePlatform()
  const server = useServer()
  const language = useLanguage()
  const message = (error: unknown) =>
    error instanceof ConnectorFormError
      ? language.t(error.key, {
          ...error.values,
          ...(error.values.label
            ? {
                label: language.t(
                  error.values.label === "Environment"
                    ? "settings.validation.environment"
                    : "settings.validation.headers",
                ),
              }
            : {}),
        })
      : rawMessage(error)

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
      if (!result.data) throw new Error(language.t("settings.connectors.inspect.empty"))
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
    if (!s) return language.t("settings.connectors.status.checking")
    if (s.status === "connected") return language.t("mcp.status.connected")
    if (s.status === "disabled") return language.t("settings.connectors.status.off")
    if (s.status === "failed") return language.t("settings.connectors.status.error")
    if (s.status === "needs_auth") return language.t("settings.connectors.status.needsAuth")
    return language.t("settings.connectors.status.needsClientRegistration")
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
      showToast({
        variant: "error",
        title: language.t(on ? "settings.connectors.toast.turnOnFailed" : "settings.connectors.toast.turnOffFailed"),
        description: message(err),
      })
    } finally {
      setBusy(key, false)
    }
  }

  async function remove(name: string) {
    const key = `row:${name}`
    if (busy(key)) return
    const confirmed = await confirmDialog(dialog, {
      cancelLabel: language.t("common.cancel"),
      title: language.t("settings.connectors.remove.title", { name }),
      message: language.t("settings.connectors.remove.message"),
      confirmLabel: language.t("settings.connectors.action.remove"),
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
      showToast({
        variant: "error",
        title: language.t("settings.connectors.toast.removeFailed"),
        description: message(err),
      })
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
        result.status === "failed"
          ? result.error
          : language.t("settings.connectors.error.returned", { status: result.status.replaceAll("_", " ") }),
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
    if (busy(key)) throw new Error(language.t("settings.connectors.error.authStarting"))
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
      showToast({ title: language.t("settings.connectors.toast.authCancelled.named", { name }) })
    } catch (error) {
      showToast({
        variant: "error",
        title: language.t("settings.connectors.toast.cancelFailed"),
        description: message(error),
      })
    } finally {
      setBusy(key, false)
    }
  }

  async function authenticate(name: string) {
    const key = `row:${name}`
    if (busy(key) || pendingAuthorizations()[name]) return
    try {
      await beginAuthentication(name)
      showToast({ variant: "success", title: language.t("settings.connectors.toast.connected", { name }) })
    } catch (err) {
      const description = message(err)
      showToast({
        variant: description.toLowerCase().includes("cancel") ? undefined : "error",
        title: language.t(
          description.toLowerCase().includes("cancel")
            ? "settings.connectors.toast.authCancelled"
            : "settings.connectors.toast.authFailed",
        ),
        description,
      })
    }
  }

  async function disconnectAuth(name: string) {
    const key = `row:${name}`
    if (busy(key)) return
    const confirmed = await confirmDialog(dialog, {
      cancelLabel: language.t("common.cancel"),
      title: language.t("settings.connectors.disconnect.title", { name }),
      message: language.t("settings.connectors.disconnect.message"),
      confirmLabel: language.t("common.disconnect"),
      danger: true,
    })
    if (!confirmed) return
    setBusy(key, true)
    try {
      await sdk.client.mcp.auth.remove({ name })
      await refresh()
      await inspect(name)
      showToast({ variant: "success", title: language.t("settings.connectors.toast.disconnected", { name }) })
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("settings.connectors.toast.disconnectFailed"),
        description: message(err),
      })
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
        title: language.t("settings.connectors.preset.nameInUse", { name: setup.name }),
        description: language.t("settings.connectors.preset.nameInUse.description"),
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
          title: language.t("settings.connectors.preset.connected", { name: entry.name }),
          description: language.t("settings.connectors.preset.connected.description"),
        })
        return
      }
      showToast({
        variant: "success",
        title: language.t("settings.connectors.preset.added", { name: entry.name }),
        description: language.t("settings.connectors.preset.added.description"),
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
        title: language.t(
          setup.one_click_connect ? "settings.connectors.preset.notConnected" : "settings.connectors.preset.notAdded",
          { name: entry.name },
        ),
        description:
          created && setup.one_click_connect
            ? rollbackProblem
              ? language.t("settings.connectors.preset.cleanupFailed", {
                  error: message(error),
                  cleanup: rollbackProblem,
                })
              : language.t("settings.connectors.preset.rolledBack", { error: message(error) })
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
      showToast({ variant: "error", title: language.t("settings.connectors.toast.nameRequired") })
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
          title: language.t("settings.connectors.toast.savedFailed", { name }),
          description: live.error,
        })
      } else if (config.enabled === false || live?.status === "disabled") {
        showToast({
          title: language.t("settings.connectors.toast.savedOff", { name }),
          description: language.t("settings.connectors.toast.savedOff.description"),
        })
      } else if (live?.status === "needs_auth" || live?.status === "needs_client_registration") {
        showToast({
          title: language.t("settings.connectors.toast.saved", { name }),
          description:
            live.status === "needs_auth" ? language.t("settings.connectors.toast.saved.needsAuth") : live.error,
        })
      } else {
        showToast({ variant: "success", title: language.t("settings.connectors.toast.savedConnected", { name }) })
      }
    } catch (err) {
      showToast({
        variant: "error",
        title: language.t("settings.connectors.toast.saveFailed"),
        description: message(err),
      })
    } finally {
      setBusy(key, false)
    }
  }

  return (
    <PanelScroll>
      <div class="connectors-panel">
        <PanelHeader
          title={language.t("settings.connectors.title")}
          description={language.t("settings.connectors.description")}
        />

        <PanelBody>
          <Show when={problem()}>
            <div role="alert" class="settings-alert mb-4" data-tone="critical">
              <span class="text-12-regular">
                {language.t("settings.connectors.status.unavailable", { problem: problem() })}
              </span>
              <Button
                size="small"
                variant="secondary"
                class="settings-panel-action"
                disabled={busy("refresh")}
                onClick={() => {
                  setBusy("refresh", true)
                  void refresh()
                    .catch(() => undefined)
                    .finally(() => setBusy("refresh", false))
                }}
              >
                {language.t("settings.connectors.retry")}
              </Button>
            </div>
          </Show>
          <Show when={!form()}>
            <Toolbar>
              <SearchInput
                value={search()}
                onInput={setSearch}
                placeholder={language.t("settings.connectors.search.placeholder")}
                ariaLabel={language.t("settings.connectors.search.placeholder")}
              />
              <AddMenu
                label={language.t("settings.connectors.add")}
                items={[
                  {
                    icon: "cloud",
                    label: language.t("settings.connectors.type.remote"),
                    description: language.t("settings.connectors.type.remote.description"),
                    onSelect: () => openForm("remote"),
                  },
                  {
                    icon: "console",
                    label: language.t("settings.connectors.type.local"),
                    description: language.t("settings.connectors.type.local.description"),
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
                <span class="text-12-regular">
                  {language.t("settings.connectors.catalog.unavailable", { problem: catalogProblem() })}
                </span>
                <Button
                  size="small"
                  variant="secondary"
                  class="settings-panel-action"
                  disabled={catalogLoading()}
                  onClick={() => void loadCatalog(true)}
                >
                  {language.t("settings.connectors.retry")}
                </Button>
              </div>
            </Show>

            <Show when={catalogLoading() && !catalogProblem() && configuredEntries().length === 0}>
              <section class="settings-section" aria-label={language.t("settings.connectors.loading")}>
                <div class="settings-section-heading">
                  <div>
                    <h3>{language.t("settings.connectors.section.available")}</h3>
                  </div>
                </div>
                <div
                  class="settings-panel-loading__rows"
                  role="status"
                  aria-label={language.t("settings.connectors.loading")}
                >
                  <span />
                  <span />
                  <span />
                </div>
              </section>
            </Show>

            <Show when={entries().length > 0}>
              <section
                class="settings-section connectors-section"
                aria-label={language.t("settings.connectors.section.configured")}
              >
                <div class="settings-section-heading">
                  <div>
                    <h3>{language.t("settings.connectors.section.yours")}</h3>
                    <p>{language.t("settings.connectors.section.yours.description")}</p>
                  </div>
                  <span>{entries().length}</span>
                </div>
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
                            <span class="settings-row-logo" aria-hidden="true">
                              <Show when={identity.providerLogo} fallback={<Icon name={identity.icon} size="small" />}>
                                {(provider) => <ProviderLogo id={provider()} label={identity.label} size="small" />}
                              </Show>
                            </span>
                            <div class="connectors-copy">
                              <div class="connectors-copy__title">
                                <strong>{name}</strong>
                              </div>
                              <p title={config.type === "local" ? config.command.join(" ") : config.url}>
                                {identity.label} · {config.type === "local" ? config.command.join(" ") : config.url}
                                <Show when={detail()}>
                                  {(value) => (
                                    <>
                                      {" "}
                                      ·{" "}
                                      {language.t("settings.connectors.count.tools", {
                                        count: value().tools.length,
                                      })}{" "}
                                      ·{" "}
                                      {language.t("settings.connectors.count.resources", {
                                        count: value().resources.length,
                                      })}{" "}
                                      ·{" "}
                                      {language.t("settings.connectors.count.prompts", {
                                        count: value().prompts.length,
                                      })}
                                    </>
                                  )}
                                </Show>{" "}
                                <button
                                  type="button"
                                  class="settings-inline-link"
                                  aria-expanded={expanded() === name}
                                  aria-label={language.t(
                                    expanded() === name
                                      ? "settings.connectors.details.hide.ariaLabel"
                                      : "settings.connectors.details.show.ariaLabel",
                                    { name },
                                  )}
                                  onClick={() => toggleDetails(name)}
                                >
                                  {language.t(
                                    expanded() === name
                                      ? "settings.connectors.details.hide"
                                      : "settings.connectors.details",
                                  )}
                                </button>
                              </p>
                            </div>
                            <span class="connectors-status" data-tone={dot(s())}>
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
                                  {pendingAuthorizations()[name]
                                    ? language.t("settings.connectors.waiting")
                                    : language.t("common.connect")}
                                </button>
                              </Show>
                              <Switch
                                checked={config.enabled !== false}
                                disabled={busy(`row:${name}`)}
                                onChange={(v) => void toggle(name, v)}
                                hideLabel
                              >
                                {name}
                              </Switch>
                            </div>
                          </div>
                          <Show when={pendingAuthorizations()[name]}>
                            {(authorization) => (
                              <div class="connectors-oauth" role="status" aria-live="polite">
                                <div>
                                  <strong>{language.t("settings.connectors.oauth.waiting.title")}</strong>
                                  <span>{language.t("settings.connectors.oauth.waiting.description")}</span>
                                </div>
                                <div class="connectors-oauth__actions">
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    onClick={() => platform.openLink(authorization().authorizationUrl)}
                                  >
                                    {language.t("settings.connectors.oauth.open")}
                                  </button>
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    disabled={busy(`auth-cancel:${name}`)}
                                    onClick={() => void cancelAuthentication(name)}
                                  >
                                    {busy(`auth-cancel:${name}`)
                                      ? language.t("settings.connectors.cancelling")
                                      : language.t("common.cancel")}
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
                                    {language.t("settings.connectors.inspecting")}
                                  </div>
                                }
                              >
                                <Show
                                  when={!inspectionProblems()[name]}
                                  fallback={
                                    <div class="connectors-inspection-state" role="alert">
                                      <span>
                                        {language.t("settings.connectors.inspect.failed", {
                                          problem: inspectionProblems()[name],
                                        })}
                                      </span>
                                      <button type="button" onClick={() => void inspect(name)}>
                                        {language.t("settings.connectors.retry")}
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
                                    {language.t("settings.connectors.action.reconnect")}
                                  </button>
                                </Show>
                                <Show when={detail()?.auth === "authenticated" || detail()?.auth === "expired"}>
                                  <button
                                    type="button"
                                    class="connectors-detail-action"
                                    disabled={busy(`row:${name}`)}
                                    onClick={() => void disconnectAuth(name)}
                                  >
                                    {language.t("settings.connectors.action.disconnectOAuth")}
                                  </button>
                                </Show>
                                <button
                                  type="button"
                                  class="connectors-detail-action"
                                  disabled={busy(`row:${name}`)}
                                  onClick={() => editConnector(name, config)}
                                >
                                  {language.t("settings.connectors.action.edit")}
                                </button>
                                <button
                                  type="button"
                                  class="connectors-detail-action connectors-detail-action--danger"
                                  disabled={busy(`row:${name}`)}
                                  onClick={() => void remove(name)}
                                >
                                  {language.t("settings.connectors.action.remove")}
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
                  <Icon name="refresh" size="small" /> {language.t("settings.connectors.action.refresh")}
                </button>
              </section>
            </Show>

            <Show when={catalogEntries().length > 0}>
              <section
                class="settings-section connectors-catalog"
                aria-label={language.t("settings.connectors.section.available")}
              >
                <div class="settings-section-heading">
                  <div>
                    <h3>{language.t("settings.connectors.section.available")}</h3>
                    <p>{language.t("settings.connectors.section.available.description")}</p>
                  </div>
                  <span>{catalogEntries().length}</span>
                </div>
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
                          <span class="settings-row-logo" aria-hidden="true">
                            <ProviderLogo id={entry.id === "s3" ? "aws" : entry.id} label={entry.name} size="small" />
                          </span>
                          <div class="connectors-catalog__copy">
                            <div class="connectors-catalog__title">
                              <strong>{entry.name}</strong>
                            </div>
                            <p>
                              <span data-tag={entry.status}>
                                {language.t(
                                  entry.recommended
                                    ? "settings.connectors.tag.recommended"
                                    : "settings.connectors.tag.official",
                                )}
                              </span>{" "}
                              · {entry.summary}{" "}
                              <button
                                type="button"
                                class="settings-inline-link"
                                aria-expanded={catalogExpanded() === entry.id}
                                aria-label={language.t(
                                  catalogExpanded() === entry.id
                                    ? "settings.connectors.details.hide.ariaLabel"
                                    : "settings.connectors.details.show.ariaLabel",
                                  { name: entry.name },
                                )}
                                onClick={() =>
                                  setCatalogExpanded(catalogExpanded() === entry.id ? undefined : entry.id)
                                }
                              >
                                {language.t(
                                  catalogExpanded() === entry.id
                                    ? "settings.connectors.details.hide"
                                    : "settings.connectors.details",
                                )}
                              </button>
                            </p>
                          </div>
                          <div class="connectors-catalog__actions">
                            <button
                              type="button"
                              class="connectors-action"
                              disabled={busy(`catalog:${entry.id}`)}
                              onClick={() => void addCatalogPreset(entry)}
                            >
                              {entry.setup?.one_click_connect
                                ? busy(`catalog:${entry.id}`)
                                  ? language.t("settings.connectors.connecting")
                                  : language.t("common.connect")
                                : language.t("settings.connectors.action.setUp")}
                            </button>
                          </div>
                        </div>
                        <Show when={catalogExpanded() === entry.id}>
                          <div class="connectors-catalog__details">
                            <p>{entry.safety}</p>
                            <dl>
                              <div>
                                <dt>{language.t("settings.connectors.catalog.needs")}</dt>
                                <dd>
                                  {entry.requirements.join(" · ") ||
                                    language.t("settings.connectors.catalog.needs.none")}
                                </dd>
                              </div>
                              <div>
                                <dt>{language.t("settings.connectors.catalog.writes")}</dt>
                                <dd>
                                  {entry.upstream_write_operations.join(" · ") ||
                                    language.t("settings.connectors.catalog.writes.none")}
                                </dd>
                              </div>
                            </dl>
                            <button
                              type="button"
                              class="connectors-detail-action"
                              onClick={() => platform.openLink(entry.source_url)}
                            >
                              {language.t("settings.connectors.action.docs")}
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
              <section
                class="settings-section connectors-catalog"
                aria-label={language.t("settings.connectors.section.manual")}
              >
                <div class="settings-section-heading">
                  <div>
                    <h3>{language.t("settings.connectors.section.manual")}</h3>
                    <p>{language.t("settings.connectors.section.manual.description")}</p>
                  </div>
                </div>
                <div class="settings-card connectors-manual__list" role="list">
                  <For each={manualCatalogEntries()}>
                    {(entry) => (
                      <article class="connectors-manual__row" role="listitem">
                        <span class="settings-row-logo" aria-hidden="true">
                          <ProviderLogo id={entry.id} label={entry.name} size="small" />
                        </span>
                        <div class="connectors-catalog__copy">
                          <div class="connectors-catalog__title">
                            <strong>{entry.name}</strong>
                          </div>
                          <p>
                            {language.t("settings.connectors.tag.manual")} · {entry.summary}{" "}
                            <button
                              type="button"
                              class="settings-inline-link"
                              onClick={() => platform.openLink(entry.source_url)}
                            >
                              {language.t("settings.connectors.action.guide")}
                            </button>
                          </p>
                        </div>
                        <div class="connectors-catalog__actions">
                          <button
                            type="button"
                            class="connectors-action"
                            onClick={() => openForm(entry.id === "dropbox" ? "local" : "remote")}
                          >
                            {language.t("ui.common.add")}
                          </button>
                        </div>
                      </article>
                    )}
                  </For>
                </div>
              </section>
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
                    title={language.t("settings.connectors.empty.search.title")}
                    hint={language.t("settings.connectors.empty.search.hint")}
                  />
                }
              >
                <div class="connectors-empty">
                  <EmptyState
                    icon="mcp"
                    title={language.t("settings.connectors.empty.title")}
                    hint={language.t("settings.connectors.empty.hint")}
                  />
                  <div class="connectors-empty__actions">
                    <FormButton
                      label={language.t("settings.connectors.type.remote")}
                      onClick={() => openForm("remote")}
                    />
                    <FormButton
                      label={language.t("settings.connectors.type.local")}
                      variant="ghost"
                      onClick={() => openForm("local")}
                    />
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
  const language = useLanguage()
  const oauthOptions = createMemo(() =>
    OAUTH_OPTIONS.map((option) => ({ value: option.value, label: language.t(option.label) })),
  )
  const set = <K extends keyof ConnectorFormState>(key: K, value: ConnectorFormState[K]) =>
    props.onChange({ ...props.state, [key]: value })
  return (
    <section class="settings-section">
      <div class="settings-section-heading">
        <div>
          <h3>
            {language.t(
              props.editing
                ? "settings.connectors.form.edit"
                : props.state.type === "remote"
                  ? "settings.connectors.form.add.remote"
                  : "settings.connectors.form.add.local",
            )}
          </h3>
        </div>
      </div>
      <div class="settings-card settings-form-card connectors-form">
        <div class="connectors-form__lead">
          <strong>
            {language.t(
              props.state.type === "remote"
                ? "settings.connectors.form.remote.title"
                : "settings.connectors.form.local.title",
            )}
          </strong>
          <p>
            {language.t(
              props.state.type === "remote"
                ? "settings.connectors.form.remote.description"
                : "settings.connectors.form.local.description",
            )}
          </p>
        </div>
        <div class="connectors-form__grid">
          <div class="connectors-form__field">
            <FormField
              label={language.t("settings.connectors.form.name")}
              value={props.state.name}
              onInput={(v) => set("name", v)}
              placeholder="linear, filesystem…"
            />
          </div>
          <div class="connectors-form__field">
            <FormField
              label={language.t("settings.connectors.form.timeout")}
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
                    label={language.t("settings.connectors.form.command")}
                    value={props.state.command}
                    onInput={(v) => set("command", v)}
                    mono
                    placeholder="npx -y @modelcontextprotocol/server-filesystem ."
                  />
                </div>
                <div class="connectors-form__field" data-span="full">
                  <FormField
                    label={language.t("settings.connectors.form.env")}
                    value={props.state.env}
                    onInput={(v) => set("env", v)}
                    multiline
                    mono
                    placeholder={'{ "TOKEN": "..." }'}
                  />
                </div>
                <Show when={props.editing && props.state.env}>
                  <p class="connectors-form__hint">{language.t("settings.connectors.form.env.masked")}</p>
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
            <div class="connectors-form__field connectors-form__select">
              <span>OAuth</span>
              <Select
                aria-label="OAuth"
                options={oauthOptions()}
                current={oauthOptions().find((option) => option.value === props.state.oauth)}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && set("oauth", option.value)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
              />
            </div>
            <div class="connectors-form__field" data-span="full">
              <FormField
                label={language.t("settings.connectors.form.headers")}
                value={props.state.headers}
                onInput={(v) => set("headers", v)}
                multiline
                mono
                placeholder={'{ "Authorization": "Bearer ..." }'}
              />
            </div>
            <Show when={props.editing && props.state.headers}>
              <p class="connectors-form__hint">{language.t("settings.connectors.form.headers.masked")}</p>
            </Show>
            <Show when={props.state.oauth === "client"}>
              <div class="connectors-form__field">
                <FormField
                  label={language.t("settings.connectors.form.clientId")}
                  value={props.state.clientId}
                  onInput={(v) => set("clientId", v)}
                  mono
                />
              </div>
              <div class="connectors-form__field">
                <FormField
                  label={language.t(
                    props.state.requireClientSecret
                      ? "settings.connectors.form.clientSecret.required"
                      : "settings.connectors.form.clientSecret",
                  )}
                  value={props.state.clientSecret}
                  onInput={(v) => set("clientSecret", v)}
                  mono
                  secret
                />
              </div>
              <div class="connectors-form__field" data-span="full">
                <FormField
                  label={language.t("settings.connectors.form.scope")}
                  value={props.state.scope}
                  onInput={(v) => set("scope", v)}
                  mono
                />
              </div>
            </Show>
          </Show>
        </div>
        <div class="connectors-form__actions">
          <FormButton
            label={language.t("common.cancel")}
            variant="ghost"
            onClick={props.onCancel}
            disabled={props.busy}
          />
          <FormButton
            label={language.t(
              props.busy
                ? "settings.saving"
                : props.editing
                  ? "settings.connectors.form.save"
                  : "settings.connectors.add",
            )}
            disabled={props.busy}
            onClick={props.onSave}
          />
        </div>
        <Show when={props.state.initiallyDisabled && !props.editing}>
          <p class="connectors-form__hint">{language.t("settings.connectors.form.catalogOff")}</p>
        </Show>
      </div>
    </section>
  )
}

function rawMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function ConnectorInspection(props: { detail?: McpInspection }) {
  const language = useLanguage()
  const failures = () => {
    if (!props.detail) return []
    const status = props.detail.status.status === "failed" ? [props.detail.status.error] : []
    return [...status, ...Object.values(props.detail.errors).filter((error) => error !== undefined)]
  }
  return (
    <div class="connectors-inspection">
      <Show
        when={props.detail}
        fallback={
          <span class="connectors-inspection__loading">{language.t("settings.connectors.inspecting.connector")}</span>
        }
      >
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
                title={language.t("settings.connectors.capability.tools")}
                empty={language.t("settings.connectors.capability.tools.empty")}
                items={detail().tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                }))}
              />
              <CapabilityList
                icon="folder"
                title={language.t("settings.connectors.capability.resources")}
                empty={language.t("settings.connectors.capability.resources.empty")}
                items={detail().resources.map((resource) => ({
                  name: resource.name,
                  description: resource.description ?? resource.uri,
                }))}
              />
              <CapabilityList
                icon="speech-bubble"
                title={language.t("settings.connectors.capability.prompts")}
                empty={language.t("settings.connectors.capability.prompts.empty")}
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
