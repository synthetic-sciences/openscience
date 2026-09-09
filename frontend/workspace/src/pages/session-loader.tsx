import { lazy } from "solid-js"

let pending: Promise<typeof import("@/pages/session-shell")> | undefined

const loadSession = () => {
  pending ??= import("@/pages/session-shell").catch((error) => {
    pending = undefined
    throw error
  })
  return pending
}

export const Session = lazy(loadSession)

export const preloadSession = () => {
  void loadSession().catch(() => undefined)
}
