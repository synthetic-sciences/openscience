import { Show, createEffect, onCleanup, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@synsci/ui/button"
import { Icon } from "@synsci/ui/icon"
import { useDialog } from "@synsci/ui/context/dialog"
import { showToast } from "@synsci/ui/toast"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { DialogSettings } from "@/components/dialog-settings"
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
  const [store, setStore] = createStore({
    available: undefined as string | undefined,
    dismissed: false,
    installing: false,
  })
  let queued = false
  let cancel = () => {}

  const install = async () => {
    if (!platform.update || store.installing) return
    setStore("installing", true)
    await platform
      .update()
      .then((result) => {
        if (!result.installed) {
          setStore({ dismissed: true, installing: false })
          showToast({
            variant: "success",
            icon: "circle-check",
            title: "OpenScience is up to date",
            description: "You're running the latest version of OpenScience.",
          })
          return
        }
        setStore("installing", false)
        showToast({
          variant: "success",
          icon: "circle-check",
          title: `OpenScience ${result.version ?? store.available ?? ""} installed`,
          description: result.restartScheduled
            ? "Restarting OpenScience now."
            : "Restart OpenScience once to finish the update.",
        })
      })
      .catch((error: unknown) => {
        setStore("installing", false)
        showToast({
          variant: "error",
          title: "Update failed",
          description: error instanceof Error ? error.message : String(error),
        })
      })
  }

  createEffect(() => {
    if (queued || !settings.ready()) return
    queued = true
    cancel = queueStartupUpdateCheck({
      enabled: settings.updates.startup(),
      check: platform.checkUpdate,
      notify: (result) => {
        setStore({ available: result.version ?? "latest", dismissed: false })
      },
    })
  })

  onCleanup(() => cancel())
  return (
    <Show when={store.available && !store.dismissed}>
      <aside class="startup-update" aria-label="OpenScience update available" aria-live="polite">
        <span class="startup-update__icon" aria-hidden="true">
          <Icon name="download" size="small" />
        </span>
        <span class="startup-update__copy">
          <strong>{`OpenScience ${store.available} is ready`}</strong>
          <small>Update and restart now, or review the release in Customize.</small>
        </span>
        <Show when={platform.update}>
          <Button size="small" variant="primary" disabled={store.installing} onClick={() => void install()}>
            {store.installing ? "Updating & restarting…" : "Update"}
          </Button>
        </Show>
        <Button
          size="small"
          variant="secondary"
          onClick={() => dialog.show(() => <DialogSettings initial="general" />)}
        >
          Customize
        </Button>
        <button
          type="button"
          class="startup-update__dismiss"
          aria-label="Dismiss update notice"
          onClick={() => setStore("dismissed", true)}
        >
          <Icon name="close" size="small" />
        </button>
      </aside>
    </Show>
  )
}

export default StartupUpdateCheck
