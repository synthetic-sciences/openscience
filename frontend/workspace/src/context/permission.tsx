import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createSimpleContext } from "@synsci/ui/context"
import type { PermissionRequest } from "@synsci/sdk/v2/client"
import { Persist, persisted } from "@/utils/persist"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "./global-sync"
import { useParams } from "@solidjs/router"
import { base64Encode } from "@synsci/util/encode"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { playSound, preloadSound, soundSrc } from "@/utils/sound"
import { projectForDirectory, projectHref, projectScope, resolveProjectRoute } from "@/utils/project-route"

type PermissionRespondFn = (input: {
  sessionID: string
  permissionID: string
  response: "once" | "session" | "project" | "always" | "reject"
  directory?: string
}) => void

function shouldAutoAccept(perm: PermissionRequest) {
  return perm.permission === "edit"
}

function isNonAllowRule(rule: unknown) {
  if (!rule) return false
  if (typeof rule === "string") return rule !== "allow"
  if (typeof rule !== "object") return false
  if (Array.isArray(rule)) return false

  for (const action of Object.values(rule)) {
    if (action !== "allow") return true
  }

  return false
}

function hasAutoAcceptPermissionConfig(permission: unknown) {
  if (!permission) return false
  if (typeof permission === "string") return permission !== "allow"
  if (typeof permission !== "object") return false
  if (Array.isArray(permission)) return false

  const config = permission as Record<string, unknown>
  if (isNonAllowRule(config.edit)) return true
  if (isNonAllowRule(config.write)) return true

  return false
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const params = useParams()
    const globalSDK = useGlobalSDK()
    const globalSync = useGlobalSync()
    const language = useLanguage()
    const platform = usePlatform()
    const settings = useSettings()

    const permissionsEnabled = createMemo(() => {
      const route = resolveProjectRoute(params.dir, globalSync.data.project)
      if (!route) return false
      const [store] = globalSync.child(route.directory, { projectID: route.projectID })
      return hasAutoAcceptPermissionConfig(store.config.permission)
    })

    const [store, setStore, _, ready] = persisted(
      Persist.global("permission", ["permission.v3"]),
      createStore({
        autoAcceptEdits: {} as Record<string, boolean>,
      }),
    )

    const MAX_RESPONDED = 1000
    const RESPONDED_TTL_MS = 60 * 60 * 1000
    const responded = new Map<string, number>()

    createEffect(() => {
      if (!settings.sounds.enabled()) return
      preloadSound(soundSrc(settings.sounds.permissions()))
    })

    function pruneResponded(now: number) {
      for (const [id, ts] of responded) {
        if (now - ts < RESPONDED_TTL_MS) break
        responded.delete(id)
      }

      for (const id of responded.keys()) {
        if (responded.size <= MAX_RESPONDED) break
        responded.delete(id)
      }
    }

    const respond: PermissionRespondFn = (input) => {
      globalSDK.client.permission.respond(input).catch(() => {
        responded.delete(input.permissionID)
      })
    }

    function respondOnce(permission: PermissionRequest, directory?: string) {
      const now = Date.now()
      const hit = responded.has(permission.id)
      responded.delete(permission.id)
      responded.set(permission.id, now)
      pruneResponded(now)
      if (hit) return
      respond({
        sessionID: permission.sessionID,
        permissionID: permission.id,
        response: "once",
        directory,
      })
    }

    function acceptKey(sessionID: string, directory?: string) {
      if (!directory) return sessionID
      return `${projectScope(globalSync.data.project, directory)}/${sessionID}`
    }

    function isAutoAccepting(sessionID: string, directory?: string) {
      const key = acceptKey(sessionID, directory)
      const legacy = directory ? `${base64Encode(directory)}/${sessionID}` : undefined
      return store.autoAcceptEdits[key] ?? (legacy ? store.autoAcceptEdits[legacy] : undefined) ?? false
    }

    const unsubscribe = globalSDK.event.listen((e) => {
      const event = e.details
      if (event?.type !== "permission.asked") return

      const perm = event.properties
      if (isAutoAccepting(perm.sessionID, e.name) && shouldAutoAccept(perm)) {
        respondOnce(perm, e.name)
        return
      }

      if (settings.sounds.enabled()) {
        playSound(soundSrc(settings.sounds.permissions()), settings.sounds.volume())
      }

      if (settings.notifications.permissions()) {
        const project = projectForDirectory(globalSync.data.project, e.name)
        const [syncStore] = globalSync.child(e.name, { bootstrap: false })
        const session = syncStore.session.find((item) => item.id === perm.sessionID)
        const projectName =
          ((project as { name?: string } | undefined)?.name || e.name.split(/[\\/]/).filter(Boolean).at(-1)) ??
          project?.id ??
          "OpenScience"
        const description = language.t("notification.permission.description", {
          sessionTitle: session?.title ?? perm.sessionID,
          projectName,
        })
        const href = project ? projectHref(project, e.name, perm.sessionID) : "/"
        void platform.notify(language.t("notification.permission.title"), description, href)
      }
    })
    onCleanup(unsubscribe)

    function enable(sessionID: string, directory: string) {
      const key = acceptKey(sessionID, directory)
      setStore(
        produce((draft) => {
          draft.autoAcceptEdits[key] = true
          delete draft.autoAcceptEdits[sessionID]
        }),
      )

      globalSDK.client.permission
        .list({ directory })
        .then((x) => {
          for (const perm of x.data ?? []) {
            if (!perm?.id) continue
            if (perm.sessionID !== sessionID) continue
            if (!shouldAutoAccept(perm)) continue
            respondOnce(perm, directory)
          }
        })
        .catch(() => undefined)
    }

    function disable(sessionID: string, directory?: string) {
      const key = directory ? acceptKey(sessionID, directory) : undefined
      setStore(
        produce((draft) => {
          if (key) delete draft.autoAcceptEdits[key]
          delete draft.autoAcceptEdits[sessionID]
        }),
      )
    }

    return {
      ready,
      respond,
      autoResponds(permission: PermissionRequest, directory?: string) {
        return isAutoAccepting(permission.sessionID, directory) && shouldAutoAccept(permission)
      },
      isAutoAccepting,
      toggleAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) {
          disable(sessionID, directory)
          return
        }

        enable(sessionID, directory)
      },
      enableAutoAccept(sessionID: string, directory: string) {
        if (isAutoAccepting(sessionID, directory)) return
        enable(sessionID, directory)
      },
      disableAutoAccept(sessionID: string, directory?: string) {
        disable(sessionID, directory)
      },
      permissionsEnabled,
    }
  },
})
