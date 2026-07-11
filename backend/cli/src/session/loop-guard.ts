// A stuck weak model can degenerate WITHIN a single turn: it re-emits the same
// block back-to-back until it exhausts its output budget. The cross-turn text
// doom-loop guard (in prompt.ts) can't see that — it's one turn — so detect a
// repeated tail as the text streams in and abort the generation before it burns
// minutes spinning (#176).
export const INTRA_REPEAT_MIN_BLOCK = 120
export const INTRA_REPEAT_COUNT = 3
const INTRA_REPEAT_MAX_WINDOW = 8000

/** True when the tail of `text` is a substantial block (≥ minBlock chars) repeated
 *  back-to-back at least `repeats` times. Bounded to the last INTRA_REPEAT_MAX_WINDOW
 *  chars and O(window) so it stays cheap enough to run on each streamed chunk. */
export function hasRepeatedTail(
  text: string,
  minBlock = INTRA_REPEAT_MIN_BLOCK,
  repeats = INTRA_REPEAT_COUNT,
): boolean {
  if (text.length < minBlock * repeats) return false
  const window = text.slice(-INTRA_REPEAT_MAX_WINDOW)
  const w = window.length
  const anchor = window.slice(-Math.min(64, w))
  // Estimate the repeat period from where the final chunk last recurred before
  // the end. For a tail of ...[block][block][block] this lands one period back.
  const prev = window.lastIndexOf(anchor, w - anchor.length - 1)
  if (prev < 0) return false
  const period = w - anchor.length - prev
  if (period < minBlock || w < period * repeats) return false
  const block = window.slice(w - period)
  for (let k = 2; k <= repeats; k++) {
    if (window.slice(w - period * k, w - period * (k - 1)) !== block) return false
  }
  return true
}
