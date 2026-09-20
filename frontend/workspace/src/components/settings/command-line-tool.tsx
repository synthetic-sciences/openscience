import { Component, Show, createResource, createSignal } from "solid-js"
import { Button } from "@synsci/ui/button"
import { showToast } from "@synsci/ui/toast"
import { settingsApi } from "./api"
import { SettingsRow } from "./general-row"

/** `GET /settings/cli`: the link in `~/.openscience/bin` and its PATH line. */
export type CommandLineStatus = {
  home: string
  directory: string
  path: string
  exists: boolean
  target?: string
  current: boolean
  ours: boolean
  onPath: boolean
  shell: string
  line: string
  config?: string
  installable: boolean
  reason?: string
}

export type CommandLineClient = {
  status(): Promise<CommandLineStatus>
  install(): Promise<CommandLineStatus>
}

export function createCommandLineClient(base: string, fetchFn: typeof fetch): CommandLineClient {
  return {
    status: () => settingsApi<CommandLineStatus>(base, fetchFn, "/settings/cli"),
    install: () => settingsApi<CommandLineStatus>(base, fetchFn, "/settings/cli/install", { method: "POST" }),
  }
}

export type CommandLineCopy = { description: string; action?: "Install" | "Repair" }

/**
 * What the row says and which button, if any, it offers. A file or link the
 * app did not create is reported and left alone. Repair covers a link of the
 * app's own that the launch could not re-point and a directory the shell does
 * not know yet; it runs the same install again.
 */
export function commandLineCopy(status: CommandLineStatus | undefined, error?: unknown): CommandLineCopy {
  if (error) return { description: `The command line tool could not be checked: ${message(error)}` }
  if (!status) return { description: "Checking…" }
  if (!status.exists) {
    if (!status.installable) return { description: `Not installed. ${status.reason ?? ""}`.trim() }
    return {
      description: "Not installed. Install puts openscience on your PATH, linked to this app.",
      action: "Install",
    }
  }
  if (!status.ours) return { description: `${installed(status)}. ${status.reason ?? ""}`.trim() }
  if (!status.current) {
    const target = status.target ? tilde(status.target, status.home) : "another copy of OpenScience"
    return { description: `Installed, but it points at ${target}.`, action: status.installable ? "Repair" : undefined }
  }
  return { description: installed(status), action: status.onPath || !status.installable ? undefined : "Repair" }
}

function installed(status: CommandLineStatus) {
  if (status.onPath) return "Installed and on your PATH"
  return `Installed, but ${tilde(status.directory, status.home)} is not on your PATH — add: ${status.line}`
}

function tilde(file: string, home: string) {
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const CommandLineToolRow: Component<{ client: CommandLineClient }> = (props) => {
  // `latest` keeps the row from suspending the whole panel while it loads.
  const [status, { mutate, refetch }] = createResource(() => props.client.status())
  const [busy, setBusy] = createSignal(false)
  const copy = () => commandLineCopy(status.latest, status.error)
  const run = () => {
    setBusy(true)
    props.client
      .install()
      .then((next) => {
        mutate(next)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: "Command line tool installed",
          description: next.onPath
            ? "Open a new terminal and run openscience."
            : `Add this line to your shell startup file: ${next.line}`,
        })
      })
      .catch((error: unknown) => {
        showToast({ variant: "error", title: "The command line tool was not installed", description: message(error) })
        void refetch()
      })
      .finally(() => setBusy(false))
  }
  return (
    <SettingsRow title="Command line tool" description={copy().description}>
      <Show when={copy().action}>
        {(action) => (
          <Button size="small" variant="secondary" disabled={busy()} onClick={run}>
            {busy() ? "Installing…" : action()}
          </Button>
        )}
      </Show>
    </SettingsRow>
  )
}
