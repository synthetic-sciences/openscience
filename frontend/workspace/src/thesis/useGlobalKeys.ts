import { onCleanup, onMount } from "solid-js"
import { useDialog } from "@synsci/ui/context/dialog"
import { uiStore } from "@/thesis/store/ui"

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === "input" || tag === "textarea" || target.isContentEditable
}

export function useGlobalKeys(input: { onNew?: () => void }) {
  const dialog = useDialog()
  const onKeyDown = (event: KeyboardEvent) => {
    if (dialog.active) return
    if (isTypingTarget(event.target)) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === "k") {
      event.preventDefault()
      uiStore.setPaletteOpen(true)
      return
    }
    if (event.key === "?") {
      event.preventDefault()
      uiStore.setHelpOpen(true)
      return
    }
    if (mod && key === "n" && input.onNew) {
      event.preventDefault()
      input.onNew()
    }
  }

  onMount(() => window.addEventListener("keydown", onKeyDown))
  onCleanup(() => window.removeEventListener("keydown", onKeyDown))
}
