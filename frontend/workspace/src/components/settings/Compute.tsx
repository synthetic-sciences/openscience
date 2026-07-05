// Compute — where runs execute: BYOK GPU providers (Modal, TensorPool, Lambda
// Labs, Prime Intellect, Vast.ai, RunPod), your own SSH hosts, and local/remote
// model endpoints.
//
// Backend: routes/settings/compute.ts. Provider keys are encrypted at rest
// under ~/.openscience/ (AES-256-GCM, machine-local key) and never returned to the
// browser — the panel only ever sees connection state + metadata.
import { Component, For, Show, createResource, createSignal, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Select } from "@synsci/ui/select"
import { Icon } from "@synsci/ui/icon"
import { showToast } from "@synsci/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { StatusDot } from "@/thesis/shared/StatusDot"
import { settingsApi } from "./api"

interface SshHost {
  id: string
  label: string
  host: string
  user?: string
  port?: number
}
interface Endpoint {
  id: string
  label: string
  url: string
  kind: "local" | "remote"
}
interface Provider {
  id: string
  name: string
  verified: boolean
  placeholder: string
  hint: string
  connected: boolean
  connected_at: string | null
  last_used: string | null
}
interface ComputeInfo {
  providers: Provider[]
  ssh_hosts: SshHost[]
  endpoints: Endpoint[]
}

const fmtDate = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
}

const Compute: Component = () => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const fetchFn = platform.fetch ?? fetch
  const call = <T,>(path: string, init?: RequestInit) =>
    settingsApi<T>(sdk.url, fetchFn, `/settings/compute${path}`, init)

  const [info, { mutate, refetch }] = createResource(() => call<ComputeInfo>(""))

  const [busy, setBusy] = createSignal(false)
  const run = async (fn: () => Promise<ComputeInfo>, failure: string) => {
    setBusy(true)
    try {
      mutate(await fn())
    } catch (err) {
      showToast({ title: failure, description: err instanceof Error ? err.message : String(err) })
      refetch()
    }
    setBusy(false)
  }

  // ── Provider connect ──
  const [connecting, setConnecting] = createSignal<string>()
  const [keyValue, setKeyValue] = createSignal("")
  const openConnect = (id: string) => {
    setKeyValue("")
    setConnecting((v) => (v === id ? undefined : id))
  }
  const connectProvider = async (id: string) => {
    if (!keyValue().trim()) return
    await run(
      () => call<ComputeInfo>(`/provider/${id}`, { method: "POST", body: JSON.stringify({ key: keyValue().trim() }) }),
      "Failed to connect provider",
    )
    setKeyValue("")
    setConnecting(undefined)
  }
  const removeProvider = (id: string) =>
    run(() => call<ComputeInfo>(`/provider/${id}`, { method: "DELETE" }), "Failed to remove provider")

  // ── SSH host add form ──
  const [addingHost, setAddingHost] = createSignal(false)
  const [hLabel, setHLabel] = createSignal("")
  const [hHost, setHHost] = createSignal("")
  const [hUser, setHUser] = createSignal("")
  const [hPort, setHPort] = createSignal("")
  const resetHost = () => {
    setHLabel("")
    setHHost("")
    setHUser("")
    setHPort("")
    setAddingHost(false)
  }
  const saveHost = async () => {
    if (!hLabel().trim() || !hHost().trim()) return
    await run(
      () =>
        call<ComputeInfo>("/ssh", {
          method: "POST",
          body: JSON.stringify({
            label: hLabel().trim(),
            host: hHost().trim(),
            user: hUser().trim() || undefined,
            port: hPort().trim() ? Number(hPort().trim()) : undefined,
          }),
        }),
      "Failed to add SSH host",
    )
    resetHost()
  }

  // ── Endpoint add form ──
  const [addingEp, setAddingEp] = createSignal(false)
  const [epLabel, setEpLabel] = createSignal("")
  const [epUrl, setEpUrl] = createSignal("")
  const [epKind, setEpKind] = createSignal<"local" | "remote">("remote")
  const resetEp = () => {
    setEpLabel("")
    setEpUrl("")
    setEpKind("remote")
    setAddingEp(false)
  }
  const saveEp = async () => {
    if (!epLabel().trim() || !epUrl().trim()) return
    await run(
      () =>
        call<ComputeInfo>("/endpoint", {
          method: "POST",
          body: JSON.stringify({ label: epLabel().trim(), url: epUrl().trim(), kind: epKind() }),
        }),
      "Failed to add model endpoint",
    )
    resetEp()
  }

  const kindOptions: { value: "local" | "remote"; label: string }[] = [
    { value: "remote", label: "Remote" },
    { value: "local", label: "Local" },
  ]

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[820px]">
          <h2 class="text-16-medium text-text-strong">Compute</h2>
          <p class="text-13-regular text-text-weak">
            GPU providers for sandboxes and training. Add your own key to run on your account for free — or skip the key
            and provision from the Compute tab, funded by your CLI wallet.
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 px-4 pb-12 sm:px-8 max-w-[820px]">
        {/* ── GPU providers (BYOK) ── */}
        <Section title="GPU providers" subtitle="Bring your own key — connect once and work runs under your account.">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <For each={info()?.providers}>
              {(p) => (
                <ProviderCard
                  provider={p}
                  busy={busy()}
                  connecting={connecting() === p.id}
                  keyValue={keyValue()}
                  onKeyInput={setKeyValue}
                  onOpen={() => openConnect(p.id)}
                  onConnect={() => connectProvider(p.id)}
                  onRemove={() => removeProvider(p.id)}
                />
              )}
            </For>
          </div>
          <p class="text-11-regular text-text-weak/70 leading-relaxed">
            Everything is BYOK — connect a provider once and work runs under your account. Your provider bills you
            directly — we never store a key in plaintext.
            <span class="text-text-weak"> encrypted at rest · your provider, your bill · revoke anytime.</span>
          </p>
        </Section>

        {/* ── SSH hosts ── */}
        <Section
          title="SSH hosts"
          subtitle="Machines the agent can dispatch runs to over SSH."
          action={
            <Button
              size="small"
              variant="secondary"
              icon="plus-small"
              disabled={busy()}
              onClick={() => setAddingHost((v) => !v)}
            >
              add SSH host
            </Button>
          }
        >
          <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
            <Show
              when={(info()?.ssh_hosts.length ?? 0) > 0}
              fallback={<Empty when={!addingHost()} text="No SSH hosts yet." />}
            >
              <For each={info()?.ssh_hosts}>
                {(h) => (
                  <Row title={h.label} subtitle={`${h.user ? `${h.user}@` : ""}${h.host}${h.port ? `:${h.port}` : ""}`}>
                    <RemoveButton
                      disabled={busy()}
                      onClick={() =>
                        run(() => call<ComputeInfo>(`/ssh/${h.id}`, { method: "DELETE" }), "Failed to remove host")
                      }
                    />
                  </Row>
                )}
              </For>
            </Show>
            <Show when={addingHost()}>
              <div class="flex flex-col gap-3 p-4 border-t border-border-weak-base">
                <div class="grid grid-cols-2 gap-3">
                  <TextField label="Label" value={hLabel()} onInput={setHLabel} placeholder="lab-gpu-01" />
                  <TextField
                    label="Host"
                    value={hHost()}
                    onInput={setHHost}
                    placeholder="10.0.0.4 or gpu.lab.internal"
                  />
                  <TextField label="User (optional)" value={hUser()} onInput={setHUser} placeholder="ubuntu" />
                  <TextField label="Port (optional)" value={hPort()} onInput={setHPort} placeholder="22" />
                </div>
                <FormActions
                  onCancel={resetHost}
                  onSave={saveHost}
                  saveDisabled={busy() || !hLabel().trim() || !hHost().trim()}
                />
              </div>
            </Show>
          </div>
        </Section>

        {/* ── Model endpoints ── */}
        <Section
          title="Model endpoints"
          subtitle="Local or remote inference URLs the agent can route requests to."
          action={
            <Button
              size="small"
              variant="secondary"
              icon="plus-small"
              disabled={busy()}
              onClick={() => setAddingEp((v) => !v)}
            >
              add model endpoint
            </Button>
          }
        >
          <div class="border border-border-weak-base rounded-[4px] overflow-hidden bg-surface-base/40">
            <Show
              when={(info()?.endpoints.length ?? 0) > 0}
              fallback={<Empty when={!addingEp()} text="No model endpoints yet." />}
            >
              <For each={info()?.endpoints}>
                {(e) => (
                  <Row title={e.label} subtitle={`${e.kind} · ${e.url}`}>
                    <RemoveButton
                      disabled={busy()}
                      onClick={() =>
                        run(
                          () => call<ComputeInfo>(`/endpoint/${e.id}`, { method: "DELETE" }),
                          "Failed to remove endpoint",
                        )
                      }
                    />
                  </Row>
                )}
              </For>
            </Show>
            <Show when={addingEp()}>
              <div class="flex flex-col gap-3 p-4 border-t border-border-weak-base">
                <div class="grid grid-cols-2 gap-3">
                  <TextField label="Label" value={epLabel()} onInput={setEpLabel} placeholder="local-vllm" />
                  <div class="flex flex-col gap-1.5">
                    <span class="text-12-medium text-text-weak">Kind</span>
                    <Select
                      options={kindOptions}
                      current={kindOptions.find((o) => o.value === epKind())}
                      value={(o) => o.value}
                      label={(o) => o.label}
                      onSelect={(o) => o && setEpKind(o.value)}
                      variant="secondary"
                      size="small"
                      triggerVariant="settings"
                    />
                  </div>
                </div>
                <TextField label="URL" value={epUrl()} onInput={setEpUrl} placeholder="http://localhost:8000/v1" />
                <FormActions
                  onCancel={resetEp}
                  onSave={saveEp}
                  saveDisabled={busy() || !epLabel().trim() || !epUrl().trim()}
                />
              </div>
            </Show>
          </div>
        </Section>
      </div>
    </div>
  )
}

export default Compute

// ── Provider card ───────────────────────────────────────────────────────────

const ProviderCard: Component<{
  provider: Provider
  busy: boolean
  connecting: boolean
  keyValue: string
  onKeyInput: (v: string) => void
  onOpen: () => void
  onConnect: () => void
  onRemove: () => void
}> = (props) => {
  const p = () => props.provider
  return (
    <div class="flex flex-col gap-3 p-4 rounded-[4px] border border-border-weak-base bg-surface-base/40">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-2.5 min-w-0">
          <StatusDot status={p().connected ? "active" : "muted"} />
          <span class="text-14-medium text-text-strong truncate">{p().name}</span>
        </div>
        <Badge connected={p().connected} verified={p().verified} />
      </div>

      <p class="text-12-regular text-text-weak leading-relaxed min-h-[2.4em]">{p().hint}</p>

      <Show when={p().connected}>
        <div class="flex flex-col gap-0.5">
          <Show when={fmtDate(p().connected_at)}>
            {(d) => <span class="text-11-regular text-text-weak/70">Connected {d()}</span>}
          </Show>
          <span class="text-11-regular text-text-weak/70">Last used {fmtDate(p().last_used) ?? "never"}</span>
        </div>
      </Show>

      <Show when={props.connecting}>
        <div class="flex flex-col gap-2">
          <TextField
            label="API key"
            value={props.keyValue}
            onInput={props.onKeyInput}
            placeholder={p().placeholder}
            secret
          />
          <p class="text-11-regular text-text-weak/70">
            Encrypted at rest under ~/.openscience/ · never returned to the browser.
          </p>
        </div>
      </Show>

      <div class="flex items-center justify-end gap-2 mt-auto pt-1">
        <Show
          when={p().connected}
          fallback={
            <Show
              when={props.connecting}
              fallback={
                <Button size="small" variant="primary" disabled={props.busy} onClick={props.onOpen}>
                  connect
                </Button>
              }
            >
              <Button size="small" variant="ghost" disabled={props.busy} onClick={props.onOpen}>
                cancel
              </Button>
              <Button
                size="small"
                variant="primary"
                disabled={props.busy || !props.keyValue.trim()}
                onClick={props.onConnect}
              >
                connect
              </Button>
            </Show>
          }
        >
          <Show
            when={props.connecting}
            fallback={
              <>
                <Button size="small" variant="ghost" disabled={props.busy} onClick={props.onRemove}>
                  remove
                </Button>
                <Button size="small" variant="secondary" disabled={props.busy} onClick={props.onOpen}>
                  re-add key
                </Button>
              </>
            }
          >
            <Button size="small" variant="ghost" disabled={props.busy} onClick={props.onOpen}>
              cancel
            </Button>
            <Button
              size="small"
              variant="primary"
              disabled={props.busy || !props.keyValue.trim()}
              onClick={props.onConnect}
            >
              save key
            </Button>
          </Show>
        </Show>
      </div>
    </div>
  )
}

const Badge: Component<{ connected: boolean; verified: boolean }> = (props) => {
  const label = () => (props.connected ? (props.verified ? "verified" : "connected") : "not connected")
  return (
    <span
      class="flex-shrink-0 px-2 py-0.5 rounded-full text-11-regular border"
      style={{
        color: props.connected ? "var(--color-success)" : "var(--color-text-faint)",
        "border-color": props.connected
          ? "color-mix(in srgb, var(--color-success) 40%, transparent)"
          : "var(--color-border)",
        background: props.connected ? "color-mix(in srgb, var(--color-success) 12%, transparent)" : "transparent",
      }}
    >
      {label()}
    </span>
  )
}

// ── Shared building blocks ──────────────────────────────────────────────────

const Section: Component<{ title: string; subtitle: string; action?: JSX.Element; children: JSX.Element }> = (
  props,
) => (
  <div class="flex flex-col gap-3">
    <div class="flex items-end justify-between gap-4">
      <div class="flex flex-col gap-0.5">
        <h3 class="text-13-medium text-text-weak tracking-wide">{props.title}</h3>
        <p class="text-12-regular text-text-weak">{props.subtitle}</p>
      </div>
      <Show when={props.action}>{props.action}</Show>
    </div>
    {props.children}
  </div>
)

const Row: Component<{ title: string; subtitle: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5 border-b border-border-weak-base last:border-none">
    <div class="flex flex-col gap-0.5 min-w-0">
      <span class="text-14-medium text-text-strong truncate">{props.title}</span>
      <span class="text-12-regular text-text-weak truncate">{props.subtitle}</span>
    </div>
    <div class="flex-shrink-0">{props.children}</div>
  </div>
)

const Empty: Component<{ when: boolean; text: string }> = (props) => (
  <Show when={props.when}>
    <div class="px-4 py-4 text-12-regular text-text-weak">{props.text}</div>
  </Show>
)

const RemoveButton: Component<{ disabled?: boolean; onClick: () => void }> = (props) => (
  <button
    class="flex items-center justify-center size-7 rounded-xs text-icon-weak-base hover:text-text-strong hover:bg-surface-base disabled:opacity-40"
    disabled={props.disabled}
    onClick={props.onClick}
    aria-label="Remove"
  >
    <Icon name="close-small" size="small" />
  </button>
)

const FormActions: Component<{
  onCancel: () => void
  onSave: () => void
  saveLabel?: string
  saveDisabled?: boolean
}> = (props) => (
  <div class="flex items-center justify-end gap-2">
    <Button size="small" variant="ghost" onClick={props.onCancel}>
      cancel
    </Button>
    <Button size="small" variant="primary" disabled={props.saveDisabled} onClick={props.onSave}>
      {props.saveLabel ?? "add"}
    </Button>
  </div>
)

const TextField: Component<{
  label: string
  value: string
  onInput: (v: string) => void
  placeholder?: string
  secret?: boolean
}> = (props) => (
  <label class="flex flex-col gap-1.5">
    <span class="text-12-medium text-text-weak">{props.label}</span>
    <input
      class="h-9 px-3 rounded-xs border border-border-weak-base bg-surface-base/60 text-13-regular text-text-strong outline-none focus:border-border-strong-base placeholder:text-text-weak/50"
      type={props.secret ? "password" : "text"}
      value={props.value}
      placeholder={props.placeholder}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  </label>
)
