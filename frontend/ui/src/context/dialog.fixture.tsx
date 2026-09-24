import { DialogProvider, useDialog } from "./dialog"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createResource, Show } from "solid-js"

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

export const accessible = (name: string, ready: Promise<boolean>) => () => {
  const [loaded] = createResource(() => ready)
  return (
    <Show when={loaded()}>
      <Kobalte.Content aria-label={name}>
        <input aria-label={`${name} input`} />
      </Kobalte.Content>
    </Show>
  )
}
