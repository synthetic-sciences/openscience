import { Toast, showToast, toaster, type ToastVariant } from "@synsci/ui/toast"
import { onCleanup } from "solid-js"
import { onPersistFailure, onPersistRecovered, type PersistFailure } from "@/utils/persist"

type ToastKind = "info" | "success" | "warning" | "error"

interface ToastInput {
  title: string
  description?: string
  kind: ToastKind
  ttl_ms?: number
}

const variantFor: Record<ToastKind, ToastVariant> = {
  info: "default",
  success: "success",
  warning: "default",
  error: "error",
}

const iconFor = {
  success: "circle-check",
  error: "circle-x",
} as const

function sentenceCase(value: string) {
  return value.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase())
}

export const toast = {
  push(input: ToastInput) {
    const persistent = input.ttl_ms === 0
    return showToast({
      variant: variantFor[input.kind],
      icon: input.kind === "success" ? iconFor.success : input.kind === "error" ? iconFor.error : undefined,
      title: sentenceCase(input.title),
      description: input.description,
      duration: persistent ? undefined : (input.ttl_ms ?? 4500),
      persistent,
    })
  },
  dismiss(id: number) {
    toaster.dismiss(id)
  },
  info(title: string, description?: string) {
    return toast.push({ kind: "info", title, description })
  },
  success(title: string, description?: string) {
    return toast.push({ kind: "success", title, description })
  },
  warning(title: string, description?: string) {
    return toast.push({ kind: "warning", title, description })
  },
  error(title: string, description?: string) {
    return toast.push({ kind: "error", title, description })
  },
}

let persistFailureToast: number | undefined
let persistFailureContainers = 0
let stopPersistWatch: (() => void) | undefined
const failingStores = new Set<string>()

function showPersistFailure(failure: PersistFailure) {
  failingStores.add(failure.key)
  // One message covers every failing store, and re-pushing it for the second
  // would only restart its entrance animation.
  if (persistFailureToast !== undefined) return
  persistFailureToast = toast.push({
    kind: "error",
    title: "Not saved in this browser",
    description:
      "This tab holds more than browser storage allows, most likely a large attachment. Remove it to start saving again; anything unsaved may be lost.",
    ttl_ms: 0,
  })
}

function dismissPersistFailure() {
  if (persistFailureToast === undefined) return
  toast.dismiss(persistFailureToast)
  persistFailureToast = undefined
}

function clearPersistFailure(key: string) {
  failingStores.delete(key)
  // The message asks the reader to free up room. Once they have, it is telling
  // them to do something they already did, so take it back.
  if (failingStores.size > 0) return
  dismissPersistFailure()
}

function connectPersistFailures() {
  persistFailureContainers++
  stopPersistWatch ??= (() => {
    const offFailure = onPersistFailure(showPersistFailure)
    const offRecovered = onPersistRecovered(clearPersistFailure)
    return () => {
      offFailure()
      offRecovered()
    }
  })()

  return () => {
    persistFailureContainers--
    if (persistFailureContainers > 0) return

    stopPersistWatch?.()
    stopPersistWatch = undefined
    failingStores.clear()
    dismissPersistFailure()
  }
}

/**
 * One region serves both the legacy `toast.*` facade and direct `showToast`
 * calls. Kobalte owns live-region semantics, pause-on-hover/focus, dismissal,
 * swipe handling, and the labelled 32px close control.
 */
export function ToastContainer() {
  // A refused write is otherwise silent data loss: the state looks saved and
  // then is not, so this one stays until acknowledged.
  onCleanup(connectPersistFailures())

  return <Toast.Region aria-label="Notifications" />
}
