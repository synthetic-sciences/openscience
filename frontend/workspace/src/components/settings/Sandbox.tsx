// Execution sandbox settings — the permission system decides *whether* the agent
// runs a shell command; it is not an isolation boundary. This panel turns on a
// real one: native containment that confines reads and writes to granted paths
// and denies network egress. The server
// (routes/settings/sandbox.ts) reports backend availability, persists the
// config, and runs the empirical self-test the browser can't. Mirrors the
// `openscience sandbox` CLI.
import { Component, For, Show, createResource, createSignal, createUniqueId } from "solid-js"
import { Select } from "@synsci/ui/select"
import { Button } from "@synsci/ui/button"
import { Switch } from "@synsci/ui/switch"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import "./preference-panels.css"
import "./sandbox.css"

interface SandboxConfig {
  enabled?: boolean
  network?: "allow" | "deny"
  allowWrite?: string[]
  onUnavailable?: "warn" | "error" | "allow"
  requireProjectTrust?: boolean
}
interface Status {
  platform: string
  backend: "seatbelt" | "bubblewrap" | "none"
  available: boolean
  readIsolation?: "grant_only" | "unavailable"
  networkIsolation?: "deny_all" | "unavailable"
  tool?: string
  reason?: string
}
interface Payload {
  config: SandboxConfig
  status: Status
}
interface Check {
  name: string
  pass: boolean
  skipped?: boolean
  detail?: string
}
interface SelfTest {
  backend: string
  available: boolean
  checks: Check[]
  ok: boolean
}

type WriteKey = "enabled" | "trust" | "network" | "fallback" | "paths"
type PendingWrite = { body: SandboxConfig; key: WriteKey; failure: string }

const NETWORK_OPTS = [
  { value: "allow" as const, label: "Allow" },
  { value: "deny" as const, label: "Deny" },
]
const UNAVAILABLE_OPTS = [
  { value: "warn" as const, label: "Warn & run" },
  { value: "error" as const, label: "Refuse" },
  { value: "allow" as const, label: "Run silently" },
]

const Sandbox: Component = () => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const call = <T,>(path: string, init?: RequestInit) =>
    settingsApi<T>(sdk.url, fetchFn, `/settings/sandbox${path}`, init)

  const [data, { mutate, refetch }] = createResource(() => call<Payload>(""))
  const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<WriteKey>>(new Set())
  const [saving, setSaving] = createSignal(false)
  const [test, setTest] = createSignal<SelfTest>()
  const [testing, setTesting] = createSignal(false)
  const [newPath, setNewPath] = createSignal("")
  const [showBackendDetails, setShowBackendDetails] = createSignal(false)
  const [showPathEditor, setShowPathEditor] = createSignal(false)
  const [showTestDetails, setShowTestDetails] = createSignal(false)
  const backendDetailsId = `sandbox-backend-${createUniqueId()}`
  const pathEditorId = `sandbox-path-${createUniqueId()}`
  const testDetailsId = `sandbox-test-${createUniqueId()}`
  const writeQueue: PendingWrite[] = []
  let writeLoop: Promise<void> | undefined

  const config = (): SandboxConfig =>
    data()?.config ?? {
      enabled: true,
      network: "deny",
      allowWrite: [],
      onUnavailable: "error",
      requireProjectTrust: false,
    }
  const status = () => data()?.status
  const unavailable = () => data.loading || !!data.error
  const busy = (key: WriteKey) => busyKeys().has(key)
  const setKeyBusy = (key: WriteKey, value: boolean) => {
    setBusyKeys((current) => {
      const next = new Set(current)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })
  }
  // Older running servers may omit the two explicit capability fields while
  // still reporting a supported native backend. Seatbelt and bubblewrap have
  // fixed grant-only / deny-all semantics, so keep the UI truthful across the
  // rolling frontend/backend upgrade instead of labelling an active backend
  // unavailable or presenting its forced Deny policy as configurable.
  const nativeBackendActive = () => {
    const current = status()
    return !!current?.available && (current.backend === "seatbelt" || current.backend === "bubblewrap")
  }
  const grantOnlyEnforced = () => {
    const capability = status()?.readIsolation
    return capability === "grant_only" || (capability === undefined && nativeBackendActive())
  }
  const networkDenyEnforced = () => {
    const capability = status()?.networkIsolation
    return capability === "deny_all" || (capability === undefined && nativeBackendActive())
  }
  const effectiveNetwork = () => (networkDenyEnforced() ? "deny" : (config().network ?? "deny"))
  const pendingConfig = (base: SandboxConfig) =>
    writeQueue.reduce((current, item) => ({ ...current, ...item.body }), base)

  const drainWrites = async () => {
    setSaving(true)
    while (writeQueue.length > 0) {
      const item = writeQueue.shift()!
      try {
        const confirmed = await call<Payload>("", { method: "PUT", body: JSON.stringify(item.body) })
        // The response confirms this write. Re-apply later optimistic edits so
        // an older response never makes another control appear to jump back.
        mutate({ ...confirmed, config: pendingConfig(confirmed.config) })
      } catch (err) {
        const abandoned = writeQueue.splice(0)
        for (const pending of abandoned) setKeyBusy(pending.key, false)
        showToast({ title: item.failure, description: err instanceof Error ? err.message : String(err) })
        void refetch()
        break
      } finally {
        setKeyBusy(item.key, false)
      }
    }
    setSaving(false)
    writeLoop = undefined
  }

  const patch = (body: SandboxConfig, key: WriteKey, failure: string) => {
    if (unavailable() || busy(key)) return
    const current = data()
    if (!current) return

    // Apply feedback immediately, but serialize server writes. Other controls
    // remain usable; only the preference being committed is temporarily held.
    mutate({ ...current, config: { ...current.config, ...body } })
    setKeyBusy(key, true)
    writeQueue.push({ body, key, failure })
    writeLoop ??= drainWrites()
  }

  const runTest = async () => {
    if (testing()) return
    setTesting(true)
    try {
      setTest(await call<SelfTest>("/test", { method: "POST" }))
    } catch (err) {
      showToast({ title: "Self-test failed to run", description: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const addPath = () => {
    const p = newPath().trim()
    if (!p) return
    if (!p.startsWith("/")) {
      showToast({ title: "Use an absolute path", description: "Extra writable paths must start with /." })
      return
    }
    const next = [...(config().allowWrite ?? [])]
    if (!next.includes(p)) next.push(p)
    setNewPath("")
    setShowPathEditor(false)
    patch({ allowWrite: next }, "paths", "Couldn't add the path")
  }
  const removePath = (p: string) =>
    patch({ allowWrite: (config().allowWrite ?? []).filter((x) => x !== p) }, "paths", "Couldn't remove the path")

  return (
    <PanelScroll>
      <div
        class="settings-preferences-panel settings-preferences-panel--sandbox"
        aria-busy={saving() ? "true" : undefined}
      >
        <PanelHeader
          title="Sandbox"
          description="Isolate local terminals, kernels, and shell commands."
          toolbar={
            <span class="settings-sandbox-save-state" role="status" aria-live="polite">
              {saving() ? "Saving…" : ""}
            </span>
          }
        />
        <PanelBody>
          <Show when={data.error}>
            <div class="settings-alert" data-tone="critical" role="alert">
              <span>Sandbox settings could not be loaded. {String(data.error)}</span>
              <button
                type="button"
                class="settings-inline-action"
                disabled={data.loading || saving()}
                onClick={() => void refetch()}
              >
                Retry
              </button>
            </div>
          </Show>
          <Show
            when={!data.loading && !data.error}
            fallback={
              <Show when={data.loading}>
                <div class="settings-panel-loading__rows" role="status" aria-label="Loading sandbox settings">
                  <span />
                  <span />
                  <span />
                </div>
              </Show>
            }
          >
            <Section
              title="Protection"
              description="Permissions approve a command; the sandbox limits what it can reach."
            >
              <div class="settings-card settings-preferences-card">
                <div class="settings-row settings-sandbox-control-row settings-sandbox-enable-row">
                  <div class="settings-row-copy">
                    <strong>Sandbox agent commands</strong>
                    <span>
                      {config().enabled !== false
                        ? "On — reads and writes stay within the workspace and approved paths."
                        : "Off — trusted projects may run with your full user authority; untrusted projects remain blocked."}
                    </span>
                  </div>
                  <Switch
                    hideLabel
                    checked={config().enabled !== false}
                    disabled={busy("enabled") || unavailable()}
                    onChange={(checked) =>
                      patch({ enabled: checked }, "enabled", "Couldn't update the sandbox setting")
                    }
                  >
                    Sandbox agent commands
                  </Switch>
                </div>
                <Show
                  when={status()}
                  fallback={<div class="settings-panel-loading-copy">Checking native containment…</div>}
                >
                  {(s) => (
                    <>
                      <button
                        type="button"
                        class="settings-row settings-sandbox-status-row"
                        aria-expanded={showBackendDetails()}
                        aria-controls={backendDetailsId}
                        onClick={() => setShowBackendDetails((value) => !value)}
                      >
                        <span
                          class="settings-sandbox-status-mark"
                          data-tone={s().available ? "success" : "warning"}
                          aria-hidden="true"
                        >
                          <Icon name={s().available ? "check" : "stop"} size="small" />
                        </span>
                        <span class="settings-row-copy">
                          <strong>{s().available ? "Native containment available" : "Sandbox unavailable"}</strong>
                          <span>
                            {s().available
                              ? `${s().backend} on ${s().platform}`
                              : `No supported backend on ${s().platform}`}
                          </span>
                        </span>
                        <span class="settings-preference-status" data-tone={s().available ? "success" : "warning"}>
                          {s().available ? "Available" : "Unavailable"}
                        </span>
                        <Icon
                          name="chevron-down"
                          size="small"
                          class="settings-sandbox-disclosure-icon"
                          classList={{ "settings-sandbox-disclosure-icon--open": showBackendDetails() }}
                        />
                      </button>
                      <Show when={showBackendDetails()}>
                        <div id={backendDetailsId} class="settings-sandbox-backend-details">
                          <dl>
                            <div>
                              <dt>Backend</dt>
                              <dd>{s().backend}</dd>
                            </div>
                            <div>
                              <dt>Platform</dt>
                              <dd>{s().platform}</dd>
                            </div>
                            <div>
                              <dt>Tool</dt>
                              <dd>{s().tool ?? "Not available"}</dd>
                            </div>
                            <div>
                              <dt>File access</dt>
                              <dd>
                                {grantOnlyEnforced()
                                  ? "Reads and writes are limited to the workspace and approved paths."
                                  : "Grant-only read isolation is unavailable."}
                              </dd>
                            </div>
                            <div>
                              <dt>Network</dt>
                              <dd>
                                {networkDenyEnforced()
                                  ? "All network access is denied."
                                  : "Network isolation is unavailable."}
                              </dd>
                            </div>
                            <Show when={s().reason}>
                              <div>
                                <dt>Reason</dt>
                                <dd>{s().reason}</dd>
                              </div>
                            </Show>
                          </dl>
                        </div>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
            </Section>

            <Show when={config().enabled !== false}>
              <Section
                title="Policy"
                description="Choose the default autonomy and containment policy for local commands."
              >
                <div class="settings-card settings-preferences-card">
                  <div class="settings-row settings-sandbox-control-row">
                    <div class="settings-row-copy">
                      <strong>Require project trust</strong>
                      <span>
                        {config().requireProjectTrust === true
                          ? "Every project must be trusted before it can start terminals, kernels, or local jobs."
                          : "Sandboxed terminals, kernels, and local jobs can run immediately. Remote jobs, kernel environment changes, project extensions, and unsandboxed execution still require trust."}
                      </span>
                    </div>
                    <Switch
                      hideLabel
                      checked={config().requireProjectTrust === true}
                      disabled={busy("trust") || unavailable()}
                      onChange={(checked) =>
                        patch({ requireProjectTrust: checked }, "trust", "Couldn't update the project trust policy")
                      }
                    >
                      Require project trust
                    </Switch>
                  </div>

                  <div class="settings-row settings-sandbox-control-row">
                    <div class="settings-row-copy">
                      <strong>Network access</strong>
                      <span>
                        {networkDenyEnforced()
                          ? "This backend always denies network access, including loopback, LAN, link-local, and metadata endpoints."
                          : "Allow permits outbound network access while loopback remains blocked."}
                      </span>
                    </div>
                    <Select
                      options={NETWORK_OPTS}
                      current={NETWORK_OPTS.find((o) => o.value === effectiveNetwork())}
                      value={(o) => o.value}
                      label={(o) => o.label}
                      disabled={busy("network") || unavailable() || networkDenyEnforced()}
                      onSelect={(o) => o && patch({ network: o.value }, "network", "Couldn't update network policy")}
                      variant="secondary"
                      size="small"
                      triggerVariant="settings"
                    />
                  </div>

                  <div class="settings-row settings-sandbox-control-row">
                    <div class="settings-row-copy">
                      <strong>Fallback behavior</strong>
                      <span>Choose what happens if filesystem isolation cannot start.</span>
                    </div>
                    <Select
                      options={UNAVAILABLE_OPTS}
                      current={UNAVAILABLE_OPTS.find((o) => o.value === (config().onUnavailable ?? "error"))}
                      value={(o) => o.value}
                      label={(o) => o.label}
                      disabled={busy("fallback") || unavailable()}
                      onSelect={(o) =>
                        o && patch({ onUnavailable: o.value }, "fallback", "Couldn't update fallback behavior")
                      }
                      variant="secondary"
                      size="small"
                      triggerVariant="settings"
                    />
                  </div>
                </div>
              </Section>

              <Section
                title="Extra writable paths"
                count={(config().allowWrite ?? []).length}
                description="Absolute paths outside the workspace and temporary directories that the sandbox may modify."
              >
                <div class="settings-card settings-preferences-card">
                  <Show
                    when={(config().allowWrite ?? []).length > 0}
                    fallback={
                      <div class="settings-row settings-sandbox-control-row settings-sandbox-empty-paths">
                        <div class="settings-row-copy">
                          <strong>Workspace only</strong>
                          <span>No extra writable paths are approved.</span>
                        </div>
                        <button
                          type="button"
                          class="settings-preference-action"
                          aria-expanded={showPathEditor()}
                          aria-controls={pathEditorId}
                          disabled={busy("paths") || unavailable()}
                          onClick={() => setShowPathEditor((value) => !value)}
                        >
                          {showPathEditor() ? "Cancel" : "Add path"}
                        </button>
                      </div>
                    }
                  >
                    <For each={config().allowWrite ?? []}>
                      {(p) => (
                        <div class="settings-row settings-sandbox-path-row">
                          <code title={p}>{p}</code>
                          <button
                            type="button"
                            class="settings-preference-action"
                            data-variant="danger"
                            disabled={busy("paths")}
                            aria-label={`Remove writable path ${p}`}
                            onClick={() => removePath(p)}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show when={showPathEditor() || (config().allowWrite ?? []).length > 0}>
                    <div id={pathEditorId} class="settings-sandbox-path-editor">
                      <input
                        class="settings-field"
                        aria-label="Add writable path"
                        placeholder="/absolute/path"
                        value={newPath()}
                        disabled={busy("paths") || unavailable()}
                        onInput={(e) => setNewPath(e.currentTarget.value)}
                        onKeyDown={(e) => e.key === "Enter" && addPath()}
                      />
                      <Button
                        class="settings-panel-action settings-panel-action--quiet"
                        size="small"
                        variant="secondary"
                        disabled={busy("paths") || unavailable() || !newPath().trim()}
                        onClick={addPath}
                      >
                        Add
                      </Button>
                    </div>
                  </Show>
                </div>
              </Section>

              <Section
                title="Containment test"
                description="Run real sandboxed commands to verify the boundaries this backend claims to enforce."
              >
                <div class="settings-card settings-preferences-card">
                  <div class="settings-row settings-sandbox-control-row settings-sandbox-test-row">
                    <div class="settings-row-copy">
                      <strong>Verify containment</strong>
                      <span>
                        Tests read and write boundaries plus effective network isolation with real sandboxed commands.
                      </span>
                    </div>
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={testing() || unavailable() || !status()?.available}
                      onClick={runTest}
                    >
                      {testing() ? "Testing…" : "Run self-test"}
                    </Button>
                  </div>
                  <Show when={test()}>
                    {(t) => (
                      <div class="settings-sandbox-result" aria-live="polite">
                        <div class="settings-sandbox-result__summary" role="status">
                          <span class="settings-sandbox-result__dot" data-tone={t().ok ? "success" : "danger"} />
                          <span classList={{ "text-text-success": t().ok, "text-text-danger": !t().ok }}>
                            {t().ok ? "Containment verified." : "Containment failed — do not rely on the sandbox."}
                          </span>
                          <button
                            type="button"
                            class="settings-preference-action"
                            data-variant="quiet"
                            aria-expanded={showTestDetails()}
                            aria-controls={testDetailsId}
                            onClick={() => setShowTestDetails((value) => !value)}
                          >
                            {showTestDetails() ? "Hide checks" : `Show ${t().checks.length} checks`}
                          </button>
                        </div>
                        <Show when={showTestDetails()}>
                          <div id={testDetailsId} class="settings-sandbox-checks">
                            <For each={t().checks}>
                              {(c) => (
                                <div class="settings-sandbox-check">
                                  <Icon
                                    name={c.skipped ? "dash" : c.pass ? "check" : "close"}
                                    class={
                                      c.skipped ? "text-text-weak" : c.pass ? "text-text-success" : "text-text-danger"
                                    }
                                    size="small"
                                  />
                                  <span>{c.name}</span>
                                  <Show when={c.detail}>
                                    <code class="settings-sandbox-check__detail">{c.detail}</code>
                                  </Show>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </div>
                    )}
                  </Show>
                </div>
              </Section>
            </Show>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

export default Sandbox
