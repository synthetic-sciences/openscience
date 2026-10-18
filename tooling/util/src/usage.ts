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
  costs?: UsageCost[]
}

export const usageCostLabels = {
  wallet_receipt: "Wallet charge",
  provider_response: "Provider reported",
  catalog_estimate: "Catalog estimate",
  imported_billing: "Imported billing",
  imported_credit: "Imported billing credits",
  wallet_calculated: "Calculated Ace · not settled",
  recorded_unclassified: "Historical accounting · basis unknown",
  subscription: "Subscription covered",
  no_provider_charge: "No provider charge",
  unknown: "Unknown cost",
} as const
export type UsageCost = {
  source: keyof typeof usageCostLabels
  amountUSD: string | null
  known: number
  unknown: number
}
export function usageCost(source: UsageCost["source"], value: number | string | null): UsageCost {
  const numeric = (value: number) => {
    const [mantissa, exponent] = value.toString().split("e")
    if (!exponent) return mantissa!
    const [whole, fraction = ""] = mantissa!.split(".")
    const digits = whole + fraction
    const point = whole!.length + Number(exponent)
    return point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? digits + "0".repeat(point - digits.length)
        : `${digits.slice(0, point)}.${digits.slice(point)}`
  }
  const amount = typeof value === "number" ? (Number.isFinite(value) && value >= 0 ? numeric(value) : null) : value
  return { source, amountUSD: amount, known: amount === null ? 0 : 1, unknown: amount === null ? 1 : 0 }
}
function addDollars(a: string, b: string) {
  const [wholeA, fractionA = ""] = a.split(".")
  const [wholeB, fractionB = ""] = b.split(".")
  const places = Math.max(fractionA.length, fractionB.length)
  const sum = BigInt(wholeA + fractionA.padEnd(places, "0")) + BigInt(wholeB + fractionB.padEnd(places, "0"))
  const digits = sum.toString().padStart(places + 1, "0")
  const whole = places ? digits.slice(0, -places) : digits
  const fraction = places ? digits.slice(-places).replace(/0+$/, "") : ""
  return fraction ? `${whole}.${fraction}` : whole
}
export function usageCosts(costs: readonly UsageCost[]) {
  const totals = new Map<UsageCost["source"], UsageCost>()
  for (const cost of costs) {
    const previous = totals.get(cost.source)
    totals.set(cost.source, {
      source: cost.source,
      amountUSD:
        previous?.amountUSD == null && cost.amountUSD == null
          ? null
          : addDollars(previous?.amountUSD ?? "0", cost.amountUSD ?? "0"),
      known: (previous?.known ?? 0) + cost.known,
      unknown: (previous?.unknown ?? 0) + cost.unknown,
    })
  }
  return [...totals.values()]
}
export function usageCostTotals(rows: readonly UsageRow[]) {
  return usageCosts(
    rows.flatMap(
      (row) =>
        row.costs ?? [
          usageCost(
            row.route === "managed"
              ? "wallet_receipt"
              : row.route === "local"
                ? "no_provider_charge"
                : row.route === "subscription" || row.route === "chatgpt"
                  ? "subscription"
                  : "recorded_unclassified",
            row.route === "subscription" || row.route === "chatgpt" ? null : row.cost,
          ),
        ],
    ),
  )
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
      models.set(key, { ...row, costs: usageCostTotals([row]) })
      continue
    }
    current.costs = usageCosts([...(current.costs ?? []), ...usageCostTotals([row])])
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
    "Compatibility accounting (USD)",
    "Cost basis",
    ...Object.values(usageCostLabels).map((label) => `${label} (USD)`),
    "Unknown cost observations",
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
        usageCostTotals([row])
          .map((cost) => usageCostLabels[cost.source])
          .join("; "),
        ...Object.keys(usageCostLabels).map(
          (source) => usageCostTotals([row]).find((cost) => cost.source === source)?.amountUSD ?? "",
        ),
        usageCostTotals([row]).reduce((sum, cost) => sum + cost.unknown, 0),
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n") + "\r\n"
  )
}
