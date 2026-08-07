// Storage — real on-disk footprint of the OpenScience data directory and a
// supported "change location" move.
// Backed by /settings/storage (routes/settings/storage.ts).
import { type Component, type JSX, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { usePlatform } from "@/context/platform"
import { FONT_CODE, FONT_SANS } from "@/styles/tokens"
import { settingsApi } from "./api"

type Entry = { name: string; path: string; bytes: number; kind: "dir" | "file" }
type Usage = {
  data_dir: string
  config_dir: string
  cache_dir: string
  state_dir: string
  pointer: string | null
  total_bytes: number
  entries: Entry[]
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

export const Storage: Component = () => {
  const sdk = useGlobalSDK()
  const platform = usePlatform()

  const base = () => sdk.url
  const fetchFn = () => platform.fetch ?? fetch

  const [usage, setUsage] = createSignal<Usage>()
  const [error, setError] = createSignal<string>()
  const [status, setStatus] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [target, setTarget] = createSignal("")

  const load = async () => {
    setError(undefined)
    try {
      setUsage(await settingsApi<Usage>(base(), fetchFn(), "/settings/storage"))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  onMount(() => void load())

  const chooseLocation = async () => {
    if (busy()) return
    setError(undefined)
    setStatus(undefined)
    setEditing(true)
    if (!platform.openDirectoryPickerDialog) return
    const picked = await platform.openDirectoryPickerDialog({ title: "Choose a new data location" }).catch(() => null)
    const path = Array.isArray(picked) ? picked[0] : picked
    if (path) setTarget(path)
  }

  const relocate = async () => {
    const path = target().trim()
    if (busy() || !path) return
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    try {
      const res = await settingsApi<{ ok: boolean; target: string; restart_required: boolean }>(
        base(),
        fetchFn(),
        "/settings/storage/location",
        { method: "POST", body: JSON.stringify({ path }) },
      )
      setEditing(false)
      setTarget("")
      setStatus(`Data copied to ${res.target}. Restart OpenScience to use the new location.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resetLocation = async () => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    setStatus(undefined)
    try {
      await settingsApi(base(), fetchFn(), "/settings/storage/location", { method: "DELETE" })
      setStatus("Custom location cleared. Restart to return to the default directory.")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const cancelLocation = () => {
    if (busy()) return
    setEditing(false)
    setTarget("")
    setError(undefined)
  }

  const maxBytes = createMemo(() => Math.max(1, ...(usage()?.entries.map((e) => e.bytes) ?? [1])))

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="settings-page-header">
        <div class="settings-page-header__inner">
          <h2 class="text-16-medium text-text-strong">Storage</h2>
          <p class="text-13-regular text-text-weak">
            Where OpenScience keeps data on disk, and how much space it uses.
          </p>
        </div>
      </div>

      <div class="settings-page-body">
        <Show when={error()}>
          <div role="alert" style={bannerStyle("var(--color-error)", "var(--color-error-muted)")}>
            {error()}
          </div>
        </Show>
        <Show when={status()}>
          <div aria-live="polite" style={bannerStyle("var(--color-success)", "var(--color-success-muted)")}>
            {status()}
          </div>
        </Show>

        {/* Data location */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <h3 class="text-13-medium text-text-weak tracking-wide">Data location</h3>
            <p class="text-12-regular text-text-weak">
              The directory holding sessions, credentials, skills, and logs. The default is ~/.openscience.
            </p>
          </div>
          <div style={{ border: "1px solid var(--color-border)", "border-radius": "4px", padding: "16px 18px" }}>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-col gap-1 min-w-0">
                <span
                  class="text-13-regular text-text-strong truncate"
                  style={{ "font-family": FONT_CODE }}
                  title={usage()?.data_dir}
                >
                  {usage()?.data_dir ?? "…"}
                </span>
                <span class="text-12-regular text-text-weak">
                  {fmt(usage()?.total_bytes ?? 0)} total
                  <Show when={usage()?.pointer}> · custom location</Show>
                </span>
              </div>
              <div class="flex gap-2 flex-shrink-0">
                <Show when={usage()?.pointer}>
                  <Button size="small" variant="secondary" disabled={busy()} onClick={() => void resetLocation()}>
                    Reset location
                  </Button>
                </Show>
                <Show when={!editing()}>
                  <Button size="small" variant="secondary" disabled={busy()} onClick={() => void chooseLocation()}>
                    Change location
                  </Button>
                </Show>
              </div>
            </div>
            <Show when={editing()}>
              <div class="flex flex-col gap-2 mt-4 pt-4 border-t border-border-weak-base">
                <label for="storage-location-input" class="text-12-medium text-text-strong">
                  New data directory
                </label>
                <input
                  id="storage-location-input"
                  aria-label="New data directory"
                  value={target()}
                  onInput={(event) => setTarget(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return
                    event.preventDefault()
                    void relocate()
                  }}
                  placeholder="/Users/you/OpenScience-data"
                  spellcheck={false}
                  autofocus
                  class="text-12-mono text-text-strong bg-transparent outline-none"
                  style={{
                    width: "100%",
                    "box-sizing": "border-box",
                    padding: "8px 10px",
                    border: "1px solid var(--color-border)",
                    "border-radius": "4px",
                    "font-family": FONT_CODE,
                  }}
                />
                <p class="text-12-regular text-text-weak max-w-[62ch]">
                  OpenScience copies the current data into an empty folder and switches to it after restart. The
                  original stays in place as a safety copy.
                </p>
                <div class="flex flex-wrap items-center justify-end gap-2 mt-1">
                  <Show when={platform.openDirectoryPickerDialog}>
                    <Button size="small" variant="secondary" disabled={busy()} onClick={() => void chooseLocation()}>
                      Browse…
                    </Button>
                  </Show>
                  <Button size="small" variant="secondary" disabled={busy()} onClick={cancelLocation}>
                    Cancel
                  </Button>
                  <Button
                    size="small"
                    variant="primary"
                    disabled={busy() || !target().trim()}
                    onClick={() => void relocate()}
                  >
                    {busy() ? "Copying…" : "Copy data"}
                  </Button>
                </div>
              </div>
            </Show>
          </div>
        </div>

        {/* Disk usage */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <h3 class="text-13-medium text-text-weak tracking-wide">Disk usage</h3>
            <p class="text-12-regular text-text-weak">Top-level entries inside the data directory, largest first.</p>
          </div>
          <Show
            when={usage() && usage()!.entries.length > 0}
            fallback={
              <div
                class="text-12-regular text-text-weak"
                style={{
                  border: "1px dashed var(--color-border-strong)",
                  "border-radius": "4px",
                  padding: "14px 16px",
                }}
              >
                {usage() ? "Nothing stored yet." : "Loading…"}
              </div>
            }
          >
            <div style={{ border: "1px solid var(--color-border)", "border-radius": "4px", overflow: "hidden" }}>
              <For each={usage()!.entries}>
                {(entry) => (
                  <div class="flex flex-col gap-1.5 px-4 py-3 border-b border-border-weak-base last:border-none">
                    <div class="flex items-center justify-between gap-3">
                      <span class="text-13-regular text-text-strong truncate" style={{ "font-family": FONT_CODE }}>
                        {entry.name}
                        {entry.kind === "dir" ? "/" : ""}
                      </span>
                      <span class="text-12-regular text-text-weak flex-shrink-0">{fmt(entry.bytes)}</span>
                    </div>
                    <div
                      style={{
                        height: "4px",
                        "border-radius": "999px",
                        background: "var(--color-border-weak-base, rgba(255,255,255,0.08))",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.max(2, (entry.bytes / maxBytes()) * 100)}%`,
                          background: "var(--color-text-interactive-base, var(--color-text))",
                          "border-radius": "999px",
                        }}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

export default Storage

function bannerStyle(color: string, border: string): JSX.CSSProperties {
  return {
    "font-family": FONT_SANS,
    "font-size": "12px",
    "line-height": 1.5,
    color,
    border: `1px solid ${border}`,
    "border-radius": "4px",
    padding: "10px 12px",
    "white-space": "pre-wrap",
  }
}
