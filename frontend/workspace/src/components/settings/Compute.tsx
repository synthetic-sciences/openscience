import { For, Show, createEffect, createResource, type Component, type JSX, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { Icon, type IconProps } from "@synsci/ui/icon"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { confirmDialog } from "@/atlas/dialogs"
import { settingsApi } from "./api"
import { CredentialServices } from "./CredentialServices"
import { ProviderLogo } from "./ProviderLogo"
import { PanelBody, PanelHeader, PanelScroll } from "./_shared"
import "./preference-panels.css"

type Scheduler = "none" | "slurm" | "pbs"
type Host = {
  id: string
  label: string
  host: string
  user?: string
  port?: number
  scheduler: Scheduler
  workdir?: string
  notes?: string
  fingerprint?: string
  concurrency: number
}
type Provider = {
  id: string
  connected: boolean
  enabled: boolean
  source: "stored" | "modal_toml" | null
}
type ConfigHost = {
  alias: string
  hostname?: string
  user?: string
  port?: number
}
type Modal = {
  app: string
  image: string
  network: "unrestricted" | "none"
  timeout_minutes: number
  concurrency: number
}
type Info = {
  providers: Provider[]
  ssh_hosts: Host[]
  ssh_config_hosts: ConfigHost[]
  modal: Modal
  modal_file: { found: boolean; ready: boolean }
}
type Probe = {
  ok: boolean
  host: string
  latency_ms: number
  hostname?: string
  python: boolean
  gpu: boolean
  slurm: boolean
  pbs: boolean
  fingerprint?: string
  error?: string
}
type Notice = {
  tone: "neutral" | "success" | "error"
  title: string
  detail?: string
}

const schedulers = [
  { value: "none" as const, label: "Plain SSH" },
  { value: "slurm" as const, label: "Slurm" },
  { value: "pbs" as const, label: "PBS" },
]

const Compute: Component = () => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const dialog = useDialog()
  const fetchFn = platform.fetch ?? fetch
  const call = <T,>(path = "", init?: RequestInit) => settingsApi<T>(sdk.url, fetchFn, `/settings/compute${path}`, init)
  const [data, control] = createResource(() => call<Info>())
  const [state, setState] = createStore({
    adding: false,
    busy: {} as Record<string, boolean>,
    probes: {} as Record<string, Probe>,
    label: "",
    host: "",
    user: "",
    port: "",
    scheduler: "none" as Scheduler,
    workdir: "",
    notes: "",
    sshConcurrency: "4",
    editingHost: undefined as string | undefined,
    notesDraft: "",
    token: "",
    secret: "",
    app: "",
    image: "",
    network: "none" as Modal["network"],
    timeout: "60",
    concurrency: "10",
    connection: undefined as Notice | undefined,
    defaults: undefined as Notice | undefined,
  })
  const adding = () => state.adding
  const setAdding: Setter<boolean> = (value) => setState("adding", value)
  const setBusy = (key: string, value: boolean) => {
    setState("busy", (current) => {
      const next = { ...current }
      if (value) next[key] = true
      else delete next[key]
      return next
    })
    return value
  }
  const isBusy = (key: string) => Boolean(state.busy[key])
  const hasBusyPrefix = (prefix: string) => Object.keys(state.busy).some((key) => key.startsWith(prefix))
  const modalBusy = () => hasBusyPrefix("modal:")
  const sshMutationBusy = () =>
    isBusy("ssh:add") || hasBusyPrefix("ssh:remove:") || hasBusyPrefix("ssh:update:") || hasBusyPrefix("ssh:import:")
  const hostBusy = (id: string) => isBusy(`ssh:test:${id}`) || isBusy(`ssh:remove:${id}`) || isBusy(`ssh:update:${id}`)
  const probes = () => state.probes
  const setProbes: Setter<Record<string, Probe>> = (value) => setState("probes", value)
  const label = () => state.label
  const setLabel: Setter<string> = (value) => setState("label", value)
  const host = () => state.host
  const setHost: Setter<string> = (value) => setState("host", value)
  const user = () => state.user
  const setUser: Setter<string> = (value) => setState("user", value)
  const port = () => state.port
  const setPort: Setter<string> = (value) => setState("port", value)
  const scheduler = () => state.scheduler
  const setScheduler: Setter<Scheduler> = (value) => setState("scheduler", value)
  const workdir = () => state.workdir
  const setWorkdir: Setter<string> = (value) => setState("workdir", value)
  const notes = () => state.notes
  const setNotes: Setter<string> = (value) => setState("notes", value)
  const sshConcurrency = () => state.sshConcurrency
  const setSshConcurrency: Setter<string> = (value) => setState("sshConcurrency", value)
  const editingHost = () => state.editingHost
  const notesDraft = () => state.notesDraft
  const setNotesDraft: Setter<string> = (value) => setState("notesDraft", value)
  const token = () => state.token
  const setToken: Setter<string> = (value) => setState("token", value)
  const secret = () => state.secret
  const setSecret: Setter<string> = (value) => setState("secret", value)
  const app = () => state.app
  const setApp: Setter<string> = (value) => setState("app", value)
  const image = () => state.image
  const setImage: Setter<string> = (value) => setState("image", value)
  const network = () => state.network
  const setNetwork: Setter<Modal["network"]> = (value) => setState("network", value)
  const timeout = () => state.timeout
  const setTimeout: Setter<string> = (value) => setState("timeout", value)
  const concurrency = () => state.concurrency
  const setConcurrency: Setter<string> = (value) => setState("concurrency", value)
  const connection = () => state.connection
  const setConnection = (value: Notice | undefined) => {
    setState("connection", value)
    return value
  }
  const defaults = () => state.defaults
  const setDefaults = (value: Notice | undefined) => {
    setState("defaults", value)
    return value
  }
  const modal = () => data()?.providers.find((item) => item.id === "modal")
  const configHosts = () => {
    const saved = new Set(data()?.ssh_hosts.flatMap((item) => [item.label, item.host]) ?? [])
    return (
      data()?.ssh_config_hosts.filter((item) => !saved.has(item.alias) && !saved.has(item.hostname ?? item.alias)) ?? []
    )
  }
  const dirty = () => {
    const value = data()?.modal
    if (!value) return false
    return (
      app().trim() !== value.app ||
      image().trim() !== value.image ||
      network() !== value.network ||
      timeout().trim() !== String(value.timeout_minutes) ||
      concurrency().trim() !== String(value.concurrency)
    )
  }
  const connectionNotice = (): Notice | undefined => {
    const current = connection()
    if (current) return current
    if (!modal()?.connected) return undefined
    if (!modal()?.enabled) {
      return { tone: "neutral", title: "Modal is disabled", detail: "Enable Modal to test or dispatch jobs." }
    }
    return {
      tone: "neutral",
      title: "Configured — connection not tested",
      detail: "Select Test connection to verify this profile with Modal.",
    }
  }
  const defaultsNotice = (): Notice | undefined => {
    if (!modal()?.connected) return undefined
    const current = defaults()
    if (current?.tone === "error" || isBusy("modal:save")) return current
    if (dirty()) {
      return {
        tone: "neutral",
        title: "Unsaved default changes",
        detail: "Save defaults before reviewing a new Modal job.",
      }
    }
    return (
      current ?? {
        tone: "neutral",
        title: "Defaults loaded",
        detail: "These values match the saved Modal configuration.",
      }
    )
  }

  let modalHydrated = false
  createEffect(() => {
    const value = data()?.modal
    if (!value) return
    // Refreshes from connection/toggle calls must not erase edits the user is
    // still making in the defaults form.
    if (modalHydrated && dirty()) return
    setApp(value.app)
    setImage(value.image)
    setNetwork(value.network)
    setTimeout(String(value.timeout_minutes))
    setConcurrency(String(value.concurrency))
    modalHydrated = true
  })

  const connect = async () => {
    setBusy("modal:connect", true)
    setConnection({ tone: "neutral", title: "Saving Modal token…" })
    const next = await call<Info>("/provider/modal", {
      method: "POST",
      body: JSON.stringify({ key: `${token().trim()} : ${secret().trim()}` }),
    }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: "Could not save Modal token", detail })
      showToast({ title: "Could not save Modal token", description: detail })
      return undefined
    })
    setBusy("modal:connect", false)
    if (!next) return
    control.mutate(next)
    setToken("")
    setSecret("")
    setConnection({
      tone: "success",
      title: "Modal token saved",
      detail: "Enable Modal, then test the connection before dispatching jobs.",
    })
    showToast({
      variant: "success",
      title: "Modal token saved",
      description: "Enable Modal before testing or running.",
    })
  }

  const configure = async () => {
    setBusy("modal:configure", true)
    setConnection({ tone: "neutral", title: "Configuring Modal…", detail: "Reading the active ~/.modal.toml profile." })
    const next = await call<Info>("/modal/configure", { method: "POST" }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: "Could not configure Modal", detail })
      showToast({ title: "Could not configure Modal", description: detail })
      return undefined
    })
    setBusy("modal:configure", false)
    if (!next) return
    control.mutate(next)
    setConnection({
      tone: "success",
      title: "Modal configured and enabled",
      detail: "The profile is saved. Test the connection to verify it with Modal.",
    })
    showToast({
      variant: "success",
      title: "Modal configured and enabled",
      description: "OpenScience will use the active profile in ~/.modal.toml only for approved Modal operations.",
    })
  }

  const toggle = async (enabled: boolean) => {
    setBusy("modal:toggle", true)
    setConnection({ tone: "neutral", title: enabled ? "Enabling Modal…" : "Disabling Modal…" })
    const next = await call<Info>("/provider/modal/enabled", {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: "Could not update Modal", detail })
      showToast({ title: "Could not update Modal", description: detail })
      return undefined
    })
    setBusy("modal:toggle", false)
    if (!next) return
    control.mutate(next)
    setConnection({
      tone: "success",
      title: enabled ? "Modal enabled" : "Modal disabled",
      detail: enabled
        ? "Connection not tested since enabling. Select Test connection to verify it."
        : "Credential resolution and new Modal dispatches are blocked.",
    })
  }

  const check = async () => {
    setBusy("modal:check", true)
    setConnection({ tone: "neutral", title: "Checking Modal connection…", detail: "Verifying the configured profile." })
    const result = await call<{ ok: true; sdk: string }>("/modal/check", { method: "POST" }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: "Connection check failed", detail })
      showToast({ title: "Modal connection failed", description: detail })
      return undefined
    })
    setBusy("modal:check", false)
    if (!result) return
    setConnection({
      tone: "success",
      title: "Connection verified",
      detail: `Modal accepted this profile using SDK ${result.sdk}.`,
    })
    showToast({ variant: "success", title: "Modal is ready", description: `Connected with Modal SDK ${result.sdk}.` })
  }

  const saveModal = async () => {
    const minutes = Number(timeout())
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
      setDefaults({
        tone: "error",
        title: "Defaults not saved",
        detail: "Use a whole-number timeout from 1 to 1440 minutes.",
      })
      showToast({ title: "Invalid Modal timeout", description: "Use a whole number from 1 to 1440 minutes." })
      return
    }
    const limit = Number(concurrency())
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      setDefaults({
        tone: "error",
        title: "Defaults not saved",
        detail: "Use a whole-number concurrent job limit from 1 to 100.",
      })
      showToast({ title: "Invalid Modal concurrency", description: "Use a whole number from 1 to 100." })
      return
    }
    setBusy("modal:save", true)
    setDefaults({ tone: "neutral", title: "Saving Modal defaults…" })
    const next = await call<Info>("/modal", {
      method: "PATCH",
      body: JSON.stringify({
        app: app().trim(),
        image: image().trim(),
        network: network(),
        timeout_minutes: minutes,
        concurrency: limit,
      }),
    }).catch((error) => {
      const detail = message(error)
      setDefaults({ tone: "error", title: "Defaults not saved", detail })
      showToast({ title: "Could not save Modal defaults", description: detail })
      return undefined
    })
    setBusy("modal:save", false)
    if (!next) return
    control.mutate(next)
    setDefaults({
      tone: "success",
      title: "Defaults saved",
      detail: "New Modal job reviews will use these values.",
    })
    showToast({ variant: "success", title: "Modal defaults saved" })
  }

  const reset = () => {
    setLabel("")
    setHost("")
    setUser("")
    setPort("")
    setScheduler("none")
    setWorkdir("")
    setNotes("")
    setSshConcurrency("4")
    setAdding(false)
  }

  const add = async () => {
    const parsedPort = port().trim() ? Number(port()) : undefined
    if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)) {
      showToast({ title: "Invalid SSH port", description: "Use a port between 1 and 65535." })
      return
    }
    const limit = Number(sshConcurrency())
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      showToast({ title: "Invalid SSH concurrency", description: "Use a whole number from 1 to 100." })
      return
    }
    setBusy("ssh:add", true)
    const next = await call<Info>("/ssh", {
      method: "POST",
      body: JSON.stringify({
        label: label().trim(),
        host: host().trim(),
        user: user().trim() || undefined,
        port: parsedPort,
        scheduler: scheduler(),
        workdir: workdir().trim() || undefined,
        notes: notes().trim() || undefined,
        concurrency: limit,
      }),
    }).catch((error) => {
      showToast({ title: "Could not add SSH host", description: message(error) })
      return undefined
    })
    setBusy("ssh:add", false)
    if (!next) return
    control.mutate(next)
    reset()
    showToast({ variant: "success", title: "SSH host added", description: "Test the connection before dispatch." })
  }

  const test = async (item: Host) => {
    const busyKey = `ssh:test:${item.id}`
    setBusy(busyKey, true)
    const result = await call<Probe>(`/ssh/${item.id}/test`, { method: "POST" }).catch((error) => ({
      ok: false,
      host: item.label,
      latency_ms: 0,
      python: false,
      gpu: false,
      slurm: false,
      pbs: false,
      error: message(error),
    }))
    setProbes((current) => ({ ...current, [item.id]: result }))
    setBusy(busyKey, false)
    showToast({
      variant: result.ok ? "success" : "error",
      title: result.ok ? `${item.label} is reachable` : `Could not reach ${item.label}`,
      description: result.ok ? `${result.latency_ms} ms · ${capabilities(result)}` : result.error,
    })
  }

  const importHost = async (item: ConfigHost) => {
    const busyKey = `ssh:import:${item.alias}`
    setBusy(busyKey, true)
    const next = await call<Info>("/ssh", {
      method: "POST",
      body: JSON.stringify({
        label: item.alias,
        host: item.hostname ?? item.alias,
        user: item.user,
        port: item.port,
        scheduler: "none",
        concurrency: 4,
      }),
    }).catch((error) => {
      showToast({ title: "Could not import SSH host", description: message(error) })
      return undefined
    })
    setBusy(busyKey, false)
    if (!next) return
    control.mutate(next)
    showToast({ variant: "success", title: `${item.alias} imported`, description: "Test it to pin the host key." })
  }

  const beginNotes = (item: Host) => {
    setState("editingHost", item.id)
    setNotesDraft(item.notes ?? "")
  }

  const cancelNotes = () => {
    setState("editingHost", undefined)
    setNotesDraft("")
  }

  const saveNotes = async (item: Host) => {
    const busyKey = `ssh:update:${item.id}`
    setBusy(busyKey, true)
    const next = await call<Info>(`/ssh/${item.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notes: notesDraft().trim() }),
    }).catch((error) => {
      showToast({ title: "Could not save host notes", description: message(error) })
      return undefined
    })
    setBusy(busyKey, false)
    if (!next) return
    control.mutate(next)
    cancelNotes()
    showToast({ variant: "success", title: "Host notes saved" })
  }

  const remove = async (item: Host) => {
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${item.label}?`,
      message: "This removes the saved connection profile. It does not change or delete anything on the remote host.",
      confirmLabel: "Remove host",
      danger: true,
    })
    if (!confirmed) return
    const busyKey = `ssh:remove:${item.id}`
    setBusy(busyKey, true)
    const next = await call<Info>(`/ssh/${item.id}`, { method: "DELETE" }).catch((error) => {
      showToast({ title: "Could not remove SSH host", description: message(error) })
      return undefined
    })
    setBusy(busyKey, false)
    if (!next) return
    control.mutate(next)
    setProbes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id)))
  }

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--compute">
        <PanelHeader title="Compute" description="Choose where agent-managed Python, R, shell, and batch work runs." />
        <PanelBody>
          <Section
            title="Local runtimes"
            subtitle="Persistent scientific runtimes start automatically when your work needs them."
          >
            <Panel>
              <Row
                icon="braces"
                title="Python and R kernels"
                subtitle="Session-owned kernels preserve in-memory state and appear in the workspace Compute panel."
              >
                <Badge tone="ready">Automatic</Badge>
              </Row>
              <Row
                icon="console"
                title="Shell and local jobs"
                subtitle="Commands run inside the active session sandbox and remain controllable while live."
              >
                <Badge tone="ready">Ready</Badge>
              </Row>
            </Panel>
          </Section>

          <CredentialServices
            category="compute"
            title="Cloud credentials"
            description="Connect a cloud once. Credentials stay encrypted locally and go only to the tools that need them."
          />

          <Section
            title="Modal"
            subtitle="Run explicitly approved jobs in isolated Modal sandboxes using your account."
          >
            <Panel>
              <div class="settings-compute-card" aria-busy={modalBusy() ? "true" : undefined}>
                <div class="settings-compute-provider-row">
                  <div class="flex min-w-0 flex-1 basis-[240px] items-center gap-2.5">
                    <ProviderLogo id="modal" label="Modal" connected={modal()?.connected} />
                    <div class="flex min-w-0 flex-col gap-0.5">
                      <span class="text-14-medium text-text-strong">Modal compute</span>
                      <span class="text-12-regular text-text-weak">
                        {modal()?.connected
                          ? modal()?.source === "modal_toml"
                            ? "Using the active profile in ~/.modal.toml."
                            : "Token stored locally and encrypted."
                          : data()?.modal_file.ready
                            ? "Modal CLI configuration found at ~/.modal.toml."
                            : data()?.modal_file.found
                              ? "Modal config found, but its active profile has no usable token."
                              : "Enter the token ID and secret from Modal."}
                      </span>
                    </div>
                  </div>
                  <Show when={modal()?.connected}>
                    <Switch
                      hideLabel
                      checked={modal()?.enabled ?? false}
                      disabled={modalBusy()}
                      onChange={(value) => void toggle(value)}
                    >
                      Enable Modal
                    </Switch>
                  </Show>
                </div>
                <Show when={connectionNotice()}>{(notice) => <NoticeBox notice={notice()} />}</Show>
                <Show when={!data.loading && !modal()?.connected && data()?.modal_file.ready}>
                  <div class="settings-alert flex-wrap">
                    <p class="min-w-0 flex-1 basis-[240px] text-12-regular text-text-weak">
                      Configure OpenScience to use this profile. Token values stay in the Modal config file.
                    </p>
                    <span class="ml-auto shrink-0">
                      <Button
                        class="settings-panel-action"
                        size="small"
                        variant="primary"
                        disabled={modalBusy()}
                        onClick={() => void configure()}
                      >
                        {isBusy("modal:configure") ? "Configuring…" : "Configure"}
                      </Button>
                    </span>
                  </div>
                </Show>
                <Show when={!data.loading && !modal()?.connected && !data()?.modal_file.ready}>
                  <div class="flex flex-col gap-2">
                    <div class="grid gap-3 sm:grid-cols-2">
                      <Field label="Modal token ID" value={token()} placeholder="ak-…" onInput={setToken} />
                      <Field
                        label="Modal token secret"
                        value={secret()}
                        placeholder="as-…"
                        type="password"
                        onInput={setSecret}
                      />
                    </div>
                    <div class="flex justify-end">
                      <Button
                        class="settings-panel-action"
                        size="small"
                        variant="primary"
                        disabled={!token().trim() || !secret().trim() || modalBusy()}
                        onClick={() => void connect()}
                      >
                        {isBusy("modal:connect") ? "Saving…" : "Save token"}
                      </Button>
                    </div>
                  </div>
                </Show>
                <Show when={modal()?.connected}>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <Field label="Modal app" value={app()} placeholder="openscience" onInput={setApp} />
                    <Field label="Default image" value={image()} placeholder="python:3.12-slim" onInput={setImage} />
                    <label class="flex min-w-0 flex-col gap-1.5">
                      <span class="text-12-medium text-text-strong">Network</span>
                      <select
                        aria-label="Modal network"
                        class="settings-control px-3 text-13-regular text-text-strong"
                        value={network()}
                        onChange={(event) => setNetwork(event.currentTarget.value as Modal["network"])}
                      >
                        <option value="none">Blocked</option>
                        <option value="unrestricted">Unrestricted</option>
                      </select>
                    </label>
                    <Field
                      label="Default timeout (minutes)"
                      value={timeout()}
                      placeholder="60"
                      inputMode="numeric"
                      onInput={setTimeout}
                    />
                    <Field
                      label="Concurrent jobs"
                      value={concurrency()}
                      placeholder="10"
                      inputMode="numeric"
                      onInput={setConcurrency}
                    />
                  </div>
                  <p class="text-11-regular text-text-weak">
                    Agents use this as their starting limit and may choose a different timeout for the workload. Every
                    approval card shows the final limit before dispatch.
                  </p>
                  <Show when={defaultsNotice()}>{(notice) => <NoticeBox notice={notice()} />}</Show>
                  <p class="text-11-regular text-text-weak">
                    The token is never added to agent shells. Turning Modal off prevents new credential resolution and
                    dispatch.
                  </p>
                  <div class="settings-compute-actions">
                    <Button
                      class="settings-panel-action settings-panel-action--quiet"
                      type="button"
                      size="small"
                      variant="secondary"
                      disabled={!modal()?.enabled || modalBusy()}
                      onClick={() => void check()}
                    >
                      {isBusy("modal:check") ? "Testing…" : "Test connection"}
                    </Button>
                    <Button
                      class="settings-panel-action"
                      size="small"
                      variant="primary"
                      disabled={!app().trim() || !image().trim() || modalBusy()}
                      onClick={() => void saveModal()}
                    >
                      {isBusy("modal:save") ? "Saving…" : "Save defaults"}
                    </Button>
                  </div>
                </Show>
              </div>
            </Panel>
          </Section>

          <Section
            title="Remote hosts"
            subtitle="Pin a host key, then dispatch staged jobs through your active SSH agent."
          >
            <div class="settings-compute-remote" aria-busy={hasBusyPrefix("ssh:") ? "true" : undefined}>
              <Show
                when={!data.loading}
                fallback={
                  <Panel>
                    <Row icon="server" title="Loading SSH hosts" subtitle="Reading saved compute profiles.">
                      <Badge tone="muted">Loading</Badge>
                    </Row>
                  </Panel>
                }
              >
                <Show
                  when={(data()?.ssh_hosts.length ?? 0) > 0}
                  fallback={
                    <Panel>
                      <Row
                        icon="server"
                        title="No remote hosts connected"
                        subtitle="Add a plain SSH, Slurm, or PBS host, then run a real connection check."
                      >
                        <Button
                          class="settings-panel-action settings-panel-action--quiet"
                          size="small"
                          variant="secondary"
                          disabled={sshMutationBusy()}
                          onClick={() => setAdding(true)}
                        >
                          Add host
                        </Button>
                      </Row>
                    </Panel>
                  }
                >
                  <Panel>
                    <For each={data()?.ssh_hosts}>
                      {(item) => {
                        const probe = () => probes()[item.id]
                        return (
                          <>
                            <div class="settings-row settings-compute-host-row">
                              <div class="settings-compute-host-copy">
                                <div class="settings-row-icon mt-0.5" aria-hidden="true">
                                  <Icon name="server" size="small" />
                                </div>
                                <div class="min-w-0 flex-1">
                                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                                    <span class="truncate text-14-medium text-text-strong">{item.label}</span>
                                    <Badge tone={probe()?.ok || item.fingerprint ? "ready" : "muted"}>
                                      {probe()?.ok
                                        ? "Ready to dispatch"
                                        : item.fingerprint
                                          ? "Host key pinned"
                                          : schedulerLabel(item.scheduler)}
                                    </Badge>
                                  </div>
                                  <p class="mt-0.5 truncate text-12-regular text-text-weak">
                                    {destination(item)}
                                    {item.workdir ? ` · ${item.workdir}` : ""}
                                  </p>
                                  <Show when={item.notes}>
                                    <p class="settings-compute-host-notes-copy">{item.notes}</p>
                                  </Show>
                                  <Show when={probe()}>
                                    {(result) => (
                                      <p
                                        class={
                                          result().ok
                                            ? "mt-1 text-11-regular text-text-success"
                                            : "mt-1 text-11-regular text-text-danger"
                                        }
                                      >
                                        {result().ok
                                          ? `${result().latency_ms} ms · ${capabilities(result())}`
                                          : result().error}
                                      </p>
                                    )}
                                  </Show>
                                  <Show when={item.fingerprint}>
                                    <p
                                      class="mt-1 truncate font-mono text-11-regular text-text-weak"
                                      title={item.fingerprint}
                                    >
                                      {item.fingerprint} · {item.concurrency} concurrent job
                                      {item.concurrency === 1 ? "" : "s"}
                                    </p>
                                  </Show>
                                </div>
                              </div>
                              <div class="settings-compute-host-actions">
                                <Button
                                  class="settings-panel-action settings-panel-action--quiet"
                                  size="small"
                                  variant="secondary"
                                  disabled={hostBusy(item.id) || sshMutationBusy()}
                                  onClick={() => void test(item)}
                                >
                                  {isBusy(`ssh:test:${item.id}`) ? "Testing…" : "Test"}
                                </Button>
                                <Button
                                  class="settings-panel-action settings-panel-action--quiet"
                                  size="small"
                                  variant="ghost"
                                  disabled={hostBusy(item.id) || sshMutationBusy()}
                                  onClick={() => beginNotes(item)}
                                >
                                  Edit notes
                                </Button>
                                <Button
                                  class="settings-panel-action settings-panel-action--danger-quiet"
                                  size="small"
                                  variant="ghost"
                                  disabled={hostBusy(item.id) || sshMutationBusy()}
                                  onClick={() => void remove(item)}
                                >
                                  Remove
                                </Button>
                              </div>
                            </div>
                            <Show when={editingHost() === item.id}>
                              <form
                                class="settings-compute-host-notes-editor"
                                onSubmit={(event) => {
                                  event.preventDefault()
                                  void saveNotes(item)
                                }}
                              >
                                <TextArea
                                  label="Host notes"
                                  value={notesDraft()}
                                  placeholder="Modules, partitions, scratch paths, or installation rules"
                                  onInput={setNotesDraft}
                                />
                                <p>Advisory only. Notes are shown during review and never run as commands.</p>
                                <div class="settings-inline-editor__actions">
                                  <Button
                                    class="settings-panel-action settings-panel-action--quiet"
                                    type="button"
                                    size="small"
                                    variant="ghost"
                                    disabled={isBusy(`ssh:update:${item.id}`)}
                                    onClick={cancelNotes}
                                  >
                                    Cancel
                                  </Button>
                                  <Button
                                    class="settings-panel-action"
                                    type="submit"
                                    size="small"
                                    variant="primary"
                                    disabled={isBusy(`ssh:update:${item.id}`)}
                                  >
                                    {isBusy(`ssh:update:${item.id}`) ? "Saving…" : "Save notes"}
                                  </Button>
                                </div>
                              </form>
                            </Show>
                          </>
                        )
                      }}
                    </For>
                  </Panel>
                </Show>
              </Show>

              <Show when={configHosts().length > 0}>
                <div class="settings-compute-config-import">
                  <div class="settings-compute-config-import__heading">
                    <div>
                      <h4>From ~/.ssh/config</h4>
                      <p>
                        Literal host entries only. Imports host, user, and port; Match, Include, identity files, and
                        proxy commands stay untouched.
                      </p>
                    </div>
                  </div>
                  <Panel>
                    <For each={configHosts()}>
                      {(item) => (
                        <div class="settings-row settings-compute-host-row">
                          <div class="settings-compute-host-copy">
                            <div class="settings-row-icon mt-0.5" aria-hidden="true">
                              <Icon name="server" size="small" />
                            </div>
                            <div class="min-w-0 flex-1">
                              <p class="text-13-medium text-text-strong">{item.alias}</p>
                              <p class="mt-0.5 truncate text-11-regular text-text-weak">
                                {[item.user, item.hostname ?? item.alias].filter(Boolean).join("@")}
                                {item.port ? `:${item.port}` : ""}
                              </p>
                            </div>
                          </div>
                          <div class="settings-compute-host-actions">
                            <Button
                              class="settings-panel-action settings-panel-action--quiet"
                              size="small"
                              variant="secondary"
                              disabled={sshMutationBusy() || isBusy(`ssh:import:${item.alias}`)}
                              onClick={() => void importHost(item)}
                            >
                              {isBusy(`ssh:import:${item.alias}`) ? "Importing…" : "Import"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                  </Panel>
                </div>
              </Show>

              <Show when={(data()?.ssh_hosts.length ?? 0) > 0 && !adding()}>
                <Button
                  class="settings-panel-action settings-panel-action--quiet self-start"
                  size="small"
                  variant="secondary"
                  disabled={sshMutationBusy()}
                  onClick={() => setAdding(true)}
                >
                  Add another host
                </Button>
              </Show>

              <Show when={adding()}>
                <form
                  class="settings-card settings-form-card grid gap-5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void add()
                  }}
                >
                  <div class="flex items-start gap-3">
                    <div class="settings-row-icon mt-0.5" aria-hidden="true">
                      <Icon name="server" size="small" />
                    </div>
                    <div class="min-w-0">
                      <h4 class="text-14-medium text-text-strong">New SSH host</h4>
                      <p class="mt-0.5 text-12-regular text-text-weak">
                        OpenScience uses your active SSH agent, pins the tested host key, and never copies private keys.
                      </p>
                    </div>
                  </div>
                  <div class="grid gap-3 sm:grid-cols-2">
                    <Field label="Name" value={label()} placeholder="Lab cluster" onInput={setLabel} />
                    <Field label="Hostname" value={host()} placeholder="hpc.example.edu" onInput={setHost} />
                    <Field label="User" value={user()} placeholder="Optional" onInput={setUser} />
                    <Field label="Port" value={port()} placeholder="22" inputMode="numeric" onInput={setPort} />
                    <label class="flex min-w-0 flex-col gap-1.5">
                      <span class="text-12-medium text-text-strong">Scheduler</span>
                      <Select
                        aria-label="Scheduler"
                        options={schedulers}
                        current={schedulers.find((item) => item.value === scheduler())}
                        value={(item) => item.value}
                        label={(item) => item.label}
                        onSelect={(item) => item && setScheduler(item.value)}
                        variant="secondary"
                        size="small"
                        triggerVariant="settings"
                      />
                    </label>
                    <Field
                      label="Remote working directory"
                      value={workdir()}
                      placeholder="~/research"
                      onInput={setWorkdir}
                    />
                    <Field
                      label="Concurrent jobs"
                      value={sshConcurrency()}
                      placeholder="4"
                      inputMode="numeric"
                      onInput={setSshConcurrency}
                    />
                    <div class="sm:col-span-2">
                      <TextArea
                        label="Host notes"
                        value={notes()}
                        placeholder="Modules, partitions, scratch paths, or installation rules"
                        onInput={setNotes}
                      />
                    </div>
                  </div>
                  <div class="settings-compute-actions">
                    <Button
                      class="settings-panel-action settings-panel-action--quiet"
                      type="button"
                      size="small"
                      variant="ghost"
                      disabled={isBusy("ssh:add")}
                      onClick={reset}
                    >
                      Cancel
                    </Button>
                    <Button
                      class="settings-panel-action"
                      type="submit"
                      size="small"
                      variant="primary"
                      disabled={!label().trim() || !host().trim() || sshMutationBusy()}
                    >
                      {isBusy("ssh:add") ? "Adding…" : "Add host"}
                    </Button>
                  </div>
                </form>
              </Show>
            </div>
          </Section>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

export default Compute

const Field: Component<{
  label: string
  value: string
  placeholder: string
  type?: JSX.InputHTMLAttributes<HTMLInputElement>["type"]
  inputMode?: JSX.InputHTMLAttributes<HTMLInputElement>["inputMode"]
  onInput: (value: string) => void
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1.5">
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <input
      class="settings-field"
      value={props.value}
      placeholder={props.placeholder}
      type={props.type}
      inputMode={props.inputMode}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)

const TextArea: Component<{
  label: string
  value: string
  placeholder: string
  onInput: (value: string) => void
}> = (props) => (
  <label class="flex min-w-0 flex-col gap-1.5">
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <textarea
      class="settings-field settings-compute-notes-field"
      value={props.value}
      placeholder={props.placeholder}
      maxlength={4_000}
      rows={3}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)

const Section: Component<{ title: string; subtitle: string; children: JSX.Element }> = (props) => (
  <section class="settings-section">
    <div class="settings-section-heading">
      <div>
        <h3>{props.title}</h3>
        <p>{props.subtitle}</p>
      </div>
    </div>
    {props.children}
  </section>
)

const Panel: Component<{ children: JSX.Element }> = (props) => <div class="settings-card">{props.children}</div>

const NoticeBox: Component<{ notice: Notice }> = (props) => (
  <div
    role={props.notice.tone === "error" ? "alert" : "status"}
    aria-live="polite"
    class="settings-alert !items-start"
    data-tone={props.notice.tone === "error" ? "critical" : undefined}
    classList={{
      "text-text-success": props.notice.tone === "success",
    }}
  >
    <Show when={props.notice.tone !== "neutral"}>
      <div class="settings-alert__icon" aria-hidden="true">
        <Icon name={props.notice.tone === "success" ? "circle-check" : "alert-circle"} size="small" />
      </div>
    </Show>
    <div class="min-w-0">
      <p
        class="text-12-medium"
        classList={{
          "text-text-strong": props.notice.tone === "neutral",
          "text-text-success": props.notice.tone === "success",
          "text-text-danger": props.notice.tone === "error",
        }}
      >
        {props.notice.title}
      </p>
      <Show when={props.notice.detail}>
        <p class="mt-0.5 text-11-regular text-text-weak">{props.notice.detail}</p>
      </Show>
    </div>
  </div>
)

const Row: Component<{ icon: IconProps["name"]; title: string; subtitle: string; children: JSX.Element }> = (props) => (
  <div class="settings-row settings-compute-summary-row">
    <div class="flex min-w-0 flex-1 basis-[220px] items-center gap-3">
      <div class="settings-row-icon" aria-hidden="true">
        <Icon name={props.icon} size="small" />
      </div>
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.subtitle}</span>
      </div>
    </div>
    <div class="settings-compute-summary-action">{props.children}</div>
  </div>
)

const Badge: Component<{ tone: "ready" | "muted"; children: JSX.Element }> = (props) => (
  <div class="settings-status" data-tone={props.tone}>
    <Show when={props.tone === "ready"}>
      <span class="settings-status__dot" aria-hidden="true" />
    </Show>
    {props.children}
  </div>
)

function destination(host: Host) {
  const login = host.user ? `${host.user}@${host.host}` : host.host
  return host.port ? `${login}:${host.port}` : login
}

function schedulerLabel(scheduler: Scheduler) {
  if (scheduler === "slurm") return "Slurm"
  if (scheduler === "pbs") return "PBS"
  return "SSH"
}

function capabilities(probe: Probe) {
  const values = [
    probe.hostname,
    probe.python ? "Python" : undefined,
    probe.gpu ? "GPU" : undefined,
    probe.slurm ? "Slurm" : undefined,
    probe.pbs ? "PBS" : undefined,
  ]
  return values.filter((value): value is string => Boolean(value)).join(" · ") || "SSH ready"
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
