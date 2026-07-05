import { createSignal, Show, type JSX } from "solid-js"
import { useDialog } from "@synsci/ui/context/dialog"
import { FONT_MONO, FONT_SANS, FONT_SERIF } from "@/styles/tokens"

type Dialog = ReturnType<typeof useDialog>

/**
 * Promise-based replacements for window.confirm / window.prompt / window.alert
 * that render inside the app's dialog portal so they match the thesis UI and
 * don't reflow or steal focus the way native dialogs do.
 */

function card(): JSX.CSSProperties {
  return {
    width: "420px",
    "max-width": "92vw",
    background: "var(--color-surface-solid)",
    border: "1px solid var(--color-border-strong)",
    "border-radius": "4px",
    "box-shadow": "var(--shadow-md)",
    overflow: "hidden",
  }
}

function actionBtn(primary = false, danger = false): JSX.CSSProperties {
  return {
    all: "unset",
    cursor: "pointer",
    padding: "7px 14px",
    "border-radius": "4px",
    border: primary ? "1px solid var(--color-accent)" : "1px solid var(--color-border)",
    background: danger ? "var(--color-error, #ef4444)" : primary ? "var(--color-accent)" : "var(--color-bg-elevated)",
    color: danger || primary ? "var(--color-on-accent)" : "var(--color-text)",
    "font-family": FONT_MONO,
    "font-size": "12px",
    "font-weight": 500,
  }
}

export function confirmDialog(
  dialog: Dialog,
  opts: { title: string; message?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
      dialog.close()
    }
    dialog.show(
      () => (
        <div style={card()}>
          <div style={{ padding: "18px 20px 8px" }}>
            <div style={{ "font-family": FONT_SERIF, "font-size": "19px", color: "var(--color-text)" }}>
              {opts.title}
            </div>
            <Show when={opts.message}>
              <div
                style={{
                  "margin-top": "8px",
                  "font-family": FONT_SANS,
                  "font-size": "13px",
                  color: "var(--color-text-muted)",
                  "line-height": 1.5,
                }}
              >
                {opts.message}
              </div>
            </Show>
          </div>
          <div
            style={{
              display: "flex",
              "justify-content": "flex-end",
              gap: "8px",
              padding: "12px 20px 18px",
            }}
          >
            <button type="button" style={actionBtn(false)} onClick={() => done(false)}>
              {opts.cancelLabel ?? "cancel"}
            </button>
            <button type="button" style={actionBtn(true, opts.danger)} onClick={() => done(true)}>
              {opts.confirmLabel ?? "confirm"}
            </button>
          </div>
        </div>
      ),
      { onClose: () => done(false), lite: true },
    )
  })
}

export function promptDialog(
  dialog: Dialog,
  opts: { title: string; message?: string; placeholder?: string; initial?: string; confirmLabel?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      resolve(value)
      dialog.close()
    }
    const [value, setValue] = createSignal(opts.initial ?? "")
    dialog.show(
      () => (
        <div style={card()}>
          <div style={{ padding: "18px 20px 8px" }}>
            <div style={{ "font-family": FONT_SERIF, "font-size": "19px", color: "var(--color-text)" }}>
              {opts.title}
            </div>
            <Show when={opts.message}>
              <div
                style={{
                  "margin-top": "8px",
                  "font-family": FONT_SANS,
                  "font-size": "13px",
                  color: "var(--color-text-muted)",
                  "line-height": 1.5,
                }}
              >
                {opts.message}
              </div>
            </Show>
            <input
              autofocus
              value={value()}
              placeholder={opts.placeholder}
              onInput={(e) => setValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") done(value())
              }}
              style={{
                all: "unset",
                "box-sizing": "border-box",
                width: "100%",
                "margin-top": "12px",
                padding: "9px 10px",
                border: "1px solid var(--color-border)",
                "border-radius": "4px",
                background: "var(--color-bg)",
                color: "var(--color-text)",
                "font-family": FONT_MONO,
                "font-size": "12px",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              "justify-content": "flex-end",
              gap: "8px",
              padding: "12px 20px 18px",
            }}
          >
            <button type="button" style={actionBtn(false)} onClick={() => done(null)}>
              cancel
            </button>
            <button type="button" style={actionBtn(true)} onClick={() => done(value())}>
              {opts.confirmLabel ?? "ok"}
            </button>
          </div>
        </div>
      ),
      { onClose: () => done(null), lite: true },
    )
  })
}

export function alertDialog(
  dialog: Dialog,
  opts: { title: string; message?: string; danger?: boolean },
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
      dialog.close()
    }
    dialog.show(
      () => (
        <div style={card()}>
          <div style={{ padding: "18px 20px 8px" }}>
            <div
              style={{
                "font-family": FONT_SERIF,
                "font-size": "19px",
                color: opts.danger ? "var(--color-error, #ef4444)" : "var(--color-text)",
              }}
            >
              {opts.title}
            </div>
            <Show when={opts.message}>
              <div
                style={{
                  "margin-top": "8px",
                  "font-family": FONT_SANS,
                  "font-size": "13px",
                  color: "var(--color-text-muted)",
                  "line-height": 1.5,
                }}
              >
                {opts.message}
              </div>
            </Show>
          </div>
          <div style={{ display: "flex", "justify-content": "flex-end", padding: "12px 20px 18px" }}>
            <button type="button" style={actionBtn(true)} onClick={done}>
              ok
            </button>
          </div>
        </div>
      ),
      { onClose: () => done(), lite: true },
    )
  })
}
