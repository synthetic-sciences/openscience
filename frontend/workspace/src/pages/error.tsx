import { Button } from "@synsci/ui/button"
import { Component, Show, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { IconAlertCircle, IconCopy, IconRefresh } from "@/atlas/shared/Icon"
import { updateController } from "@/components/settings/update-controller"

export type InitError = {
  name: string
  data: Record<string, unknown>
}

type Translator = ReturnType<typeof useLanguage>["t"]

function isInitError(error: unknown): error is InitError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof (error as InitError).data === "object"
  )
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString()
      if (typeof val === "object" && val) {
        if (seen.has(val)) return "[Circular]"
        seen.add(val)
      }
      return val
    },
    2,
  )
  return json ?? String(value)
}

function formatInitError(error: InitError, t: Translator): string {
  const data = error.data
  switch (error.name) {
    case "MCPFailed": {
      const name = typeof data.name === "string" ? data.name : ""
      return t("error.chain.mcpFailed", { name })
    }
    case "ProviderAuthError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : "unknown"
      const message = typeof data.message === "string" ? data.message : safeJson(data.message)
      return t("error.chain.providerAuthFailed", { provider: providerID, message })
    }
    case "APIError": {
      const message = typeof data.message === "string" ? data.message : t("error.chain.apiError")
      const lines: string[] = [message]

      if (typeof data.statusCode === "number") {
        lines.push(t("error.chain.status", { status: data.statusCode }))
      }

      if (typeof data.isRetryable === "boolean") {
        lines.push(t("error.chain.retryable", { retryable: data.isRetryable }))
      }

      if (typeof data.responseBody === "string" && data.responseBody) {
        lines.push(t("error.chain.responseBody", { body: data.responseBody }))
      }

      return lines.join("\n")
    }
    case "ProviderModelNotFoundError": {
      const { providerID, modelID, suggestions } = data as {
        providerID: string
        modelID: string
        suggestions?: string[]
      }

      const suggestionsLine =
        Array.isArray(suggestions) && suggestions.length
          ? [t("error.chain.didYouMean", { suggestions: suggestions.join(", ") })]
          : []

      return [
        t("error.chain.modelNotFound", { provider: providerID, model: modelID }),
        ...suggestionsLine,
        t("error.chain.checkConfig"),
      ].join("\n")
    }
    case "ProviderInitError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : "unknown"
      return t("error.chain.providerInitFailed", { provider: providerID })
    }
    case "ConfigJsonError": {
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)
      const message = typeof data.message === "string" ? data.message : ""
      if (message) return t("error.chain.configJsonInvalidWithMessage", { path, message })
      return t("error.chain.configJsonInvalid", { path })
    }
    case "ConfigDirectoryTypoError": {
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)
      const dir = typeof data.dir === "string" ? data.dir : safeJson(data.dir)
      const suggestion = typeof data.suggestion === "string" ? data.suggestion : safeJson(data.suggestion)
      return t("error.chain.configDirectoryTypo", { dir, path, suggestion })
    }
    case "ConfigFrontmatterError": {
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)
      const message = typeof data.message === "string" ? data.message : safeJson(data.message)
      return t("error.chain.configFrontmatterError", { path, message })
    }
    case "ConfigInvalidError": {
      const issues = Array.isArray(data.issues)
        ? data.issues.map(
            (issue: { message: string; path: string[] }) => "↳ " + issue.message + " " + issue.path.join("."),
          )
        : []
      const message = typeof data.message === "string" ? data.message : ""
      const path = typeof data.path === "string" ? data.path : safeJson(data.path)

      const line = message
        ? t("error.chain.configInvalidWithMessage", { path, message })
        : t("error.chain.configInvalid", { path })

      return [line, ...issues].join("\n")
    }
    case "UnknownError":
      return typeof data.message === "string" ? data.message : safeJson(data)
    default:
      if (typeof data.message === "string") return data.message
      return safeJson(data)
  }
}

function formatErrorChain(error: unknown, t: Translator, depth = 0, parentMessage?: string): string {
  if (!error) return t("error.chain.unknown")

  if (isInitError(error)) {
    const message = formatInitError(error, t)
    if (depth > 0 && parentMessage === message) return ""
    const indent = depth > 0 ? `\n${"─".repeat(40)}\n${t("error.chain.causedBy")}\n` : ""
    return indent + `${error.name}\n${message}`
  }

  if (error instanceof Error) {
    const isDuplicate = depth > 0 && parentMessage === error.message
    const parts: string[] = []
    const indent = depth > 0 ? `\n${"─".repeat(40)}\n${t("error.chain.causedBy")}\n` : ""

    const header = `${error.name}${error.message ? `: ${error.message}` : ""}`
    const stack = error.stack?.trim()

    if (stack) {
      const startsWithHeader = stack.startsWith(header)

      if (isDuplicate && startsWithHeader) {
        const trace = stack.split("\n").slice(1).join("\n").trim()
        if (trace) {
          parts.push(indent + trace)
        }
      }

      if (isDuplicate && !startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && !startsWithHeader) {
        parts.push(indent + `${header}\n${stack}`)
      }
    }

    if (!stack && !isDuplicate) {
      parts.push(indent + header)
    }

    if (error.cause) {
      const causeResult = formatErrorChain(error.cause, t, depth + 1, error.message)
      if (causeResult) {
        parts.push(causeResult)
      }
    }

    return parts.join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    const indent = depth > 0 ? `\n${"─".repeat(40)}\n${t("error.chain.causedBy")}\n` : ""
    return indent + error
  }

  const indent = depth > 0 ? `\n${"─".repeat(40)}\n${t("error.chain.causedBy")}\n` : ""
  return indent + safeJson(error)
}

function formatError(error: unknown, t: Translator): string {
  return formatErrorChain(error, t, 0)
}

interface ErrorPageProps {
  error: unknown
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()
  const updates = updateController(platform)
  updates.start()
  const language = useLanguage()
  const [copied, setCopied] = createSignal(false)
  const [store, setStore] = createStore({
    checking: false,
    updating: false,
    version: undefined as string | undefined,
    updateError: undefined as string | undefined,
  })

  async function checkForUpdates() {
    if (!platform.checkUpdate) return
    setStore("checking", true)
    setStore("updateError", undefined)
    try {
      const result = await updates.check()
      if (result?.updateAvailable && result.version) setStore("version", result.version)
    } catch (error) {
      setStore("updateError", error instanceof Error ? error.message : String(error))
    } finally {
      setStore("checking", false)
    }
  }

  async function installUpdate() {
    if (store.updating) return
    setStore("updating", true)
    setStore("updateError", undefined)
    try {
      if (platform.stageUpdate && platform.applyUpdate) {
        if (updates.state.phase === "ready") await updates.apply()
        else await updates.stage()
        return
      }
      if (!platform.update || !platform.restart) return
      await platform.update()
      await platform.restart()
    } catch (error) {
      setStore("updateError", error instanceof Error ? error.message : String(error))
    } finally {
      setStore("updating", false)
    }
  }

  const detail = () => formatError(props.error, language.t)
  const hint = () => {
    const text = detail().toLowerCase()
    if (text.includes("providerauth") || text.includes("unauthorized") || text.includes("401")) {
      return "A model provider rejected its credentials. Reload first; if it returns, reconnect that provider in Settings."
    }
    if (text.includes("config") || text.includes("json")) {
      return "OpenScience could not read part of its configuration. The technical details below identify the file to repair."
    }
    if (text.includes("fetch") || text.includes("network") || text.includes("connection")) {
      return "The app lost contact with its server. Make sure the local server is running, then reload."
    }
    return "Reloading usually restores the workspace without losing project files or saved conversations."
  }
  const diagnostics = () =>
    [
      "OpenScience diagnostic",
      `time: ${new Date().toISOString()}`,
      `version: ${platform.version ?? "unknown"}`,
      `platform: ${platform.platform}${platform.os ? `/${platform.os}` : ""}`,
      `url: ${typeof location === "undefined" ? "unknown" : location.href}`,
      "",
      detail(),
    ].join("\n")
  const copy = async () => {
    await navigator.clipboard?.writeText(diagnostics())
    setCopied(true)
  }

  return (
    <div
      class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base"
      style={{
        "font-family": FONT_SANS,
        padding: "32px",
        background:
          "radial-gradient(circle at 50% 25%, color-mix(in srgb, var(--color-danger) 6%, transparent), transparent 34%), var(--color-bg)",
      }}
    >
      <main
        style={{
          width: "min(100%, 720px)",
          display: "flex",
          "flex-direction": "column",
          gap: "24px",
          padding: "30px",
          border: "1px solid var(--color-border)",
          "border-radius": "10px",
          background: "var(--color-surface-solid)",
          "box-shadow": "var(--shadow-lg)",
        }}
      >
        <div style={{ display: "flex", "align-items": "flex-start", gap: "16px" }}>
          <span
            style={{
              width: "40px",
              height: "40px",
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              "border-radius": "10px",
              background: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
              color: "var(--color-danger)",
              "flex-shrink": 0,
            }}
          >
            <IconAlertCircle size={20} strokeWidth={1.6} />
          </span>
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "min-width": 0 }}>
            <span
              style={{
                "font-family": FONT_SANS,
                "font-size": "12px",
                "font-weight": "var(--font-weight-medium)",
                color: "var(--color-text-muted)",
              }}
            >
              Workspace recovery
            </span>
            <h1
              style={{
                margin: 0,
                color: "var(--color-text)",
                "font-size": "24px",
                "font-weight": "var(--font-weight-emphasis)",
                "letter-spacing": "-0.025em",
              }}
            >
              OpenScience hit a problem
            </h1>
            <p style={{ margin: 0, color: "var(--color-text-muted)", "font-size": "13px", "line-height": 1.6 }}>
              {hint()}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", "align-items": "center", "flex-wrap": "wrap", gap: "8px" }}>
          <Button size="large" onClick={() => void platform.restart()}>
            <span style={{ display: "inline-flex", "align-items": "center", gap: "7px" }}>
              <IconRefresh size={13} />
              {platform.platform === "desktop" ? "Restart App" : "Reload App"}
            </span>
          </Button>
          <Button size="large" variant="secondary" onClick={() => void copy()}>
            <span style={{ display: "inline-flex", "align-items": "center", gap: "7px" }}>
              <IconCopy size={13} />
              {copied() ? "Diagnostic Copied" : "Copy Diagnostic"}
            </span>
          </Button>
          <Show when={platform.checkUpdate}>
            <Show
              when={store.version}
              fallback={
                <Button size="large" variant="ghost" onClick={checkForUpdates} disabled={store.checking}>
                  {store.checking ? "Checking…" : "Check for Updates"}
                </Button>
              }
            >
              <Button
                size="large"
                onClick={installUpdate}
                disabled={
                  store.updating ||
                  ["downloading", "extracting", "verifying", "restarting"].includes(updates.state.phase)
                }
              >
                {updates.state.phase === "ready"
                  ? "Restart to update"
                  : ["downloading", "extracting", "verifying"].includes(updates.state.phase)
                    ? "Preparing update…"
                    : `Download ${store.version}`}
              </Button>
            </Show>
          </Show>
        </div>
        <Show when={store.updateError ?? updates.state.error}>
          {(message) => (
            <p role="alert" style={{ margin: 0, color: "var(--color-error)", "font-size": "12px" }}>
              Update check failed: {message()}
            </p>
          )}
        </Show>

        <details
          style={{
            border: "1px solid var(--color-border)",
            "border-radius": "6px",
            background: "var(--color-bg-subtle)",
            overflow: "hidden",
          }}
        >
          <summary
            style={{
              cursor: "pointer",
              padding: "11px 13px",
              color: "var(--color-text-muted)",
              "font-family": FONT_MONO,
              "font-size": "10px",
              "user-select": "none",
            }}
          >
            technical details
          </summary>
          <pre
            style={{
              margin: 0,
              padding: "13px",
              "max-height": "260px",
              overflow: "auto",
              "border-top": "1px solid var(--color-border)",
              background: "var(--color-bg)",
              color: "var(--color-text-muted)",
              "font-family": FONT_MONO,
              "font-size": "10px",
              "line-height": 1.55,
              "white-space": "pre-wrap",
              "overflow-wrap": "anywhere",
            }}
          >
            {detail()}
          </pre>
        </details>

        <footer
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            gap: "16px",
            color: "var(--color-text-faint)",
            "font-family": FONT_MONO,
            "font-size": "10px",
          }}
        >
          <span>OpenScience {platform.version ?? "development build"}</span>
          <span style={{ display: "inline-flex", "align-items": "center", gap: "5px" }}>
            Still stuck?
            <button
              type="button"
              onClick={() => platform.openLink("https://github.com/synthetic-sciences/openscience/issues/new")}
              style={{
                all: "unset",
                cursor: "pointer",
                color: "var(--color-accent)",
                "text-decoration": "underline",
                "text-underline-offset": "3px",
              }}
            >
              Report This Issue
            </button>
          </span>
        </footer>
      </main>
    </div>
  )
}
