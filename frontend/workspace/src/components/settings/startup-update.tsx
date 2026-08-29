import { Show, createEffect, onCleanup, type Component } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { DialogSettings } from "@/components/dialog-settings"
import { URLS } from "@/config/urls"
import { formatUpdateBytes, updateController } from "./update-controller"
import "./startup-update.css"

type UpdateResult = { updateAvailable: boolean; version?: string }

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

  const action = async () => {
    const restarting = updates.state.phase === "ready" || updates.state.phase === "restart_blocked"
    const run = restarting ? updates.apply : updates.stage
    await run().catch((error: unknown) => {
      showToast({
        variant: "error",
        title: restarting ? "OpenScience is still running" : "Update failed",
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
  return (
    <Show when={!updates.state.dismissed && (updates.state.available || updates.state.phase !== "idle")}>
      <aside
        class="startup-update"
        data-phase={updates.state.phase}
        aria-label="OpenScience update"
        aria-live="polite"
        aria-busy={["downloading", "extracting", "verifying", "restarting"].includes(updates.state.phase)}
      >
        <span class="startup-update__icon" aria-hidden="true">
          <Icon name="download" size="small" />
        </span>
        <span class="startup-update__copy">
          <strong>
            {updates.state.phase === "ready"
              ? `OpenScience ${updates.state.version ?? updates.state.available} is verified`
              : updates.state.phase === "succeeded"
                ? `Updated to OpenScience ${updates.state.version}`
                : updates.state.phase === "restarting"
                  ? `Restarting OpenScience ${updates.state.version ?? ""}`.trim()
                  : updates.state.phase === "restart_blocked"
                    ? "OpenScience is waiting to restart safely"
                    : updates.state.phase === "failed"
                      ? "OpenScience could not prepare the update"
                      : ["downloading", "extracting", "verifying"].includes(updates.state.phase)
                        ? `Preparing OpenScience ${updates.state.version ?? updates.state.available}`
                        : `OpenScience ${updates.state.available} is available`}
          </strong>
          <small>
            {updates.state.phase === "ready"
              ? updates.state.migration_required
                ? "This copy is administrator-owned. OpenScience will install the verified update in your user Applications folder, then reopen there."
                : "Ready when you are. Restart only after your current work is finished."
              : updates.state.phase === "succeeded"
                ? "The signed update is installed and your workspace is healthy."
                : updates.state.phase === "restarting"
                  ? "Finishing the update. OpenScience will reopen automatically."
                  : updates.state.phase === "restart_blocked"
                    ? (updates.state.error ?? "Finish or close the active runtime, then retry the restart.")
                    : updates.state.phase === "failed"
                      ? updates.state.error
                      : updates.state.phase === "downloading"
                        ? `${formatUpdateBytes(updates.state.transferred)}${updates.state.total ? ` of ${formatUpdateBytes(updates.state.total)}` : ""} downloaded`
                        : ["extracting", "verifying"].includes(updates.state.phase)
                          ? "Checking the signed, notarized app before restart."
                          : "Download in the background, then choose when to restart."}
          </small>
          <Show when={updates.state.progress !== undefined && updates.state.phase === "downloading"}>
            <progress max="1" value={updates.state.progress} aria-label="Update download progress" />
          </Show>
        </span>
        <Show when={platform.stageUpdate && updates.state.phase !== "succeeded"}>
          <Button
            size="small"
            variant="primary"
            disabled={["downloading", "extracting", "verifying", "restarting"].includes(updates.state.phase)}
            onClick={() => void action()}
          >
            {updates.state.phase === "ready"
              ? updates.state.migration_required
                ? "Move & restart"
                : "Restart to update"
              : updates.state.phase === "restarting"
                ? "Restarting…"
                : updates.state.phase === "restart_blocked"
                  ? "Retry restart"
                  : updates.state.phase === "failed"
                    ? "Retry"
                    : ["downloading", "extracting", "verifying"].includes(updates.state.phase)
                      ? "Preparing…"
                      : "Download update"}
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
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            if (!platform.stageUpdate || updates.state.phase === "failed") {
              platform.openLink(URLS.releases)
              return
            }
            dialog.show(() => <DialogSettings initial="general" />)
          }}
        >
          {!platform.stageUpdate || updates.state.phase === "failed" ? "Download installer" : "What's new"}
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

export default StartupUpdateCheck
