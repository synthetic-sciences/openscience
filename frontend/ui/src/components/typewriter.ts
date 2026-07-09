import { createEffect, createSignal, onCleanup } from "solid-js"
import { isServer } from "solid-js/web"

export function revealStep(
  revealed: number,
  targetLen: number,
  elapsedMs: number,
  opts: { drainMs?: number; minCps?: number } = {},
): number {
  if (revealed >= targetLen) return revealed
  const drainMs = opts.drainMs ?? 250
  const minCps = opts.minCps ?? 30
  const remaining = targetLen - revealed
  const drainCps = (remaining / drainMs) * 1000
  const cps = Math.max(minCps, drainCps)
  const advance = Math.max(1, Math.floor((cps * elapsedMs) / 1000))
  return Math.min(targetLen, revealed + advance)
}

// Reveal on a whitespace boundary to avoid mid-word flicker.
function boundary(text: string, count: number): number {
  if (count >= text.length) return text.length
  const slice = text.slice(0, count)
  const lastSpace = slice.lastIndexOf(" ")
  const lastNl = slice.lastIndexOf("\n")
  const cut = Math.max(lastSpace, lastNl)
  return cut > count - 24 && cut > 0 ? cut : count
}

export function createTypewriter(getText: () => string): () => string {
  const [shown, setShown] = createSignal(getText())
  if (isServer) return () => getText()

  let revealed = getText().length
  let raf = 0
  let prev = 0
  let lastEmit = 0

  const tick = (now: number) => {
    const target = getText()
    const elapsed = prev ? now - prev : 16
    prev = now
    if (target.length < revealed) revealed = target.length // source reset/shrink → snap
    revealed = revealStep(revealed, target.length, elapsed)
    // Advance the reveal position every frame, but throttle the setShown emit
    // (and thus the Markdown reparse it triggers) to ~30fps — always emitting on
    // completion so the final state lands exactly on the target.
    if (now - lastEmit >= 33 || revealed >= target.length) {
      setShown(target.slice(0, boundary(target, revealed)))
      lastEmit = now
    }
    raf = revealed < target.length ? requestAnimationFrame(tick) : 0
    if (!raf) {
      prev = 0
      lastEmit = 0
    }
  }

  // Kick the loop whenever the source grows past what's revealed; snap on shrink.
  createEffect(() => {
    const target = getText()
    if (target.length > revealed && !raf) raf = requestAnimationFrame(tick)
    if (target.length < revealed) {
      revealed = target.length
      setShown(target)
    }
  })

  onCleanup(() => raf && cancelAnimationFrame(raf))
  return shown
}
