export type UsageRoute = "managed" | "byok" | "local" | "chatgpt" | "subscription" | "custom" | "unknown"

export type UsageRow = {
  date: string
  provider: string
  model: string
  route: UsageRoute
  calls: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  cost: number
}

export function usageRange(days = 30, now = new Date()) {
  const end = now.toISOString().slice(0, 10)
  const start = new Date(`${end}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - days + 1)
  return { start: start.toISOString().slice(0, 10), end }
}

export function usageDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}

export function usageTotals(rows: readonly UsageRow[]) {
  return rows.reduce(
    (total, row) => ({
      calls: total.calls + row.calls,
      tokens: total.tokens + row.tokens,
      cost: total.cost + row.cost,
      cacheRead: total.cacheRead + row.cacheRead,
    }),
    { calls: 0, tokens: 0, cost: 0, cacheRead: 0 },
  )
}

export function usageModels(rows: readonly UsageRow[]) {
  const models = new Map<string, UsageRow>()
  for (const row of rows) {
    const key = JSON.stringify([row.route, row.provider, row.model])
    const current = models.get(key)
    if (!current) {
      models.set(key, { ...row })
      continue
    }
    for (const field of ["calls", "input", "output", "reasoning", "cacheRead", "cacheWrite", "tokens", "cost"] as const)
      current[field] += row[field]
  }
  return [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model))
}

export function usageCsv(rows: readonly UsageRow[]) {
  const cell = (value: string | number) => {
    const text = String(value)
    // Model and provider names can come from user-configured endpoints.
    const safe = /^[\s]*[=+@-]/.test(text) && typeof value === "string" ? `'${text}` : text
    return `"${safe.replaceAll('"', '""')}"`
  }
  const header = [
    "Date (UTC)",
    "Provider",
    "Model",
    "Route",
    "Requests",
    "Input tokens",
    "Output tokens (includes reasoning)",
    "Reasoning tokens",
    "Cache read tokens",
    "Cache write tokens",
    "Total tokens",
    "Cost (USD)",
    "Cost basis",
  ]
  return (
    [
      header,
      ...rows.map((row) => [
        row.date,
        row.provider,
        row.model,
        row.route,
        row.calls,
        row.input,
        row.output,
        row.reasoning,
        row.cacheRead,
        row.cacheWrite,
        row.tokens,
        row.cost.toFixed(8),
        row.route === "managed" ? "Wallet charge" : "Estimate",
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") + "\r\n"
  )
}
