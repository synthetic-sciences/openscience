import { createSignal, type JSX } from "solid-js"
import { Button } from "@synsci/ui/button"
import { Dialog as ModalDialog } from "@synsci/ui/dialog"
import { TextField } from "@synsci/ui/text-field"
import { useDialog } from "@synsci/ui/context/dialog"

type DialogController = ReturnType<typeof useDialog>

const actions: JSX.CSSProperties = {
  display: "flex",
  "justify-content": "flex-end",
  gap: "8px",
  padding: "4px 20px 20px",
}

/** Promise-based, focus-contained alternatives to browser confirm/prompt/alert. */
export function confirmDialog(
  dialog: DialogController,
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
        <ModalDialog
          fit
          transition
          role={opts.danger ? "alertdialog" : "dialog"}
          title={opts.title}
          description={opts.message}
        >
          <div style={actions}>
            <Button autofocus size="normal" variant="secondary" onClick={() => done(false)}>
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
        </ModalDialog>
      ),
      { onClose: () => done(false) },
    )
  })
}

export function promptDialog(
  dialog: DialogController,
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
        <ModalDialog fit transition title={opts.title} description={opts.message}>
          <div style={{ padding: "4px 20px 16px" }}>
            <TextField
              autofocus
              hideLabel
              label={opts.title}
              value={value()}
              placeholder={opts.placeholder}
              onChange={setValue}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key !== "Enter") return
                event.preventDefault()
                done(value())
              }}
            />
          </div>
          <div style={actions}>
            <Button size="normal" variant="secondary" onClick={() => done(null)}>
              Cancel
            </Button>
            <Button size="normal" variant="primary" onClick={() => done(value())}>
              {opts.confirmLabel ?? "OK"}
            </Button>
          </div>
        </ModalDialog>
      ),
      { onClose: () => done(null) },
    )
  })
}

export function alertDialog(
  dialog: DialogController,
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
        <ModalDialog
          fit
          transition
          role={opts.danger ? "alertdialog" : "dialog"}
          title={opts.title}
          description={opts.message}
        >
          <div style={actions}>
            <Button autofocus size="normal" variant="primary" onClick={done}>
              OK
            </Button>
          </div>
        </ModalDialog>
      ),
      { onClose: done },
    )
  })
}
