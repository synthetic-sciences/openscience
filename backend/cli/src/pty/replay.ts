export namespace Replay {
  const LIMIT = 1024 * 1024 * 2
  const CHUNK = 64 * 1024

  /** Bounded canonical PTY output kept as a ring of transport-sized chunks.
   *  Appends only touch the tail, and whole chunks fall off the head once the
   *  byte budget is exceeded, so a full ring never copies its 2 MB per write. */
  export type Ring = {
    chunks: string[]
    length: number
  }

  export function create(): Ring {
    return { chunks: [], length: 0 }
  }

  function push(ring: Ring, piece: string) {
    const last = ring.chunks.at(-1)
    // Pack small writes into the tail chunk so a byte-at-a-time stream does
    // not grow the ring to millions of entries.
    const packed = last !== undefined && last.length + piece.length <= CHUNK
    if (packed) ring.chunks[ring.chunks.length - 1] = last + piece
    if (!packed) ring.chunks.push(piece)
    ring.length += piece.length
  }

  export function append(ring: Ring, data: string) {
    for (let offset = 0; offset < data.length; offset += CHUNK) push(ring, data.slice(offset, offset + CHUNK))
    while (ring.length > LIMIT) {
      const head = ring.chunks.shift()!
      ring.length -= head.length
    }
    return ring
  }

  export function text(ring: Ring) {
    return ring.chunks.join("")
  }

  /** Replay frames, each at most one transport chunk, in stream order. */
  export function chunks(ring: Ring) {
    return [...ring.chunks]
  }
}
