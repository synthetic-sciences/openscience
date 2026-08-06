import { For, Show, createEffect, createResource, type Component, type JSX, type Setter } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { Select } from "@synsci/ui/select"
import { Switch } from "@synsci/ui/switch"
import { showToast } from "@synsci/ui/toast"
import { useDialog } from "@synsci/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { confirmDialog } from "@/atlas/dialogs"
import { settingsApi } from "./api"

type Scheduler = "none" | "slurm" | "pbs"
type Host = {
  id: string
  label: string
  host: string
  user?: string
  port?: number
  scheduler: Scheduler
  workdir?: string
}
type Provider = {
  id: string
  connected: boolean
  enabled: boolean
  source: "stored" | "modal_toml" | null
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
    busy: undefined as string | undefined,
    probes: {} as Record<string, Probe>,
    label: "",
    host: "",
    user: "",
    port: "",
    scheduler: "none" as Scheduler,
    workdir: "",
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
  const busy = () => state.busy
  const setBusy = (value: string | undefined) => {
    setState("busy", value)
    return value
  }
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
    if (current?.tone === "error" || busy() === "modal:save") return current
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

  createEffect(() => {
    const value = data()?.modal
    if (!value) return
    setApp(value.app)
    setImage(value.image)
    setNetwork(value.network)
    setTimeout(String(value.timeout_minutes))
    setConcurrency(String(value.concurrency))
  })

  const connect = async () => {
    setBusy("modal:connect")
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
    setBusy(undefined)
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
    setBusy("modal:configure")
    setConnection({ tone: "neutral", title: "Configuring Modal…", detail: "Reading the active ~/.modal.toml profile." })
    const next = await call<Info>("/modal/configure", { method: "POST" }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: "Could not configure Modal", detail })
      showToast({ title: "Could not configure Modal", description: detail })
      return undefined
    })
    setBusy(undefined)
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
    setBusy("modal:toggle")
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
    setBusy(undefined)
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
    setBusy("modal:check")
    setConnection({ tone: "neutral", title: "Checking Modal connection…", detail: "Verifying the configured profile." })
    const result = await call<{ ok: true; sdk: string }>("/modal/check", { method: "POST" }).catch((error) => {
      const detail = message(error)
      setConnection({ tone: "error", title: "Connection check failed", detail })
      showToast({ title: "Modal connection failed", description: detail })
      return undefined
    })
    setBusy(undefined)
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
    setBusy("modal:save")
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
    setBusy(undefined)
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
    setAdding(false)
  }

  const add = async () => {
    const parsedPort = port().trim() ? Number(port()) : undefined
    if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)) {
      showToast({ title: "Invalid SSH port", description: "Use a port between 1 and 65535." })
      return
    }
    setBusy("add")
    const next = await call<Info>("/ssh", {
      method: "POST",
      body: JSON.stringify({
        label: label().trim(),
        host: host().trim(),
        user: user().trim() || undefined,
        port: parsedPort,
        scheduler: scheduler(),
        workdir: workdir().trim() || undefined,
      }),
    }).catch((error) => {
      showToast({ title: "Could not add SSH host", description: message(error) })
      return undefined
    })
    setBusy(undefined)
    if (!next) return
    control.mutate(next)
    reset()
    showToast({ variant: "success", title: "SSH host added", description: "Test the connection before dispatch." })
  }

  const test = async (item: Host) => {
    setBusy(`test:${item.id}`)
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
    setBusy(undefined)
    showToast({
      variant: result.ok ? "success" : "error",
      title: result.ok ? `${item.label} is reachable` : `Could not reach ${item.label}`,
      description: result.ok ? `${result.latency_ms} ms · ${capabilities(result)}` : result.error,
    })
  }

  const remove = async (item: Host) => {
    const confirmed = await confirmDialog(dialog, {
      title: `Remove ${item.label}?`,
      message: "This removes the saved connection profile. It does not change or delete anything on the remote host.",
      confirmLabel: "Remove host",
      danger: true,
    })
    if (!confirmed) return
    setBusy(`remove:${item.id}`)
    const next = await call<Info>(`/ssh/${item.id}`, { method: "DELETE" }).catch((error) => {
      showToast({ title: "Could not remove SSH host", description: message(error) })
      return undefined
    })
    setBusy(undefined)
    if (!next) return
    control.mutate(next)
    setProbes((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== item.id)))
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[820px]">
          <h2 class="text-16-medium text-text-strong">Compute</h2>
          <p class="text-13-regular text-text-weak">Choose where kernels and research jobs can run safely.</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 px-4 pb-12 sm:px-8 max-w-[820px]">
        <Section title="Local machine" subtitle="The default execution target for this OpenScience server.">
          <Panel>
            <Row title="This machine" subtitle="Persistent kernels and batch jobs use the active session sandbox.">
              <Badge tone="ready">available</Badge>
            </Row>
          </Panel>
        </Section>

        <Section title="Modal" subtitle="Run explicitly approved jobs in isolated Modal sandboxes using your account.">
          <Panel>
            <div class="flex flex-col gap-4 px-4 py-4">
              <div class="flex flex-wrap items-center justify-between gap-4">
                <div class="flex flex-col gap-0.5">
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
                <Show when={modal()?.connected}>
                  <Switch
                    hideLabel
                    checked={modal()?.enabled ?? false}
                    disabled={Boolean(busy())}
                    onChange={(value) => void toggle(value)}
                  >
                    Enable Modal
                  </Switch>
                </Show>
              </div>
              <Show when={connectionNotice()}>{(notice) => <NoticeBox notice={notice()} />}</Show>
              <Show when={!data.loading && !modal()?.connected && data()?.modal_file.ready}>
                <div class="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-border-weak-base bg-surface-base px-3 py-3">
                  <p class="text-12-regular text-text-weak">
                    Configure OpenScience to use this profile. Token values stay in the Modal config file.
                  </p>
                  <Button size="small" variant="primary" disabled={Boolean(busy())} onClick={() => void configure()}>
                    {busy() === "modal:configure" ? "configuring…" : "configure"}
                  </Button>
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
                      size="small"
                      variant="primary"
                      disabled={!token().trim() || !secret().trim() || Boolean(busy())}
                      onClick={() => void connect()}
                    >
                      {busy() === "modal:connect" ? "saving…" : "save token"}
                    </Button>
                  </div>
                </div>
              </Show>
              <Show when={modal()?.connected}>
                <div class="grid gap-3 sm:grid-cols-2">
                  <Field label="Modal app" value={app()} placeholder="openscience" onInput={setApp} />
                  <Field label="Default image" value={image()} placeholder="python:3.12-slim" onInput={setImage} />
                  <label class="flex flex-col gap-1.5">
                    <span class="text-12-medium text-text-strong">Network</span>
                    <select
                      aria-label="Modal network"
                      class="h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base text-13-regular text-text-strong"
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
                <div class="flex justify-end gap-2">
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={!modal()?.enabled || Boolean(busy())}
                    onClick={() => void check()}
                  >
                    {busy() === "modal:check" ? "Testing…" : "Test connection"}
                  </Button>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={!app().trim() || !image().trim() || Boolean(busy())}
                    onClick={() => void saveModal()}
                  >
                    {busy() === "modal:save" ? "Saving…" : "Save defaults"}
                  </Button>
                </div>
              </Show>
            </div>
          </Panel>
        </Section>

        <Section title="Remote compute" subtitle="Connect directly over SSH. Atlas is not required.">
          <div class="flex flex-col gap-3">
            <Show
              when={!data.loading}
              fallback={
                <Panel>
                  <Row title="Loading SSH hosts" subtitle="Reading saved compute profiles.">
                    <Badge>loading</Badge>
                  </Row>
                </Panel>
              }
            >
              <Show
                when={(data()?.ssh_hosts.length ?? 0) > 0}
                fallback={
                  <Panel>
                    <Row
                      title="No remote hosts connected"
                      subtitle="Add a plain SSH, Slurm, or PBS host, then run a real connection check."
                    >
                      <Button size="small" variant="secondary" onClick={() => setAdding(true)}>
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
                        <div class="flex flex-wrap items-center gap-4 px-4 py-3.5 border-b border-border-weak-base last:border-none">
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <span class="text-14-medium text-text-strong truncate">{item.label}</span>
                              <Badge tone={probe()?.ok ? "ready" : undefined}>
                                {probe()?.ok ? "verified now" : schedulerLabel(item.scheduler)}
                              </Badge>
                            </div>
                            <p class="text-12-regular text-text-weak mt-0.5 truncate">
                              {destination(item)}
                              {item.workdir ? ` · ${item.workdir}` : ""}
                            </p>
                            <Show when={probe()}>
                              {(result) => (
                                <p
                                  class={
                                    result().ok
                                      ? "text-11-regular text-text-success mt-1"
                                      : "text-11-regular text-text-danger mt-1"
                                  }
                                >
                                  {result().ok
                                    ? `${result().latency_ms} ms · ${capabilities(result())}`
                                    : result().error}
                                </p>
                              )}
                            </Show>
                          </div>
                          <div class="flex items-center gap-2">
                            <Button
                              size="small"
                              variant="secondary"
                              disabled={Boolean(busy())}
                              onClick={() => void test(item)}
                            >
                              {busy() === `test:${item.id}` ? "testing…" : "test"}
                            </Button>
                            <Button
                              size="small"
                              variant="ghost"
                              disabled={Boolean(busy())}
                              onClick={() => void remove(item)}
                            >
                              remove
                            </Button>
                          </div>
                        </div>
                      )
                    }}
                  </For>
                </Panel>
              </Show>
            </Show>

            <Show when={(data()?.ssh_hosts.length ?? 0) > 0 && !adding()}>
              <Button size="small" variant="secondary" onClick={() => setAdding(true)}>
                add another host
              </Button>
            </Show>

            <Show when={adding()}>
              <form
                class="grid gap-4 border border-border-weak-base rounded-[6px] bg-surface-base/40 p-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  void add()
                }}
              >
                <div>
                  <h4 class="text-14-medium text-text-strong">New SSH host</h4>
                  <p class="text-12-regular text-text-weak mt-0.5">
                    OpenScience uses your existing SSH agent and config. Private keys are never copied into the app.
                  </p>
                </div>
                <div class="grid gap-3 sm:grid-cols-2">
                  <Field label="Name" value={label()} placeholder="Lab cluster" onInput={setLabel} />
                  <Field label="Hostname" value={host()} placeholder="hpc.example.edu" onInput={setHost} />
                  <Field label="User" value={user()} placeholder="Optional" onInput={setUser} />
                  <Field label="Port" value={port()} placeholder="22" inputMode="numeric" onInput={setPort} />
                  <label class="flex flex-col gap-1.5">
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
                </div>
                <div class="flex items-center justify-end gap-2">
                  <Button size="small" variant="ghost" disabled={busy() === "add"} onClick={reset}>
                    cancel
                  </Button>
                  <Button
                    type="submit"
                    size="small"
                    variant="primary"
                    disabled={!label().trim() || !host().trim() || busy() === "add"}
                  >
                    {busy() === "add" ? "Adding…" : "Add host"}
                  </Button>
                </div>
              </form>
            </Show>
          </div>
        </Section>

        <Section title="Atlas Compute" subtitle="Managed accelerators require the separate Atlas integration.">
          <Panel>
            <Row
              title="Managed accelerators"
              subtitle="Machine, provider, price, duration, and funding will be shown before any paid run starts."
            >
              <Badge>coming later</Badge>
            </Row>
          </Panel>
        </Section>
      </div>
    </div>
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
  <label class="flex flex-col gap-1.5">
    <span class="text-12-medium text-text-strong">{props.label}</span>
    <input
      class="h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base text-13-regular text-text-strong outline-none focus:border-border-strong-base"
      value={props.value}
      placeholder={props.placeholder}
      type={props.type}
      inputMode={props.inputMode}
      onInput={(event) => props.onInput(event.currentTarget.value)}
    />
  </label>
)

const Section: Component<{ title: string; subtitle: string; children: JSX.Element }> = (props) => (
  <section class="flex flex-col gap-3">
    <div class="flex flex-col gap-0.5">
      <h3 class="text-13-medium text-text-weak tracking-wide">{props.title}</h3>
      <p class="text-12-regular text-text-weak">{props.subtitle}</p>
    </div>
    {props.children}
  </section>
)

const Panel: Component<{ children: JSX.Element }> = (props) => (
  <div class="border border-border-weak-base rounded-[6px] overflow-hidden bg-surface-base/40">{props.children}</div>
)

const NoticeBox: Component<{ notice: Notice }> = (props) => (
  <div
    role={props.notice.tone === "error" ? "alert" : "status"}
    aria-live="polite"
    class="flex items-start gap-2.5 rounded-[6px] border px-3 py-2.5"
    classList={{
      "border-border-weak-base bg-surface-base/60": props.notice.tone === "neutral",
      "border-text-success/30 bg-text-success/5": props.notice.tone === "success",
      "border-text-danger/30 bg-text-danger/5": props.notice.tone === "error",
    }}
  >
    <span
      class="mt-1 size-1.5 shrink-0 rounded-full"
      classList={{
        "bg-icon-weak-base": props.notice.tone === "neutral",
        "bg-icon-success-base": props.notice.tone === "success",
        "bg-text-danger": props.notice.tone === "error",
      }}
      aria-hidden="true"
    />
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

const Row: Component<{ title: string; subtitle: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <span class="text-12-regular text-text-weak">{props.subtitle}</span>
    </div>
    <div class="flex-shrink-0">{props.children}</div>
  </div>
)

const Badge: Component<{ tone?: "ready"; children: JSX.Element }> = (props) => (
  <span
    class={
      props.tone === "ready"
        ? "inline-flex items-center gap-1.5 text-11-medium text-text-success"
        : "inline-flex items-center rounded-[4px] px-2 py-1 text-11-medium text-text-weak bg-surface-base"
    }
  >
    {props.tone === "ready" ? <span class="size-1.5 rounded-full bg-current" aria-hidden="true" /> : undefined}
    {props.children}
  </span>
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
