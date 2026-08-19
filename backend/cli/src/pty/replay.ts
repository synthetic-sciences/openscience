export namespace Replay {
  const LIMIT = 1024 * 1024 * 2
  const CHUNK = 64 * 1024

  export function append(buffer: string, data: string) {
    const next = buffer + data
    if (next.length <= LIMIT) return next
    return next.slice(-LIMIT)
  }

  export function chunks(buffer: string) {
    const count = Math.ceil(buffer.length / CHUNK)
    return Array.from({ length: count }, (_, index) => buffer.slice(index * CHUNK, (index + 1) * CHUNK))
  }
}
