import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createResizeObserver } from "@solid-primitives/resize-observer"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
}

export function createAutoScroll(options: AutoScrollOptions) {
  let scroll: HTMLElement | undefined
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let cleanup: (() => void) | undefined
  let auto: { top: number; time: number } | undefined
  let height = 0
  let width = 0
  let anchor: { element: HTMLElement; top: number; until: number } | undefined
  let anchorFrame: number | undefined
  let reading: { node: Node; range?: Range; top: number } | undefined

  const threshold = () => options.bottomThreshold ?? 10

  const [store, setStore] = createStore({
    scrollRef: undefined as HTMLElement | undefined,
    contentRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 250)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 250) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = scroll
    if (!el) return
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    if (force) {
      anchor = undefined
      reading = undefined
    }
    if (!force && !active()) return
    const el = scroll
    if (!el) return

    if (!force && store.userScrolled) return
    if (force && store.userScrolled) setStore("userScrolled", false)

    const distance = distanceFromBottom(el)
    if (distance < 2) return

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto")
  }

  const stop = () => {
    const el = scroll
    if (!el) return
    if (!canScroll(el)) {
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    anchor = undefined
    reading = undefined
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = scroll
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    stop()
  }

  const handleScroll = () => {
    const el = scroll
    if (!el) return

    if (!canScroll(el)) {
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      reading = undefined
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!store.userScrolled && isAuto(el)) {
      scrollToBottom(false)
      return
    }

    stop()
    captureReading()
  }

  const handleInteraction = () => {
    if (active()) stop()
    captureReading()
  }

  const captureReading = () => {
    const el = scroll
    if (!el || !store.userScrolled) return
    if (reading && (!el.contains(reading.node) || (reading.range && reading.range.startContainer !== reading.node))) {
      reading = undefined
    }
    const bounds = el.getBoundingClientRect()
    const x = bounds.left + el.clientWidth / 2
    const document = el.ownerDocument
    const visible = (rect: DOMRect) => rect.height > 0 && rect.top >= bounds.top && rect.top < bounds.bottom
    let fallback: typeof reading
    // A point in paragraph spacing can resolve to the preceding offscreen
    // text. Sample a few visible lines instead of anchoring that stale line.
    for (const offset of [12, 32, 56, 80, 120]) {
      const y = bounds.top + Math.min(offset, el.clientHeight / 2)
      const caret = document.caretPositionFromPoint?.(x, y)
      const range = caret ? document.createRange() : document.caretRangeFromPoint?.(x, y)
      if (caret && range) range.setStart(caret.offsetNode, caret.offset)
      const node = range?.startContainer
      if (node?.nodeType === Node.TEXT_NODE && store.contentRef?.contains(node)) {
        const length = node.textContent?.length ?? 0
        if (length && range) {
          // A single text character survives line wrapping better than either
          // scrollTop or the top of a paragraph that spans several screens.
          const start = Math.min(range.startOffset, length - 1)
          range.setStart(node, start)
          range.setEnd(node, start + 1)
          const rect = range.getBoundingClientRect()
          if (visible(rect)) {
            reading = { node, range, top: rect.top - bounds.top }
            return
          }
        }
      }
      const target = document.elementFromPoint?.(x, y)
      const element = target?.closest("p, li, pre, td, th, h1, h2, h3, h4, h5, h6, button, summary") ?? target
      if (
        !fallback &&
        element &&
        element !== el &&
        element !== store.contentRef &&
        store.contentRef?.contains(element)
      ) {
        const rect = element.getBoundingClientRect()
        if (visible(rect)) fallback = { node: element, top: rect.top - bounds.top }
      }
    }
    // A resize drag can put a pointer-capture shield over the conversation.
    // Keep the connected anchor until content can be hit-tested again; manual
    // scroll intent already clears it before reaching this function.
    if (fallback) reading = fallback
  }

  const restoreReading = (disclosure: boolean) => {
    const el = scroll
    if (!el) return false
    const previous = width
    width = el.clientWidth
    if (!previous || width === previous) return false
    if (disclosure) {
      captureReading()
      return true
    }
    if (!store.userScrolled) {
      scrollToBottom(true)
      return true
    }
    const saved = reading
    if (saved && el.contains(saved.node) && (!saved.range || saved.range.startContainer === saved.node)) {
      const rect = saved.range?.getBoundingClientRect() ?? (saved.node as Element).getBoundingClientRect()
      const delta = rect.top - el.getBoundingClientRect().top - saved.top
      if (rect.height > 0 && Math.abs(delta) > 1) el.scrollTop += delta
    }
    captureReading()
    return true
  }

  const restoreAnchor = () => {
    const el = scroll
    const saved = anchor
    if (!el || !saved) return false
    if (Date.now() > saved.until || !el.contains(saved.element)) {
      anchor = undefined
      return false
    }
    // Native scroll anchoring may already have compensated. Restore only the
    // remaining visual displacement, never add the content-height difference.
    const delta = saved.element.getBoundingClientRect().top - saved.top
    if (Math.abs(delta) > 1) el.scrollTop += delta
    return true
  }

  const captureDisclosure = (event: MouseEvent) => {
    const el = scroll
    const target = event.target instanceof Element ? event.target : undefined
    const button = target?.closest<HTMLElement>("[aria-expanded], summary")
    if (!el || !button || !el.contains(button) || !canScroll(el)) return
    const nested = target?.closest("[data-scrollable]")
    if (nested && nested !== el) return
    stop()
    anchor = { element: button, top: button.getBoundingClientRect().top, until: Date.now() + 350 }
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
    // Capture-phase runs before a disclosure changes layout, including a
    // keyboard-generated click. ResizeObserver also follows short transitions.
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = undefined
      restoreAnchor()
    })
  }

  const clearAnchor = () => {
    anchor = undefined
    reading = undefined
  }

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return
    if (!["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(event.key)) return
    const target = event.target instanceof Element ? event.target : undefined
    if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return
    // Space activates a focused disclosure; its generated click still needs
    // the anchor. On ordinary content, these keys are explicit scroll intent.
    if (event.key === " " && target?.closest("button, summary, [role='button']")) return
    clearAnchor()
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = store.userScrolled ? "auto" : "none"
  }

  createResizeObserver(
    () => store.contentRef,
    ({ height: next }) => {
      const el = scroll
      const grew = next > height
      height = next
      const disclosure = restoreAnchor()
      if (restoreReading(disclosure) || disclosure) return
      if (el && !canScroll(el)) return
      if (!active()) return
      if (store.userScrolled) return
      // A live trace can contract when a spinner or transient row disappears.
      // Never interpret that contraction as new content worth following: doing
      // so recaptures readers who are inspecting earlier activity.
      if (!grew) return
      // ResizeObserver fires after layout, before paint.
      // Keep the bottom locked in the same frame to avoid visible
      // "jump up then catch up" artifacts while streaming content.
      scrollToBottom(false)
    },
  )

  createResizeObserver(
    () => store.scrollRef,
    () => {
      const disclosure = restoreAnchor()
      if (restoreReading(disclosure) || disclosure) return
      scrollToBottom(false)
    },
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled) scrollToBottom(true)
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.userScrolled
    const el = scroll
    if (!el) return
    updateOverflowAnchor(el)
  })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
    if (anchorFrame !== undefined) cancelAnimationFrame(anchorFrame)
    reading = undefined
    if (cleanup) cleanup()
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => {
      if (cleanup) {
        cleanup()
        cleanup = undefined
      }

      scroll = el
      setStore("scrollRef", el)
      anchor = undefined
      reading = undefined
      width = el?.clientWidth ?? 0

      if (!el) return

      height = store.contentRef?.getBoundingClientRect().height ?? 0

      updateOverflowAnchor(el)
      el.addEventListener("wheel", handleWheel, { passive: true })
      el.addEventListener("click", captureDisclosure, true)
      el.addEventListener("pointerdown", clearAnchor, { passive: true })
      el.addEventListener("touchmove", clearAnchor, { passive: true })
      el.addEventListener("keydown", handleKeydown)

      cleanup = () => {
        el.removeEventListener("wheel", handleWheel)
        el.removeEventListener("click", captureDisclosure, true)
        el.removeEventListener("pointerdown", clearAnchor)
        el.removeEventListener("touchmove", clearAnchor)
        el.removeEventListener("keydown", handleKeydown)
      }
    },
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    userScrolled: () => store.userScrolled,
  }
}
