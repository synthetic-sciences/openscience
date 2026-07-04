import { timingSafeEqual as nodeTimingSafeEqual } from "crypto"

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder()
  const bufA = encoder.encode(a)
  const bufB = encoder.encode(b)
  if (bufA.byteLength !== bufB.byteLength) {
    // Do a dummy compare so the length-mismatch branch still spends time
    // proportional to the stored value — not leaking "wrong length" via
    // early-return. An observer can still distinguish different input
    // lengths, but that's unavoidable at this API boundary.
    nodeTimingSafeEqual(bufA, bufA)
    return false
  }
  return nodeTimingSafeEqual(bufA, bufB)
}
