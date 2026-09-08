import { DialogProvider, useDialog } from "./dialog"

export type DialogHandle = ReturnType<typeof useDialog>

/** Mounts the provider and hands the test a controller from inside it. */
export function createDialogFixture(onReady: (dialog: DialogHandle) => void) {
  const Probe = () => {
    onReady(useDialog())
    return <span data-probe />
  }
  return () => (
    <DialogProvider>
      <Probe />
    </DialogProvider>
  )
}

export const panel = (name: string) => () => <div data-dialog-panel={name}>{name}</div>
