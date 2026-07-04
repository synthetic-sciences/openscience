import { createSignal, type JSX, For, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { FONT_MONO, FONT_SANS } from "@/styles/tokens"
import { StatusDot, type StatusKind } from "@/thesis/shared/StatusDot"
import { IconX } from "@/thesis/shared/Icon"

export type ToastKind = "info" | "success" | "warning" | "error"

interface Toast {
  id: string
  title: string
  description?: string
  kind: ToastKind
  ttl_ms?: number
}

const [toasts, setToasts] = createSignal<Toast[]>([])

let nextId = 1

export const toast = {
  push(t: Omit<Toast, "id">) {
    const id = `toast-${nextId++}`
    const full: Toast = { ...t, id }
    setToasts((prev) => [...prev, full])
    const ttl = t.ttl_ms ?? 4500
    if (ttl > 0) {
      setTimeout(() => toast.dismiss(id), ttl)
    }
    return id
  },
  dismiss(id: string) {
    setToasts((prev) => prev.filter((t) => t.id !== id))
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

const statusFor: Record<ToastKind, StatusKind> = {
  info: "muted",
  success: "active",
  warning: "pending",
  error: "error",
}

export function ToastContainer(): JSX.Element {
  return (
    <Portal>
      <div
        style={{
          position: "fixed",
          bottom: "16px",
          right: "16px",
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          "z-index": 1000,
          "max-width": "380px",
          "pointer-events": "none",
        }}
      >
        <For each={toasts()}>
          {(t) => (
            <div
              class="thesis-slide-up"
              style={{
                background: "var(--color-surface-solid)",
                border: "1px solid var(--color-border)",
                "border-left":
                  t.kind === "error"
                    ? "3px solid var(--color-error)"
                    : t.kind === "warning"
                      ? "3px solid var(--color-warning)"
                      : t.kind === "success"
                        ? "3px solid var(--color-success)"
                        : "3px solid var(--color-text-faint)",
                "border-radius": "4px",
                "box-shadow": "var(--shadow-md)",
                padding: "10px 14px",
                display: "flex",
                gap: "10px",
                "align-items": "flex-start",
                "pointer-events": "auto",
                "min-width": "260px",
              }}
            >
              <StatusDot status={statusFor[t.kind]} pulse={t.kind === "warning"} />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    "font-family": FONT_MONO,
                    "font-size": "11.5px",
                    "font-weight": 500,
                    color: "var(--color-text)",
                  }}
                >
                  {t.title}
                </div>
                <Show when={t.description}>
                  <div
                    style={{
                      "font-family": FONT_SANS,
                      "font-size": "11.5px",
                      color: "var(--color-text-muted)",
                      "line-height": 1.5,
                      "margin-top": "2px",
                    }}
                  >
                    {t.description}
                  </div>
                </Show>
              </div>
              <button
                onClick={() => toast.dismiss(t.id)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  color: "var(--color-text-faint)",
                  display: "inline-flex",
                  padding: "2px",
                }}
              >
                <IconX size={11} strokeWidth={1.5} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Portal>
  )
}
