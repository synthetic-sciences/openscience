export type SessionTabKey = "ArrowLeft" | "ArrowRight" | "Home" | "End"

export function sessionTabTarget(key: string, index: number, count: number) {
  if (count < 1 || index < 0 || index >= count) return
  if (key === "ArrowLeft") return (index - 1 + count) % count
  if (key === "ArrowRight") return (index + 1) % count
  if (key === "Home") return 0
  if (key === "End") return count - 1
}
