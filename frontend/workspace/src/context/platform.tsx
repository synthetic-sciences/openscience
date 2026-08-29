import { createSimpleContext } from "@synsci/ui/context"
import { AsyncStorage, SyncStorage } from "@solid-primitives/storage"

export type Platform = {
  /** Platform discriminator */
  platform: "web" | "desktop"

  /** Desktop OS (Tauri only) */
  os?: "macos" | "windows" | "linux"

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link) */
  notify(title: string, description?: string, href?: string): Promise<void>

  /** Open directory picker dialog (native on Tauri, server-backed on web) */
  openDirectoryPickerDialog?(opts?: {
    title?: string
    multiple?: boolean
    serverUrl?: string
  }): Promise<string | string[] | null>

  /** Open native file picker dialog (Tauri only) */
  openFilePickerDialog?(opts?: { title?: string; multiple?: boolean }): Promise<string | string[] | null>

  /** Save file picker dialog (Tauri only) */
  saveFilePickerDialog?(opts?: { title?: string; defaultPath?: string }): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check the installation's release channel for a newer version. */
  checkUpdate?(options?: { refresh?: boolean }): Promise<{ updateAvailable: boolean; version?: string }>

  /** Install the latest update through the local OpenScience server */
  update?(): Promise<{
    installed: boolean
    restartRequired: boolean
    restartScheduled: boolean
    version?: string
  }>

  /** Desktop update lifecycle. Download/verification is separate from the
   *  explicit restart so active research and unsent drafts are never cut off. */
  updateState?(): Promise<DesktopUpdateState>
  stageUpdate?(): Promise<DesktopUpdateState>
  applyUpdate?(): Promise<DesktopUpdateState>
  cancelUpdate?(): Promise<DesktopUpdateState>

  /** Load recent OpenScience release notes on demand in Settings */
  listUpdates?(): Promise<Array<{ version: string; name: string; notes: string; publishedAt?: string; url: string }>>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServerUrl?(): Promise<string | null> | string | null

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServerUrl?(url: string | null): Promise<void> | void

  /** Parse markdown to HTML using native parser (desktop only, returns unprocessed code blocks) */
  parseMarkdown?(markdown: string): Promise<string>
}

export type DesktopUpdateState = {
  phase:
    | "idle"
    | "downloading"
    | "extracting"
    | "verifying"
    | "ready"
    | "restarting"
    | "restart_blocked"
    | "succeeded"
    | "failed"
  version?: string
  transferred?: number
  total?: number
  progress?: number
  completed_at?: string
  error?: string
  migration_required?: boolean
}

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
