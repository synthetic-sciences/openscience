import { createEffect, createSignal, onCleanup } from "solid-js"
import { isServer } from "solid-js/web"

const [now, setNow] = createSignal(Date.now())
const state = { subscribers: 0, timer: undefined as ReturnType<typeof setInterval> | undefined }

/**
 * One shared one-second clock for every live counter in a transcript. A row
 * subscribes only while it is live, so an idle page runs no timer and a busy
 * trace re-renders its elapsed labels together instead of on staggered ticks.
 */
export function useClock(active: () => boolean) {
  if (isServer) return now
  createEffect(() => {
    if (!active()) return
    state.subscribers++
    setNow(Date.now())
    if (!state.timer) state.timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => {
      state.subscribers--
      if (state.subscribers > 0 || !state.timer) return
      clearInterval(state.timer)
      state.timer = undefined
    })
  })
  return now
}
