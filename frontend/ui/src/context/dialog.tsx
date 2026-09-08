import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  For,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  Suspense,
  useContext,
  type JSX,
} from "solid-js"
import { Dialog as Kobalte } from "@kobalte/core/dialog"

type DialogElement = () => JSX.Element

type Active = {
  id: string
  node: JSX.Element
  dispose: () => void
  owner: Owner
  onClose?: () => void
  setClosing: (closing: boolean) => void
}

export interface ShowOptions {
  onClose?: () => void
  /**
   * Open above the current dialog instead of replacing it. Closing the
   * stacked dialog returns to the one underneath with its state intact, so a
   * confirmation raised from inside Settings does not throw the user out of
   * Settings.
   */
  stack?: boolean
}

const Context = createContext<ReturnType<typeof init>>()

function init() {
  const [stack, setStack] = createSignal<Active[]>([])
  const active = () => stack().at(-1)
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }

  onCleanup(() => {
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const close = () => {
    const current = active()
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    const id = current.id
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    timer.current = setTimeout(() => {
      timer.current = undefined
      current.dispose()
      setStack((items) => items.filter((item) => item.id !== id))
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    if (!active()) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      const target = event.target
      if (target instanceof Element && target.closest('[data-dialog-escape-scope="true"]')) return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  const show = (element: DialogElement, owner: Owner, onClose?: () => void, options?: { stack?: boolean }) => {
    // A dialog still animating shut cannot be stacked on; finish closing it.
    const stacked = options?.stack === true && active() !== undefined && !lock.value
    if (!stacked) {
      for (const item of stack()) item.dispose()
      setStack([])
    }

    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false

    const id = Math.random().toString(36).slice(2)
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              // Only the topmost dialog answers dismissal; the one underneath a
              // stacked dialog stays put until its turn.
              if (active()?.id !== id) return
              close()
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay data-component="dialog-overlay" onClick={close} />
              <Suspense fallback={null}>{element()}</Suspense>
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    const entry: Active = { id, node, dispose, owner, onClose, setClosing }
    setStack((items) => [...items, entry])
  }

  return {
    get active() {
      return active()
    },
    get stack() {
      return stack()
    },
    close,
    show,
  }
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  return {
    get active() {
      return ctx.active
    },
    /**
     * Show a dialog. Pass a function for `optionsOrOnClose` to use just an
     * onClose callback (legacy two-arg form), or an options object.
     */
    show(element: DialogElement, optionsOrOnClose?: (() => void) | ShowOptions) {
      const base = ctx.active?.owner ?? owner
      const opts: ShowOptions =
        typeof optionsOrOnClose === "function" ? { onClose: optionsOrOnClose } : (optionsOrOnClose ?? {})
      ctx.show(element, base, opts.onClose, { stack: opts.stack })
    },
    close() {
      ctx.close()
    },
  }
}
