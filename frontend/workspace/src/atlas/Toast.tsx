import { Toast, showToast, toaster, type ToastVariant } from "@synsci/ui/toast"

export type ToastKind = "info" | "success" | "warning" | "error"

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

/**
 * One region serves both the legacy `toast.*` facade and direct `showToast`
 * calls. Kobalte owns live-region semantics, pause-on-hover/focus, dismissal,
 * swipe handling, and the labelled 32px close control.
 */
export function ToastContainer() {
  return <Toast.Region aria-label="Notifications" />
}
