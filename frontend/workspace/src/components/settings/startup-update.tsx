import { createEffect, onCleanup, type Component } from "solid-js"
import { showToast } from "@synsci/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { URLS } from "@/config/urls"

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
  const language = useLanguage()
  let queued = false
  let cancel = () => {}

  createEffect(() => {
    if (queued || !settings.ready()) return
    queued = true
    cancel = queueStartupUpdateCheck({
      enabled: settings.updates.startup(),
      check: platform.checkUpdate,
      notify: (result) => {
        showToast({
          persistent: true,
          icon: "download",
          title: language.t("toast.update.title"),
          description: language.t("toast.update.description", { version: result.version ?? "" }),
          actions: [
            {
              label: language.t("settings.general.row.releaseNotes.title"),
              onClick: () => platform.openLink(URLS.releases),
            },
            {
              label: language.t("toast.update.action.notYet"),
              onClick: "dismiss",
            },
          ],
        })
      },
    })
  })

  onCleanup(() => cancel())
  return null
}

export default StartupUpdateCheck
