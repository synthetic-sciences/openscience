// @refresh reload
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { Platform, PlatformProvider } from "@/context/platform"
import { dict as en } from "@/i18n/en"
import { dict as zh } from "@/i18n/zh"
import { openscienceFetch } from "@/utils/openscience-fetch"
import { URLS } from "@/config/urls"
import { openNativeDirectoryPicker } from "@/utils/native-picker"
import { normalizeServerUrl } from "@/context/server"
import { resolveDefaultServerUrl, resolveDesktopServerUrl, resolveServerRoute } from "@/config/server-url"
import pkg from "../package.json"
import { waitForUpdatedServer, type UpdateHealth } from "@/utils/update-restart"
import { updateError } from "@/utils/update-error"

const DEFAULT_SERVER_URL_KEY = "openscience.settings.dat:defaultServerUrl"
const desktopUrl = resolveDesktopServerUrl(location.search, window.location.origin)

const stored = () => {
  if (desktopUrl) return
  if (typeof localStorage === "undefined") return
  try {
    return normalizeServerUrl(localStorage.getItem(DEFAULT_SERVER_URL_KEY) ?? "")
  } catch {
    return
  }
}

const configured = () => {
  const direct = normalizeServerUrl(import.meta.env.VITE_OPENSCIENCE_SERVER_URL ?? "")
  if (direct) return direct
  const host = import.meta.env.VITE_OPENSCIENCE_SERVER_HOST
  const port = import.meta.env.VITE_OPENSCIENCE_SERVER_PORT
  if (!host && !port) return
  return normalizeServerUrl(`http://${host ?? "localhost"}:${port ?? "4096"}`)
}

const server = () =>
  resolveDefaultServerUrl({
    explicit: desktopUrl,
    stored: stored(),
    configured: configured(),
    hostname: location.hostname,
    origin: window.location.origin,
    hostedDomain: URLS.host,
    dev: import.meta.env.DEV,
  })

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  const locale = (() => {
    if (typeof navigator !== "object") return "en" as const
    const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
    for (const language of languages) {
      if (!language) continue
      if (language.toLowerCase().startsWith("zh")) return "zh" as const
    }
    return "en" as const
  })()
  const key = "error.dev.rootNotFound" as const
  const message = locale === "zh" ? (zh[key] ?? en[key]) : en[key]
  throw new Error(message)
}

const platform: Platform = {
  platform: desktopUrl ? "desktop" : "web",
  version: import.meta.env.VITE_OPENSCIENCE_VERSION || pkg.version,
  openLink(url: string) {
    window.open(url, "_blank")
  },
  back() {
    window.history.back()
  },
  forward() {
    window.history.forward()
  },
  restart: async () => {
    window.location.reload()
  },
  notify: async (title, description, href) => {
    if (!("Notification" in window)) return
    const permission =
      Notification.permission === "default"
        ? await Notification.requestPermission().catch(() => "denied")
        : Notification.permission
    if (permission !== "granted") return
    const inView = document.visibilityState === "visible" && document.hasFocus()
    if (inView) return
    await Promise.resolve()
      .then(() => {
        const notification = new Notification(title, {
          body: description ?? "",
          icon: URLS.favicon,
        })
        notification.onclick = () => {
          window.focus()
          if (href) {
            window.history.pushState(null, "", href)
            window.dispatchEvent(new PopStateEvent("popstate"))
          }
          notification.close()
        }
      })
      .catch(() => undefined)
  },
  openDirectoryPickerDialog: (options) => openNativeDirectoryPicker(options, openscienceFetch),
  checkUpdate: async (options) => {
    const query = options?.refresh ? "?refresh=1" : ""
    const url = resolveServerRoute(`/settings/updates${query}`, server(), window.location.origin)
    const response = await openscienceFetch(url, { headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`Update check failed (${response.status})`)
    const result = (await response.json()) as { updateAvailable: boolean; latest?: string }
    return { updateAvailable: result.updateAvailable, version: result.latest }
  },
  update: async () => {
    const healthUrl = resolveServerRoute("/global/health", server(), window.location.origin)
    const before = await openscienceFetch(healthUrl, { headers: { Accept: "application/json" } })
      .then(async (response) => (response.ok ? ((await response.json()) as UpdateHealth) : undefined))
      .catch(() => undefined)
    const url = resolveServerRoute("/settings/updates", server(), window.location.origin)
    const response = await openscienceFetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined)
      throw new Error(updateError(detail, response.status))
    }
    const result = (await response.json()) as {
      installed: boolean
      restartRequired: boolean
      restartScheduled: boolean
      latest?: string
    }
    if (result.installed && result.restartScheduled) {
      await waitForUpdatedServer({
        previous: before?.runId,
        version: result.latest,
        check: async () => {
          const current = await openscienceFetch(healthUrl, { headers: { Accept: "application/json" } })
          if (!current.ok) return
          return (await current.json()) as UpdateHealth
        },
      })
      window.location.reload()
    }
    return {
      installed: result.installed,
      restartRequired: result.restartRequired,
      restartScheduled: result.restartScheduled,
      version: result.latest,
    }
  },
  listUpdates: async () => {
    const url = resolveServerRoute("/settings/updates/releases", server(), window.location.origin)
    const response = await openscienceFetch(url, { headers: { Accept: "application/json" } })
    if (!response.ok) throw new Error(`Release history failed (${response.status})`)
    const releases = (await response.json()) as Array<{
      tag_name?: string
      name?: string
      body?: string
      published_at?: string
      html_url?: string
    }>
    return releases.slice(0, 5).map((release) => ({
      version: release.tag_name?.replace(/^v/, "") ?? "Release",
      name: release.name || release.tag_name || "OpenScience release",
      notes: release.body?.trim() || "Maintenance and reliability improvements.",
      publishedAt: release.published_at,
      url: release.html_url || URLS.releases,
    }))
  },
  getDefaultServerUrl: () => stored() ?? null,
  setDefaultServerUrl: (url) => {
    if (desktopUrl) return
    if (typeof localStorage === "undefined") return
    try {
      if (url) {
        localStorage.setItem(DEFAULT_SERVER_URL_KEY, url)
        return
      }
      localStorage.removeItem(DEFAULT_SERVER_URL_KEY)
    } catch {
      return
    }
  },
  fetch: openscienceFetch,
}

render(
  () => (
    <PlatformProvider value={platform}>
      <AppBaseProviders>
        <AppInterface defaultUrl={desktopUrl} />
      </AppBaseProviders>
    </PlatformProvider>
  ),
  root!,
)
