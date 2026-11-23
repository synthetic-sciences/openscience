import { expect, spyOn, test } from "bun:test"
import { displayStats } from "../../src/cli/cmd/stats"

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const stats = {
  totalSessions: 2,
  totalMessages: 3,
  totalCost: 0.6,
  evidence: [],
  totalTokens: tokens,
  toolUsage: {},
  modelUsage: {
    "provider/a": { messages: 2, tokens, cost: 0.5 },
    "provider/b": { messages: 1, tokens, cost: 0.1 },
  },
  dateRange: { earliest: 0, latest: 0 },
  days: 1,
  costPerDay: 0.6,
  tokensPerSession: 0,
  medianTokensPerSession: 0,
}

const BORDER_TOP = "┌────────────────────────────────────────────────────────┐"
const BORDER_BOTTOM = "└────────────────────────────────────────────────────────┘"

function render(limit: number) {
  const lines: string[] = []
  const writes: string[] = []
  const log = spyOn(console, "log").mockImplementation((...values: unknown[]) => lines.push(values.join(" ")))
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(String(chunk))
    return true
  }) as typeof process.stdout.write)
  try {
    displayStats(stats, undefined, limit)
  } finally {
    log.mockRestore()
    write.mockRestore()
  }
  return { lines, writes, text: [...lines, ...writes].join("\n") }
}

test("the model table ends without terminal control characters", () => {
  const { lines, writes, text } = render(2)
  expect(text).not.toContain("\x1B")
  expect(writes).toEqual([])
  expect(lines.filter((line) => line === BORDER_BOTTOM)).toHaveLength(3)
  expect(lines.filter(Boolean).at(-1)).toBe(BORDER_BOTTOM)
})

test("a zero model limit prints no dangling model table", () => {
  const { lines, text } = render(0)
  expect(text).not.toContain("\x1B")
  expect(lines.filter((line) => line === BORDER_TOP)).toHaveLength(2)
  expect(lines.filter((line) => line === BORDER_BOTTOM)).toHaveLength(2)
})
