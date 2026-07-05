import {
  createContext,
  createEffect,
  createRoot,
  createSignal,
  getOwner,
  onCleanup,
  Show,
  type Owner,
  type ParentProps,
  runWithOwner,
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
   * Lightweight, non-modal presentation: no backdrop overlay and no body
   * scroll lock (so opening the dialog doesn't visibly reflow the page).
   * The dialog content still mounts inside a portal and dismisses on its
   * own controls — it just doesn't dim/lock the page behind it.
   */
  lite?: boolean
}

const Context = createContext<ReturnType<typeof init>>()

const LiteContext = createContext<boolean>(false)

/**
 * True when the surrounding dialog was opened in `lite` mode (no backdrop,
 * no scroll lock, no Kobalte focus-trap). Used by `<Dialog>` to render its
 * content as a plain `<div>` instead of `Kobalte.Content`, which would
 * otherwise throw without a Kobalte root.
 */
export function useDialogLite(): boolean {
  return useContext(LiteContext)
}

function init() {
  const [active, setActive] = createSignal<Active | undefined>()
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
      if (active()?.id === id) setActive(undefined)
      lock.value = false
    }, 100)
  }

  createEffect(() => {
    if (!active()) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      close()
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener("keydown", onKeyDown, true)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown, true))
  })

  const show = (element: DialogElement, owner: Owner, onClose?: () => void, options?: { lite?: boolean }) => {
    // Immediately dispose any existing dialog when showing a new one
    const current = active()
    if (current) {
      current.dispose()
      setActive(undefined)
    }

    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    lock.value = false

    const id = Math.random().toString(36).slice(2)
    let dispose: (() => void) | undefined
    let setClosing: ((closing: boolean) => void) | undefined

    const lite = options?.lite === true

    const node = runWithOwner(owner, () =>
      createRoot((d: () => void) => {
        dispose = d
        const [closing, setClosingSignal] = createSignal(false)
        setClosing = setClosingSignal
        // Lite mode bypasses Kobalte entirely. Kobalte's modal Dialog mounts
        // a Portal at <body>, adds focus-trap attributes, and (even with
        // modal={false}) momentarily reshuffles body siblings during mount,
        // which read as a page "refresh" the instant the dialog appears.
        // Rendering inside the existing dialog-stack with no portal removes
        // every body-level side effect — the element just appears in place.
        if (lite) {
          return (
            <Show when={!closing()}>
              <LiteContext.Provider value={true}>
                <div
                  data-component="dialog-lite"
                  style={{
                    position: "fixed",
                    inset: "0",
                    "z-index": "50",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    "pointer-events": "none",
                  }}
                >
                  <div data-slot="dialog-lite-content" style={{ "pointer-events": "auto" }}>
                    {element()}
                  </div>
                </div>
              </LiteContext.Provider>
            </Show>
          )
        }
        return (
          <Kobalte
            modal
            open={!closing()}
            onOpenChange={(open: boolean) => {
              if (open) return
              close()
            }}
          >
            <Kobalte.Portal>
              <Kobalte.Overlay data-component="dialog-overlay" onClick={close} />
              {element()}
            </Kobalte.Portal>
          </Kobalte>
        )
      }),
    )

    if (!dispose || !setClosing) return

    setActive({ id, node, dispose, owner, onClose, setClosing })
  }

  return {
    get active() {
      return active()
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
      <div data-component="dialog-stack">{ctx.active?.node}</div>
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
     * onClose callback (legacy two-arg form), or an options object to opt
     * into features like `lite` (no backdrop, no scroll lock).
     */
    show(element: DialogElement, optionsOrOnClose?: (() => void) | ShowOptions) {
      const base = ctx.active?.owner ?? owner
      const opts: ShowOptions =
        typeof optionsOrOnClose === "function" ? { onClose: optionsOrOnClose } : (optionsOrOnClose ?? {})
      ctx.show(element, base, opts.onClose, { lite: opts.lite })
    },
    close() {
      ctx.close()
    },
  }
}
