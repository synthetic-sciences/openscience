import { Show, createEffect, createMemo, onCleanup, type Component } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { UpdateRefused } from "@/utils/update-error"
import { usePlatform, type DesktopUpdateState } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { DialogSettings } from "@/components/dialog-settings"
import { URLS } from "@/config/urls"
import { formatUpdateBytes, offeredUpdate, updateController } from "./update-controller"
import "./startup-update.css"

type UpdateResult = { updateAvailable: boolean; version?: string }

type NoticeState = Pick<
  DesktopUpdateState,
  "phase" | "version" | "transferred" | "total" | "completed_at" | "error" | "migration_required"
> & { available?: string }

export type UpdateNotice = {
  kind: "available" | "preparing" | "ready" | "restarting" | "blocked" | "failed" | "succeeded"
  title: string
  detail?: string
  /** Undefined when the notice has nothing for the person to start. */
  primary?: { label: string; busy: boolean }
}

/**
 * What the surface's primary press actually does, so the copy never promises a
 * button this installation or this surface does not have:
 * `"download-and-restart"` is the launch notice's one press; `"download"` is
 * Customize → General, where the restart is a second press; `"installer"` is an
 * installation without in-app staging (off macOS, or an unpackaged build),
 * where the only thing to press opens the release page.
 */
export type UpdatePress = "download-and-restart" | "download" | "installer"

const offerCopy: Record<UpdatePress, (version: string) => { detail: string; label: string }> = {
  "download-and-restart": () => ({
    detail: "One press downloads and verifies the signed update, then restarts OpenScience.",
    label: "Download and restart",
  }),
  download: (version) => ({
    detail: "Download the signed update and restart when you are ready.",
    label: `Download ${version}`,
  }),
  installer: () => ({
    detail: "Get the installer from the releases page and reinstall to update.",
    label: "Download installer",
  }),
}

/**
 * What the notice says, and what pressing its primary action means. A release
 * the app can still move to outranks a finished update result: the result is
 * about a version already installed, the release is the one thing left to do.
 */
export function updateNotice(state: NoticeState, press: UpdatePress): UpdateNotice | undefined {
  const offered = offeredUpdate(state)
  if (offered) {
    const copy = offerCopy[press](offered)
    return {
      kind: "available",
      title: `OpenScience ${offered} is available`,
      detail: copy.detail,
      primary: { label: copy.label, busy: false },
    }
  }
  if (state.phase === "ready") {
    return {
      kind: "ready",
      title: `OpenScience ${state.version ?? state.available} is verified`,
      detail: state.migration_required
        ? "This copy is administrator-owned. OpenScience will install the verified update in your user Applications folder, then reopen there."
        : "Ready when you are. Restart only after your current work is finished.",
      primary: { label: state.migration_required ? "Move & restart" : "Restart to update", busy: false },
    }
  }
  if (state.phase === "succeeded") {
    return {
      kind: "succeeded",
      title: `Updated to OpenScience ${state.version}`,
      detail: "The signed update is installed and your workspace is healthy.",
    }
  }
  if (state.phase === "restarting") {
    return {
      kind: "restarting",
      title: `Restarting OpenScience ${state.version ?? ""}`.trim(),
      detail: "Finishing the update. OpenScience will reopen automatically.",
      primary: { label: "Restarting…", busy: true },
    }
  }
  if (state.phase === "restart_blocked") {
    return {
      kind: "blocked",
      title: "OpenScience is waiting to restart safely",
      detail: state.error ?? "Finish or close the active runtime, then retry the restart.",
      primary: { label: "Retry restart", busy: false },
    }
  }
  if (state.phase === "failed") {
    return {
      kind: "failed",
      title: "OpenScience could not prepare the update",
      detail: state.error,
      primary: { label: "Retry", busy: false },
    }
  }
  if (state.phase === "idle") return undefined
  return {
    kind: "preparing",
    title: `Preparing OpenScience ${state.version ?? state.available}`,
    detail:
      state.phase === "downloading"
        ? `${formatUpdateBytes(state.transferred)}${state.total ? ` of ${formatUpdateBytes(state.total)}` : ""} downloaded`
        : "Checking the signed, notarized app before restart.",
    primary: { label: "Preparing…", busy: true },
  }
}

/** The same notice as one sentence, for a surface with a single copy slot
 * (Customize → General's row description) rather than a title and a detail. */
export function updateNoticeLine(notice: UpdateNotice) {
  const detail = notice.detail?.trim()
  if (!detail) return `${notice.title}.`
  return `${notice.title}. ${/[.!?]$/.test(detail) ? detail : `${detail}.`}`
}

export function queueStartupUpdateCheck(input: {
  enabled: boolean
  check?: () => Promise<UpdateResult>
  notify: (result: UpdateResult) => void
  delayMs?: number
  schedule?: (run: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  cancel?: (handle: ReturnType<typeof setTimeout>) => void
}): () => void {
  if (!input.enabled || !input.check) return () => {}

  let active = true
  const schedule = input.schedule ?? ((run, delay) => setTimeout(run, delay))
  const cancel = input.cancel ?? clearTimeout
  const handle = schedule(() => {
    if (!active) return
    void input.check!()
      .then((result) => {
        if (active && result.updateAvailable) input.notify(result)
      })
      // A background update check must never turn a healthy launch into an
      // error surface. Manual "Check now" still reports failures explicitly.
      .catch(() => undefined)
  }, input.delayMs ?? 1_500)

  return () => {
    active = false
    cancel(handle)
  }
}

/**
 * Runs once per application launch, after persisted Settings have loaded and
 * outside the first-paint path. This is the real consumer for the General →
 * "Check for updates on startup" preference.
 */
export const StartupUpdateCheck: Component = () => {
  const platform = usePlatform()
  const settings = useSettings()
  const dialog = useDialog()
  const updates = updateController(platform)
  let queued = false
  let cancel = () => {}

  const restart = async () => {
    await updates.apply().catch(async (error: unknown) => {
      // Running agent turns are the one blocker the person can wave through:
      // the server pauses them with a named reason and continues them after
      // the restart. Offer that instead of a toast that leads nowhere.
      if (error instanceof UpdateRefused && error.pausable) {
        // Loaded here: the dialog helper pulls in client-only components,
        // and this module's pure helpers are imported in server-side tests.
        const { confirmDialog } = await import("@/atlas/dialogs")
        const ok = await confirmDialog(dialog, {
          title: "Pause running work and restart?",
          message: (
            <>
              {error.blockers.join(", ")} still running. Restarting now pauses each turn; OpenScience continues them
              where they stopped once it is back. Compute jobs already on Modal keep running.
            </>
          ),
          confirmLabel: "Pause and restart",
          cancelLabel: "Not yet",
        })
        if (!ok) return
        await updates.apply({ mode: "now" }).catch((again: unknown) => {
          showToast({
            variant: "error",
            title: "OpenScience could not restart",
            description: again instanceof Error ? again.message : String(again),
          })
        })
        return
      }
      showToast({
        variant: "error",
        title: "OpenScience is still running",
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  // One press covers the whole update: the download runs in the background and
  // the restart follows the moment the staged bundle is verified. Without
  // in-app staging there is no such press, so the notice offers the release
  // page instead and says so.
  const action = async () => {
    if (!platform.stageUpdate) return platform.openLink(URLS.releases)
    await updates.downloadAndRestart(restart).catch((error: unknown) => {
      showToast({
        variant: "error",
        title: "Update failed",
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const cancelUpdate = async () => {
    await updates.cancel().catch((error: unknown) => {
      showToast({
        variant: "error",
        title: "OpenScience kept the update",
        description: error instanceof Error ? error.message : String(error),
      })
    })
  }

  createEffect(() => {
    if (queued || !settings.ready()) return
    queued = true
    updates.start()
    cancel = queueStartupUpdateCheck({
      enabled: settings.updates.startup(),
      check: () => updates.check(true).then((result) => result ?? { updateAvailable: false }),
      notify: () => undefined,
    })
  })

  onCleanup(() => cancel())
  const notice = createMemo(() =>
    updateNotice(updates.state, platform.stageUpdate ? "download-and-restart" : "installer"),
  )
  return (
    <Show when={!updates.state.dismissed && notice()}>
      <aside
        class="startup-update"
        data-phase={updates.state.phase}
        aria-label="OpenScience update"
        aria-live="polite"
        aria-busy={notice()?.primary?.busy === true}
      >
        <span class="startup-update__icon" aria-hidden="true">
          <Icon name="download" size="small" />
        </span>
        <span class="startup-update__copy">
          <strong>{notice()?.title}</strong>
          <small>{notice()?.detail}</small>
          <Show when={updates.state.progress !== undefined && updates.state.phase === "downloading"}>
            <progress max="1" value={updates.state.progress} aria-label="Update download progress" />
          </Show>
        </span>
        <Show when={notice()?.primary}>
          <Button size="small" variant="primary" disabled={notice()?.primary?.busy} onClick={() => void action()}>
            {notice()?.primary?.label}
          </Button>
        </Show>
        <Show
          when={
            platform.cancelUpdate && ["downloading", "extracting", "verifying", "ready"].includes(updates.state.phase)
          }
        >
          <Button
            size="small"
            variant="secondary"
            disabled={updates.state.cancelling}
            onClick={() => void cancelUpdate()}
          >
            {updates.state.cancelling ? "Discarding…" : updates.state.phase === "ready" ? "Discard" : "Cancel download"}
          </Button>
        </Show>
        <Show when={notice()?.kind === "available"}>
          <Button size="small" variant="secondary" onClick={() => updates.dismiss()}>
            Later
          </Button>
        </Show>
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            // A failed staging leaves the release page as the way out. Without
            // staging the primary action is already that page, so this button
            // stays the one that opens the notes.
            if (platform.stageUpdate && updates.state.phase === "failed") {
              platform.openLink(URLS.releases)
              return
            }
            dialog.show(() => <DialogSettings initial="general" />)
          }}
        >
          {platform.stageUpdate && updates.state.phase === "failed" ? "Download installer" : "What's new"}
        </Button>
        <Show when={!["restarting", "restart_blocked"].includes(updates.state.phase)}>
          <button
            type="button"
            class="startup-update__dismiss"
            aria-label="Dismiss update notice"
            onClick={() => updates.dismiss()}
          >
            <Icon name="close" size="small" />
          </button>
        </Show>
      </aside>
    </Show>
  )
}
