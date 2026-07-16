// Storage — real on-disk footprint of the OpenScience data directory, a
// supported "change location" move, and a jump to Credentials for cloud buckets.
// Backed by /settings/storage (routes/settings/storage.ts).
import { type Component, type JSX, For, Show, createMemo, createSignal, onMount } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { FONT_CODE, FONT_SANS } from "@/styles/tokens"
import { settingsApi } from "./api"
import { useSettingsNav } from "./nav"

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
  const lang = useLanguage()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const navigate = useSettingsNav()

  const base = () => sdk.url
  const fetchFn = () => platform.fetch ?? fetch

  const [usage, setUsage] = createSignal<Usage>()
  const [error, setError] = createSignal<string>()
  const [status, setStatus] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  const load = async () => {
    setError(undefined)
    try {
      setUsage(await settingsApi<Usage>(base(), fetchFn(), "/settings/storage"))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  onMount(() => void load())

  const relocate = async () => {
    if (busy()) return
    setError(undefined)
    setStatus(undefined)
    let target: string | undefined
    if (platform.openDirectoryPickerDialog) {
      const picked = await platform.openDirectoryPickerDialog({ title: lang.t("settings.storage.dialog.chooseDataLocation") }).catch(() => null)
      target = Array.isArray(picked) ? picked[0] : (picked ?? undefined)
    } else {
      target = window.prompt(lang.t("settings.storage.dialog.promptNewPath")) ?? undefined
    }
    if (!target?.trim()) return
    setBusy(true)
    try {
      const res = await settingsApi<{ ok: boolean; target: string; restart_required: boolean }>(
        base(),
        fetchFn(),
        "/settings/storage/location",
        { method: "POST", body: JSON.stringify({ path: target.trim() }) },
      )
      setStatus(lang.t("settings.storage.toast.relocated", { target: res.target }))
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
      setStatus(lang.t("settings.storage.toast.locationCleared"))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const maxBytes = createMemo(() => Math.max(1, ...(usage()?.entries.map((e) => e.bytes) ?? [1])))

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">{lang.t("settings.storage.heading")}</h2>
          <p class="text-13-regular text-text-weak">
            {lang.t("settings.storage.description")}
          </p>
        </div>
      </div>

      <div class="flex flex-col gap-8 px-4 pb-10 sm:px-8 max-w-[760px]">
        <Show when={error()}>
          <div style={bannerStyle("var(--color-error)", "var(--color-error-muted)")}>{error()}</div>
        </Show>
        <Show when={status()}>
          <div style={bannerStyle("var(--color-success)", "var(--color-success-muted)")}>{status()}</div>
        </Show>

        {/* Data location */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <h3 class="text-13-medium text-text-weak tracking-wide">{lang.t("settings.storage.section.dataLocation")}</h3>
            <p class="text-12-regular text-text-weak">{lang.t("settings.storage.section.dataLocation.description")}</p>
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
                  {fmt(usage()?.total_bytes ?? 0)} {lang.t("settings.storage.status.total")}
                  <Show when={usage()?.pointer}> · {lang.t("settings.storage.status.customLocation")}</Show>
                </span>
              </div>
              <div class="flex gap-2 flex-shrink-0">
                <Show when={usage()?.pointer}>
                  <Button size="small" variant="secondary" disabled={busy()} onClick={() => void resetLocation()}>
                    {lang.t("common.reset")}
                  </Button>
                </Show>
                <Button size="small" variant="secondary" disabled={busy()} onClick={() => void relocate()}>
                  {busy() ? lang.t("settings.storage.status.working") : lang.t("settings.storage.action.changeLocation")}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {/* Disk usage */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <h3 class="text-13-medium text-text-weak tracking-wide">{lang.t("settings.storage.section.diskUsage")}</h3>
            <p class="text-12-regular text-text-weak">{lang.t("settings.storage.section.diskUsage.description")}</p>
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
                {usage() ? lang.t("settings.storage.empty.nothingStored") : lang.t("common.loading") + "…"}
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

        {/* Cloud storage */}
        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-1">
            <h3 class="text-13-medium text-text-weak tracking-wide">{lang.t("settings.storage.section.cloudStorage")}</h3>
            <p class="text-12-regular text-text-weak">
              {lang.t("settings.storage.section.cloudStorage.description")}
            </p>
          </div>
          <button type="button" onClick={() => navigate("credentials")} style={linkRowStyle()}>
            <span class="text-13-regular text-text-strong">{lang.t("settings.storage.action.manageCloudCredentials")}</span>
            <span class="text-12-regular text-text-weak">{lang.t("settings.storage.action.credentialsLink")}</span>
          </button>
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

function linkRowStyle(): JSX.CSSProperties {
  return {
    all: "unset",
    "box-sizing": "border-box",
    cursor: "pointer",
    display: "flex",
    "align-items": "center",
    "justify-content": "space-between",
    padding: "14px 16px",
    "border-radius": "4px",
    border: "1px solid var(--color-border)",
    background: "var(--color-surface-solid, transparent)",
  }
}
