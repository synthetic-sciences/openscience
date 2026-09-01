// Storage — real on-disk footprint of the OpenScience data directory.
// Backed by /settings/storage (routes/settings/storage.ts).
import { type Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Icon } from "@synsci/ui/icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { settingsApi } from "./api"
import { PanelBody, PanelHeader, PanelScroll, Section } from "./_shared"
import "./preference-panels.css"

type Entry = { name: string; path: string; bytes: number; kind: "dir" | "file" }
type Relocation = {
  id?: string
  phase: "copying" | "ready" | "publishing" | "published" | "switched" | "recovery_required"
  source?: string
  target?: string
  started_at?: string
  updated_at?: string
  active?: boolean
  error?: string
}
type Usage = {
  data_dir: string
  managed: boolean
  config_dir: string
  cache_dir: string
  state_dir: string
  pointer: string | null
  total_bytes: number
  cache_bytes: number
  entries: Entry[]
  scanning?: boolean
  updated_at?: string | null
  scan_error?: string | null
  relocation?: Relocation | null
}

function fmt(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function storageUsagePath(refresh = false) {
  return refresh ? "/settings/storage?refresh=1" : "/settings/storage"
}

export async function storageLocationChoice(open: () => Promise<string | string[] | null>) {
  return Promise.resolve()
    .then(open)
    .then(
      (picked) => {
        const path = Array.isArray(picked) ? picked[0] : picked
        if (!path) return { kind: "cancelled" as const }
        return { kind: "selected" as const, path }
      },
      (error) => ({
        kind: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
}

export function storageRelocationCopy(value: Relocation) {
  if (value.phase === "recovery_required") {
    return {
      title: "Storage move needs attention",
      detail: value.error ?? "OpenScience could not safely read the recovery record.",
      tone: "critical" as const,
    }
  }
  if (!value.active) {
    return {
      title: "Storage move was interrupted",
      detail: "Your current data is still protected. Resume to recover the verified transaction safely.",
      tone: "warning" as const,
    }
  }
  if (value.phase === "copying") {
    return {
      title: "Copying and verifying data",
      detail: "The current location remains active until the verified copy is ready.",
      tone: "neutral" as const,
    }
  }
  if (value.phase === "ready" || value.phase === "publishing") {
    return {
      title: "Preparing the verified copy",
      detail: "The current location remains active while the destination is committed.",
      tone: "neutral" as const,
    }
  }
  if (value.phase === "published") {
    return {
      title: "Switching storage location",
      detail: "The verified destination is ready. OpenScience is switching running servers together.",
      tone: "neutral" as const,
    }
  }
  return {
    title: "Finalizing storage location",
    detail: "The new location is active. OpenScience is finishing recovery metadata.",
    tone: "neutral" as const,
  }
}

export const Storage: Component = () => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()

  const base = () => sdk.url
  const fetchFn = () => platform.fetch ?? fetch

  const [usage, setUsage] = createSignal<Usage>()
  const [error, setError] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [clearing, setClearing] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [target, setTarget] = createSignal("")
  const [status, setStatus] = createSignal<string>()
  const [picker, setPicker] = createSignal<string>()

  let poll: ReturnType<typeof setTimeout> | undefined
  let request = 0
  let disposed = false
  const schedulePoll = (next: Usage) => {
    if (poll) clearTimeout(poll)
    poll = next.scanning || busy() || clearing() ? setTimeout(() => void load({ background: true }), 750) : undefined
  }
  const load = async (options: { background?: boolean; refresh?: boolean } = {}) => {
    const id = ++request
    const background = options.background ?? false
    if (!background) setLoading(true)
    if (!background) setError(undefined)
    try {
      const next = await settingsApi<Usage>(base(), fetchFn(), storageUsagePath(options.refresh))
      if (disposed || id !== request) return
      setUsage(next)
      schedulePoll(next)
    } catch (err) {
      if (disposed || id !== request) return
      const message = err instanceof Error ? err.message : String(err)
      if (background && usage()) {
        setUsage((current) => (current ? { ...current, scanning: false, scan_error: message } : current))
      } else {
        setError(message)
      }
    } finally {
      if (!disposed && id === request && !background) setLoading(false)
    }
  }
  const retry = () => load({ background: Boolean(usage()), refresh: true })
  onMount(() => void load())
  onCleanup(() => {
    disposed = true
    request += 1
    if (poll) clearTimeout(poll)
  })

  const chooseLocation = async () => {
    if (busy()) return
    setEditing(true)
    setError(undefined)
    setStatus(undefined)
    setPicker(undefined)
    if (!platform.openDirectoryPickerDialog) return
    const choice = await storageLocationChoice(() =>
      platform.openDirectoryPickerDialog!({ title: "Choose a new OpenScience data location", serverUrl: sdk.url }),
    )
    if (choice.kind === "error") {
      setPicker(`The system folder picker could not open. ${choice.message} Enter a path manually below.`)
      return
    }
    if (choice.kind === "selected") setTarget(choice.path)
  }

  const relocate = async (requested?: string) => {
    const next = (requested ?? target()).trim()
    if (!next || busy()) return
    setBusy(true)
    void load({ background: true })
    setError(undefined)
    setStatus(undefined)
    setPicker(undefined)
    try {
      const result = await settingsApi<{ ok: true; target: string; files: number; bytes: number; warning?: string }>(
        base(),
        fetchFn(),
        "/settings/storage/location",
        { method: "POST", body: JSON.stringify({ path: next }) },
      )
      setEditing(false)
      setTarget("")
      setStatus(
        `Moved ${fmt(result.bytes)} across ${result.files} files. Every running OpenScience server now uses ${result.target}.${result.warning ? ` ${result.warning}` : ""}`,
      )
      await load({ refresh: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resetLocation = async () => {
    if (busy()) return
    setBusy(true)
    void load({ background: true })
    setError(undefined)
    setStatus(undefined)
    try {
      const result = await settingsApi<{ ok: true; target: string; backup?: string; warning?: string }>(
        base(),
        fetchFn(),
        "/settings/storage/location",
        { method: "DELETE" },
      )
      setStatus(
        (result.backup
          ? `Returned to ${result.target}. The previous default directory is preserved at ${result.backup}.`
          : `Returned to ${result.target}.`) + (result.warning ? ` ${result.warning}` : ""),
      )
      await load({ refresh: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clearCache = async () => {
    if (clearing()) return
    setClearing(true)
    setError(undefined)
    setStatus(undefined)
    try {
      const result = await settingsApi<{ ok: true; entries: number }>(base(), fetchFn(), "/settings/storage/cache", {
        method: "DELETE",
      })
      setStatus(result.entries === 1 ? "Local cache cleared." : `Local cache cleared (${result.entries} entries).`)
      await load({ refresh: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearing(false)
    }
  }

  const maxBytes = createMemo(() => Math.max(1, ...(usage()?.entries.map((e) => e.bytes) ?? [1])))
  const updatedLabel = createMemo(() => {
    const value = usage()?.updated_at
    if (!value) return undefined
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return undefined
    return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
  })

  return (
    <PanelScroll>
      <div class="settings-preferences-panel settings-preferences-panel--storage">
        <PanelHeader title="Storage" description="Manage local data and review its disk usage." />
        <PanelBody>
          <Show when={error()}>
            <div class="settings-alert whitespace-pre-wrap" data-tone="critical" role="alert">
              <span>{error()}</span>
              <button type="button" class="settings-inline-action" disabled={loading()} onClick={() => void retry()}>
                Retry
              </button>
            </div>
          </Show>
          <Show when={status() && usage()}>
            <div class="settings-alert" data-tone="success" aria-live="polite">
              <span class="settings-preference-icon" data-tone="success" aria-hidden="true">
                <Icon name="check" size="small" />
              </span>
              <span class="min-w-0 flex-1">{status()}</span>
            </div>
          </Show>
          <Show when={picker()}>
            {(message) => (
              <div class="settings-alert" data-tone="warning" role="status">
                <Icon name="alert-circle" size="small" class="shrink-0 text-icon-weak-base" />
                <span class="min-w-0 flex-1">{message()}</span>
                <button
                  type="button"
                  class="settings-inline-action"
                  disabled={busy()}
                  onClick={() => void chooseLocation()}
                >
                  Try again
                </button>
              </div>
            )}
          </Show>
          <Show when={usage()?.scan_error}>
            {(message) => (
              <div class="settings-alert" data-tone="warning" role="status">
                <Icon name="alert-circle" size="small" class="shrink-0 text-icon-weak-base" />
                <span>Disk usage could not be refreshed. Cached values remain visible. {message()}</span>
                <button type="button" class="settings-inline-action" onClick={() => void retry()}>
                  Retry
                </button>
              </div>
            )}
          </Show>
          <Show when={usage()?.relocation}>
            {(relocation) => {
              const copy = () => storageRelocationCopy(relocation())
              return (
                <div class="settings-alert" data-tone={copy().tone} role="status" aria-live="polite">
                  <Icon
                    name={
                      copy().tone === "critical"
                        ? "alert-circle"
                        : copy().tone === "warning"
                          ? "alert-circle"
                          : "refresh"
                    }
                    size="small"
                    class="shrink-0 text-icon-weak-base"
                  />
                  <div class="min-w-0 flex-1">
                    <strong class="block text-12-medium text-text-strong">{copy().title}</strong>
                    <span class="block text-12-regular text-text-weak">{copy().detail}</span>
                    <Show when={relocation().target}>
                      <code class="mt-1 block truncate text-11-regular text-text-weak" title={relocation().target}>
                        {relocation().target}
                      </code>
                    </Show>
                  </div>
                  <Show
                    when={!relocation().active && relocation().target && relocation().phase !== "recovery_required"}
                  >
                    <button
                      type="button"
                      class="settings-preference-action shrink-0"
                      disabled={busy()}
                      onClick={() => void relocate(relocation().target)}
                    >
                      Resume safely
                    </button>
                  </Show>
                </div>
              )
            }}
          </Show>

          <Show
            when={!loading() && !error() && usage()}
            fallback={
              <Show when={loading()}>
                <div class="settings-panel-loading__rows" role="status" aria-label="Loading storage settings">
                  <span />
                  <span />
                  <span />
                </div>
              </Show>
            }
          >
            <Section title="Data location" description="Sessions, credentials, skills, and logs live here.">
              <div class="settings-card settings-preferences-card">
                <div class="settings-storage-location">
                  <span class="settings-preference-icon" aria-hidden="true">
                    <Icon name="folder" size="small" />
                  </span>
                  <div class="settings-row-copy">
                    <div class="flex min-w-0 flex-wrap items-center gap-2">
                      <strong class="settings-storage-path min-w-0 truncate font-mono" title={usage()?.data_dir}>
                        {usage()?.data_dir ?? "…"}
                      </strong>
                      <Show when={usage()?.pointer}>
                        <span class="settings-preference-status">Custom</span>
                      </Show>
                    </div>
                    <span class="settings-storage-size">
                      {usage()?.scanning && !usage()?.updated_at
                        ? "Calculating disk usage…"
                        : `${fmt(usage()!.total_bytes)} total${usage()?.scanning ? " · Updating…" : ""}${updatedLabel() ? ` · Updated ${updatedLabel()}` : ""}`}
                    </span>
                  </div>
                  <div class="settings-storage-location__actions flex shrink-0 items-center gap-1">
                    <Show when={usage()?.pointer}>
                      <button
                        type="button"
                        class="settings-preference-action"
                        data-variant="quiet"
                        disabled={busy() || !usage()?.managed}
                        onClick={() => void resetLocation()}
                      >
                        Use default
                      </button>
                    </Show>
                    <Show when={!editing()}>
                      <button
                        type="button"
                        class="settings-preference-action"
                        disabled={busy() || !usage()?.managed}
                        onClick={() => void chooseLocation()}
                      >
                        Change location…
                      </button>
                    </Show>
                  </div>
                </div>
                <Show when={editing()}>
                  <div class="settings-inline-editor">
                    <label for="storage-location-input" class="text-12-medium text-text-strong">
                      New data directory
                    </label>
                    <input
                      id="storage-location-input"
                      class="settings-field settings-storage-location-input min-w-0 flex-1 basis-[240px] font-mono"
                      value={target()}
                      placeholder="/Users/you/OpenScience-data"
                      spellcheck={false}
                      autofocus
                      onInput={(event) => setTarget(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return
                        event.preventDefault()
                        void relocate()
                      }}
                    />
                    <p class="max-w-[68ch] text-12-regular text-text-weak">
                      OpenScience verifies files and SQLite data, pauses active writes, and switches every running
                      server together. The current directory remains untouched as a safety copy.
                    </p>
                    <div class="settings-inline-editor__actions">
                      <Show when={platform.openDirectoryPickerDialog}>
                        <button
                          type="button"
                          class="settings-preference-action"
                          data-variant="quiet"
                          disabled={busy()}
                          onClick={() => void chooseLocation()}
                        >
                          Browse…
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="settings-preference-action"
                        data-variant="quiet"
                        disabled={busy()}
                        onClick={() => {
                          setEditing(false)
                          setTarget("")
                          setPicker(undefined)
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        class="settings-preference-action"
                        data-variant="primary"
                        disabled={busy() || !target().trim()}
                        onClick={() => void relocate()}
                      >
                        {busy() ? "Moving…" : "Move data"}
                      </button>
                    </div>
                  </div>
                </Show>
                <Show when={usage() && !usage()!.managed}>
                  <div class="settings-alert m-3 mt-0" data-tone="neutral">
                    <Icon name="alert-circle" size="small" class="shrink-0 text-icon-weak-base" />
                    <span>OPENSCIENCE_DATA_DIR owns this process, so change that environment setting to move it.</span>
                  </div>
                </Show>
              </div>
            </Section>

            <Section title="Local cache" description="Downloaded runtime packages and metadata. Recreated when needed.">
              <div class="settings-card settings-preferences-card">
                <div class="settings-storage-cache settings-row settings-preference-row">
                  <span class="settings-preference-icon" aria-hidden="true">
                    <Icon name="archive" size="small" />
                  </span>
                  <div class="settings-row-copy">
                    <strong>OpenScience cache</strong>
                    <code class="min-w-0 truncate text-11-regular text-text-weak" title={usage()?.cache_dir}>
                      {usage()?.cache_dir}
                    </code>
                  </div>
                  <span class="settings-storage-metric text-12-regular text-text-weak">
                    {usage()?.scanning && !usage()?.updated_at ? "Calculating…" : fmt(usage()?.cache_bytes ?? 0)}
                  </span>
                  <button
                    type="button"
                    class="settings-preference-action"
                    data-variant="quiet"
                    disabled={clearing()}
                    onClick={() => void clearCache()}
                  >
                    <Icon name="trash" size="small" />
                    {clearing() ? "Clearing…" : "Clear cache"}
                  </button>
                </div>
              </div>
            </Section>

            <Section
              title="Disk usage"
              description={
                usage()?.scanning
                  ? "Calculating allocated disk usage. Cached entries remain visible while the scan runs."
                  : "Top-level entries inside the data directory, largest first."
              }
            >
              <Show
                when={usage() && usage()!.entries.length > 0}
                fallback={
                  <div class="settings-card settings-preferences-card">
                    <div class="settings-row settings-preference-row text-12-regular text-text-weak">
                      <span class="settings-preference-icon" aria-hidden="true">
                        <Icon name="archive" size="small" />
                      </span>
                      {usage()?.scanning ? "Calculating disk usage…" : "Nothing stored yet."}
                    </div>
                  </div>
                }
              >
                <div class="settings-card settings-preferences-card">
                  <For each={usage()!.entries}>
                    {(entry) => (
                      <div class="settings-row settings-preference-row settings-storage-usage-row">
                        <span class="settings-preference-icon" aria-hidden="true">
                          <Icon name={entry.kind === "dir" ? "folder" : "file"} size="small" />
                        </span>
                        <code class="min-w-0 truncate text-13-regular text-text-strong">
                          {entry.name}
                          {entry.kind === "dir" ? "/" : ""}
                        </code>
                        <span class="settings-storage-metric text-12-regular text-text-weak flex-shrink-0">
                          {fmt(entry.bytes)}
                        </span>
                        <div
                          class="settings-storage-meter"
                          role="progressbar"
                          aria-label={`${entry.name} relative disk usage`}
                          aria-valuemin="0"
                          aria-valuemax={maxBytes()}
                          aria-valuenow={entry.bytes}
                        >
                          <span style={{ width: `${Math.max(2, (entry.bytes / maxBytes()) * 100)}%` }} />
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Section>
          </Show>
        </PanelBody>
      </div>
    </PanelScroll>
  )
}

export default Storage
