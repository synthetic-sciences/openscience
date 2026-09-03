import type { Ghostty, Terminal as Term, FitAddon } from "ghostty-web"
import { ComponentProps, createEffect, createSignal, onCleanup, onMount, splitProps } from "solid-js"
import { useSDK } from "@/context/sdk"
import { monoFontFamily, useSettings } from "@/context/settings"
import { LocalPTY } from "@/context/terminal"
import { connectionError } from "./terminal-error"
import { resolveThemeVariant, useTheme, withAlpha, type HexColor } from "@synsci/ui/theme"
import { useLanguage } from "@/context/language"
import { showToast } from "@synsci/ui/toast"
import { terminalMatches, type TerminalMatch } from "./terminal-search"

export interface TerminalProps extends ComponentProps<"div"> {
  pty: LocalPTY
  active?: boolean
  onSubmit?: () => void
  onCleanup?: (pty: LocalPTY) => void
  onConnect?: () => void
  onConnectError?: (error: Error) => void
  onReady?: (controller?: TerminalController) => void
  onOpenSearch?: () => void
}

export type TerminalSearchResult = {
  current: number
  total: number
}

export type TerminalController = {
  focus: () => void
  clearSelection: () => void
  search: (query: string, direction?: "next" | "previous") => TerminalSearchResult
}

const REPLAY_REQUEST = "\0"
// SGR reset, erase the screen, erase the scrollback, home the cursor. Sent through the VT stream
// rather than Terminal.reset(): ghostty-web 0.3.0 frees and reallocates the wasm terminal there while
// the selection manager keeps the freed handle, which silently breaks copy after every reconnect.
const ERASE = "\x1b[0m\x1b[2J\x1b[3J\x1b[H"
const RECONNECT_LIMIT = 5

// Mirrors reconnectDelay in @/context/reconnecting-event-stream: 250 ms doubling to a 5 s cap.
// Returns undefined once the attempt budget is spent so the caller reports the loss instead.
export const backoff = (failures: number) =>
  failures > RECONNECT_LIMIT ? undefined : Math.min(250 * 2 ** Math.max(0, failures - 1), 5000)

let shared: Promise<{ mod: typeof import("ghostty-web"); ghostty: Ghostty }> | undefined

const loadGhostty = () => {
  if (shared) return shared
  shared = import("ghostty-web")
    .then(async (mod) => ({ mod, ghostty: await mod.Ghostty.load() }))
    .catch((err) => {
      shared = undefined
      throw err
    })
  return shared
}

export const preloadTerminal = () => {
  void loadGhostty().catch(() => {})
}

type TerminalColors = {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
}

const DEFAULT_TERMINAL_COLORS: Record<"light" | "dark", TerminalColors> = {
  light: {
    background: "#fcfcfc",
    foreground: "#211e1e",
    cursor: "#211e1e",
    selectionBackground: withAlpha("#211e1e", 0.2),
  },
  dark: {
    background: "#191515",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: withAlpha("#d4d4d4", 0.25),
  },
}

export const Terminal = (props: TerminalProps) => {
  const sdk = useSDK()
  const settings = useSettings()
  const theme = useTheme()
  const language = useLanguage()
  let container!: HTMLDivElement
  const [local, others] = splitProps(props, [
    "pty",
    "active",
    "class",
    "classList",
    "onConnect",
    "onConnectError",
    "onSubmit",
    "onCleanup",
    "onReady",
    "onOpenSearch",
  ])
  let term: Term | undefined
  let fitAddon: FitAddon | undefined
  let fitFrame: number | undefined
  let fitTimer: number | undefined
  let handleResize: () => void
  let handleTextareaFocus: () => void
  let handleTextareaBlur: () => void
  let disposed = false
  const cleanups: VoidFunction[] = []

  const cleanup = () => {
    if (!cleanups.length) return
    const fns = cleanups.splice(0).reverse()
    for (const fn of fns) {
      try {
        fn()
      } catch {
        // ignore
      }
    }
  }

  const fitTerminal = () => {
    const fit = fitAddon
    if (!fit || local.active === false) return
    fit.fit()
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    fitFrame = requestAnimationFrame(() => {
      fitFrame = undefined
      paintTerminal()
      if (fitTimer !== undefined) window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        fitTimer = undefined
        fit.fit()
        paintTerminal()
      }, 75)
    })
  }

  const paintTerminal = () => {
    const t = term
    if (!t?.renderer || !t.wasmTerm) return
    t.renderer.render(t.wasmTerm, true, t.getViewportY(), t)
  }

  const getTerminalColors = (): TerminalColors => {
    const mode = theme.mode()
    const fallback = DEFAULT_TERMINAL_COLORS[mode]
    const currentTheme = theme.themes()[theme.themeId()]
    if (!currentTheme) return fallback
    const variant = mode === "dark" ? currentTheme.dark : currentTheme.light
    if (!variant?.seeds) return fallback
    const resolved = resolveThemeVariant(variant, mode === "dark")
    const text = resolved["text-stronger"] ?? fallback.foreground
    const background = resolved["background-stronger"] ?? fallback.background
    const alpha = mode === "dark" ? 0.25 : 0.2
    const base = text.startsWith("#") ? (text as HexColor) : (fallback.foreground as HexColor)
    const selectionBackground = withAlpha(base, alpha)
    return {
      background,
      foreground: text,
      cursor: text,
      selectionBackground,
    }
  }

  const [terminalColors, setTerminalColors] = createSignal<TerminalColors>(getTerminalColors())

  createEffect(() => {
    const colors = getTerminalColors()
    setTerminalColors(colors)
    if (!term) return
    const setOption = (term as unknown as { setOption?: (key: string, value: TerminalColors) => void }).setOption
    if (!setOption) return
    setOption("theme", colors)
  })

  createEffect(() => {
    const font = monoFontFamily(settings.appearance.font())
    if (!term) return
    const setOption = (term as unknown as { setOption?: (key: string, value: string) => void }).setOption
    if (!setOption) return
    setOption("fontFamily", font)
    fitTerminal()
  })

  const focusTerminal = () => {
    const t = term
    if (!t) return
    t.focus()
    setTimeout(() => t.textarea?.focus(), 0)
  }
  const handlePointerDown = () => {
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && activeElement !== container) {
      activeElement.blur()
    }
    fitTerminal()
    focusTerminal()
  }

  createEffect(() => {
    if (!local.active || !term) return
    fitTerminal()
    queueMicrotask(() => {
      paintTerminal()
      focusTerminal()
    })
  })

  onMount(() => {
    const run = async () => {
      const loaded = await loadGhostty()
      if (disposed) return

      const mod = loaded.mod
      const g = loaded.ghostty

      const once = { value: false }

      const t = new mod.Terminal({
        cursorBlink: true,
        cursorStyle: "bar",
        fontSize: 14,
        fontFamily: monoFontFamily(settings.appearance.font()),
        allowTransparency: true,
        theme: terminalColors(),
        scrollback: 10_000,
        ghostty: g,
      })
      cleanups.push(() => t.dispose())
      if (disposed) {
        cleanup()
        return
      }
      term = t

      const fallback = (value: string) => {
        const body = document.body
        if (!body) return false
        const textarea = document.createElement("textarea")
        textarea.value = value
        textarea.setAttribute("readonly", "")
        textarea.style.position = "fixed"
        textarea.style.opacity = "0"
        body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand("copy")
        body.removeChild(textarea)
        return copied
      }

      const write = (value: string) => {
        if (!value) return Promise.resolve(false)
        if (fallback(value)) return Promise.resolve(true)
        const clipboard = navigator.clipboard
        if (clipboard?.writeText) {
          return clipboard.writeText(value).then(
            () => true,
            () => false,
          )
        }
        return Promise.resolve(false)
      }

      const state = {
        query: "",
        index: -1,
        matches: [] as TerminalMatch[],
      }

      const controller: TerminalController = {
        focus: () => {
          fitTerminal()
          focusTerminal()
        },
        clearSelection: () => t.clearSelection(),
        search: (query, direction = "next") => {
          const needle = query.toLocaleLowerCase()
          if (!needle) {
            state.query = ""
            state.index = -1
            state.matches = []
            t.clearSelection()
            return { current: 0, total: 0 }
          }

          if (state.query !== needle) {
            state.query = needle
            state.index = -1
            const lines = Array.from(
              { length: t.buffer.active.length },
              (_, row) => t.buffer.active.getLine(row)?.translateToString(true) ?? "",
            )
            state.matches = terminalMatches(lines, query)
          }

          if (!state.matches.length) {
            t.clearSelection()
            return { current: 0, total: 0 }
          }

          const offset = direction === "previous" ? -1 : 1
          state.index = (state.index + offset + state.matches.length) % state.matches.length
          const match = state.matches[state.index]
          t.select(match.column, match.row, match.length)
          t.scrollToLine(match.row)
          return { current: state.index + 1, total: state.matches.length }
        },
      }

      local.onReady?.(controller)
      cleanups.push(() => local.onReady?.())

      t.attachCustomKeyEventHandler((event) => {
        const key = event.key.toLowerCase()

        if (event.ctrlKey && event.shiftKey && !event.metaKey && key === "c") {
          void write(t.getSelection())
          return true
        }

        if (event.metaKey && !event.ctrlKey && !event.altKey && key === "c") {
          if (!t.hasSelection()) return true
          void write(t.getSelection())
          return true
        }

        if (event.ctrlKey && !event.shiftKey && !event.metaKey && key === "insert") {
          void write(t.getSelection())
          return true
        }

        if (
          (event.metaKey && !event.ctrlKey && !event.altKey && key === "f") ||
          (event.ctrlKey && event.shiftKey && !event.metaKey && key === "f")
        ) {
          local.onOpenSearch?.()
          return true
        }

        if (event.metaKey && !event.ctrlKey && !event.altKey && key === "a") {
          t.selectAll()
          return true
        }

        // allow for ctrl-` to toggle terminal in parent
        if (event.ctrlKey && key === "`") {
          return true
        }

        return false
      })

      const fit = new mod.FitAddon()
      cleanups.push(() => (fit as unknown as { dispose?: VoidFunction }).dispose?.())
      t.loadAddon(fit)
      fitAddon = fit

      t.open(container)
      container.addEventListener("pointerdown", handlePointerDown)
      cleanups.push(() => container.removeEventListener("pointerdown", handlePointerDown))
      const handlePointerUp = () => {
        queueMicrotask(() => {
          if (!t.hasSelection()) return
          void write(t.getSelection())
        })
      }
      container.addEventListener("pointerup", handlePointerUp, true)
      cleanups.push(() => container.removeEventListener("pointerup", handlePointerUp, true))

      handleTextareaFocus = () => {
        t.options.cursorBlink = true
      }
      handleTextareaBlur = () => {
        t.options.cursorBlink = false
      }

      t.textarea?.addEventListener("focus", handleTextareaFocus)
      t.textarea?.addEventListener("blur", handleTextareaBlur)
      cleanups.push(() => t.textarea?.removeEventListener("focus", handleTextareaFocus))
      cleanups.push(() => t.textarea?.removeEventListener("blur", handleTextareaBlur))

      if (local.active !== false) focusTerminal()

      if (local.pty.rows && local.pty.cols) t.resize(local.pty.cols, local.pty.rows)

      const link = {
        socket: undefined as WebSocket | undefined,
        timer: undefined as number | undefined,
        failures: 0,
        detach: () => {},
      }
      const replay = { painted: false }
      const handleMessage = (event: MessageEvent) => {
        // Data proves the link works, so only now does the retry budget refill.
        link.failures = 0
        t.write(event.data, () => {
          if (replay.painted) return
          replay.painted = true
          fitTerminal()
          paintTerminal()
        })
      }
      const url = new URL(sdk.request.url(`/pty/${local.pty.id}/connect`))
      const connect = () => {
        if (disposed) return
        link.timer = undefined
        // A superseded socket is closed and silent; drop its listeners anyway rather than leak them.
        link.detach()
        const socket = new WebSocket(url)
        const handleOpen = () => {
          // The server replays its whole buffer to every fresh subscriber, so erase the stale
          // screen and scrollback first or the scrollback doubles on each reconnect.
          if (link.failures) t.write(ERASE)
          local.onConnect?.()
          fitTerminal()
          socket.send(REPLAY_REQUEST)
          sdk.client.pty
            .update({
              ptyID: local.pty.id,
              size: {
                cols: t.cols,
                rows: t.rows,
              },
            })
            .catch(() => {})
        }
        const handleError = (error: Event) => {
          if (disposed) return
          // A socket error is always followed by a close event, which owns the retry.
          console.error("WebSocket error:", error)
        }
        const handleClose = (event: CloseEvent) => {
          if (disposed) return
          // Normal closure (code 1000) means PTY process exited - server event handles cleanup
          if (event.code === 1000) return
          // For other codes (network issues, server restart), retry with backoff before reporting once
          link.failures += 1
          const delay = backoff(link.failures)
          if (delay !== undefined) {
            link.timer = window.setTimeout(connect, delay)
            return
          }
          if (once.value) return
          once.value = true
          local.onConnectError?.(new Error(`WebSocket closed abnormally: ${event.code}`))
        }
        socket.addEventListener("open", handleOpen)
        socket.addEventListener("message", handleMessage)
        socket.addEventListener("error", handleError)
        socket.addEventListener("close", handleClose)
        link.socket = socket
        link.detach = () => {
          socket.removeEventListener("open", handleOpen)
          socket.removeEventListener("message", handleMessage)
          socket.removeEventListener("error", handleError)
          socket.removeEventListener("close", handleClose)
        }
      }
      cleanups.push(() => {
        if (link.timer !== undefined) window.clearTimeout(link.timer)
        link.timer = undefined
        link.detach()
        const socket = link.socket
        if (!socket) return
        if (socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) socket.close()
      })
      connect()

      const onResize = t.onResize(async (size) => {
        if (link.socket?.readyState === WebSocket.OPEN) {
          await sdk.client.pty
            .update({
              ptyID: local.pty.id,
              size: {
                cols: size.cols,
                rows: size.rows,
              },
            })
            .catch(() => {})
        }
      })
      cleanups.push(() => (onResize as unknown as { dispose?: VoidFunction }).dispose?.())
      fit.observeResize()
      handleResize = fitTerminal
      window.addEventListener("resize", handleResize)
      cleanups.push(() => window.removeEventListener("resize", handleResize))
      fitTerminal()
      const onData = t.onData((data) => {
        const socket = link.socket
        if (socket?.readyState === WebSocket.OPEN) socket.send(data)
      })
      cleanups.push(() => (onData as unknown as { dispose?: VoidFunction }).dispose?.())
      const onKey = t.onKey((key) => {
        if (key.key == "Enter") {
          props.onSubmit?.()
        }
      })
      cleanups.push(() => (onKey as unknown as { dispose?: VoidFunction }).dispose?.())
      // t.onScroll((ydisp) => {
      // console.log("Scroll position:", ydisp)
      // })
    }

    void run().catch((err) => {
      if (disposed) return
      showToast({
        variant: "error",
        title: language.t("terminal.connectionLost.title"),
        description: err instanceof Error ? err.message : language.t("terminal.connectionLost.description"),
      })
      local.onConnectError?.(connectionError(err))
    })
  })

  onCleanup(() => {
    disposed = true
    if (fitFrame !== undefined) cancelAnimationFrame(fitFrame)
    if (fitTimer !== undefined) window.clearTimeout(fitTimer)
    const t = term
    if (props.onCleanup && t) {
      props.onCleanup({
        ...local.pty,
        buffer: undefined,
        rows: t.rows,
        cols: t.cols,
        scrollY: undefined,
      })
    }

    cleanup()
  })

  return (
    <div
      ref={container}
      data-component="terminal"
      data-prevent-autofocus
      tabIndex={-1}
      style={{ "background-color": terminalColors().background }}
      classList={{
        ...(local.classList ?? {}),
        "select-text": true,
        "size-full px-6 py-3 font-mono": true,
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
