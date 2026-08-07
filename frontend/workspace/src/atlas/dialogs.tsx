import { createSignal, Show, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { useDialog } from "@synsci/ui/context/dialog"
import { FONT_CODE } from "@/styles/tokens"

type Dialog = ReturnType<typeof useDialog>

/**
 * Promise-based replacements for window.confirm / window.prompt / window.alert
 * that render inside the app's dialog portal so they match the atlas UI and
 * don't reflow or steal focus the way native dialogs do.
 */

function card(): JSX.CSSProperties {
  return {
    width: "420px",
    "max-width": "92vw",
    background: "var(--color-surface-solid)",
    border: "1px solid var(--color-border-strong)",
    "border-radius": "var(--radius-xl)",
    "box-shadow": "var(--shadow-md)",
    overflow: "hidden",
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
            <div class="text-16-medium text-text-strong">{opts.title}</div>
            <Show when={opts.message}>
              <div
                class="text-13-regular text-text-weak"
                style={{
                  "margin-top": "8px",
                  "max-width": "58ch",
                  "text-wrap": "pretty",
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
            <Button size="normal" variant="secondary" onClick={() => done(false)}>
              {opts.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              size="normal"
              variant="primary"
              classList={{ "atlas-dialog__danger": opts.danger === true }}
              onClick={() => done(true)}
            >
              {opts.confirmLabel ?? "Confirm"}
            </Button>
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
            <div class="text-16-medium text-text-strong">{opts.title}</div>
            <Show when={opts.message}>
              <div
                class="text-13-regular text-text-weak"
                style={{
                  "margin-top": "8px",
                  "max-width": "58ch",
                  "text-wrap": "pretty",
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
                "font-family": FONT_CODE,
                "font-size": "12px",
                "line-height": "18px",
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
            <Button size="normal" variant="secondary" onClick={() => done(null)}>
              Cancel
            </Button>
            <Button size="normal" variant="primary" onClick={() => done(value())}>
              {opts.confirmLabel ?? "OK"}
            </Button>
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
              class="text-16-medium text-text-strong"
              style={{ color: opts.danger ? "var(--color-error, #ef4444)" : undefined }}
            >
              {opts.title}
            </div>
            <Show when={opts.message}>
              <div
                class="text-13-regular text-text-weak"
                style={{
                  "margin-top": "8px",
                  "max-width": "58ch",
                  "text-wrap": "pretty",
                }}
              >
                {opts.message}
              </div>
            </Show>
          </div>
          <div style={{ display: "flex", "justify-content": "flex-end", padding: "12px 20px 18px" }}>
            <Button
              size="normal"
              variant="primary"
              classList={{ "atlas-dialog__danger": opts.danger === true }}
              onClick={done}
            >
              OK
            </Button>
          </div>
        </div>
      ),
      { onClose: () => done(), lite: true },
    )
  })
}
