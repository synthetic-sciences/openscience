export type TableFormat = "csv" | "tsv" | "json" | "jsonl"
export type ColumnType = "number" | "boolean" | "date" | "string"

export interface TableSchema {
  name: string
  type: ColumnType
  missing: number
  unique: number
}

export interface DataTable {
  columns: string[]
  rows: string[][]
  schema: TableSchema[]
  totalRows: number
  truncated: boolean
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const scalar = (value: unknown) => {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  return JSON.stringify(value)
}

function delimited(text: string, delimiter: string) {
  const rows: string[][] = []
  const state = { index: 0, cell: "", row: [] as string[], quoted: false }
  const pushCell = () => {
    state.row.push(state.cell)
    state.cell = ""
  }
  const pushRow = () => {
    pushCell()
    rows.push(state.row)
    state.row = []
  }

  while (state.index < text.length) {
    const char = text[state.index] ?? ""
    const next = text[state.index + 1] ?? ""
    if (state.quoted && char === '"' && next === '"') {
      state.cell += '"'
      state.index += 2
      continue
    }
    if (state.quoted && char === '"') {
      state.quoted = false
      state.index += 1
      continue
    }
    if (state.quoted) {
      state.cell += char
      state.index += 1
      continue
    }
    if (char === '"' && state.cell === "") {
      state.quoted = true
      state.index += 1
      continue
    }
    if (char === delimiter) {
      pushCell()
      state.index += 1
      continue
    }
    if (char === "\n" || char === "\r") {
      pushRow()
      state.index += char === "\r" && next === "\n" ? 2 : 1
      continue
    }
    state.cell += char
    state.index += 1
  }
  if (state.cell || state.row.length) pushRow()
  return rows
}

const headers = (values: string[]) => {
  const seen = new Map<string, number>()
  return values.map((value, index) => {
    const base = value.trim() || `column_${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count ? `${base}_${count + 1}` : base
  })
}

const jsonRows = (text: string, format: "json" | "jsonl") => {
  const values: unknown[] =
    format === "json"
      ? (() => {
          const parsed: unknown = JSON.parse(text)
          if (!Array.isArray(parsed)) throw new Error("Tabular JSON must be an array of records")
          return parsed
        })()
      : text
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as unknown)

  if (!values.every(record)) throw new Error("Tabular JSON must be an array of records")
  const columns = [...new Set(values.flatMap((value) => Object.keys(value)))]
  return {
    columns,
    rows: values.map((value) => columns.map((column) => scalar(value[column]))),
  }
}

const infer = (values: string[]): ColumnType => {
  const present = values.map((value) => value.trim()).filter(Boolean)
  if (!present.length) return "string"
  if (present.every((value) => /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value))) return "number"
  if (present.every((value) => /^(?:true|false)$/i.test(value))) return "boolean"
  if (
    present.every((value) => /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?$/.test(value) && !Number.isNaN(Date.parse(value)))
  ) {
    return "date"
  }
  return "string"
}

const schema = (columns: string[], rows: string[][]): TableSchema[] =>
  columns.map((name, index) => {
    const values = rows.map((row) => row[index] ?? "")
    const present = values.filter((value) => value.trim())
    const type = infer(values)
    const normalized = present.map((value) => {
      if (type === "boolean") return value.toLowerCase()
      if (type === "number") return String(Number(value))
      return value
    })
    return {
      name,
      type,
      missing: values.length - present.length,
      unique: new Set(normalized).size,
    }
  })

export function parseTable(format: TableFormat, text: string, limit = 5_000): DataTable {
  const parsed = (() => {
    if (format === "json" || format === "jsonl") return jsonRows(text, format)
    const rows = delimited(text, format === "tsv" ? "\t" : ",")
    const columns = headers(rows[0] ?? [])
    return {
      columns,
      rows: rows.slice(1).map((row) => columns.map((_, index) => row[index] ?? "")),
    }
  })()

  return {
    columns: parsed.columns,
    rows: parsed.rows.slice(0, limit),
    schema: schema(parsed.columns, parsed.rows),
    totalRows: parsed.rows.length,
    truncated: parsed.rows.length > limit,
  }
}

export function numericColumn(table: Pick<DataTable, "rows">, index: number) {
  return table.rows
    .map((row) => row[index] ?? "")
    .filter((value) => value.trim())
    .map(Number)
    .filter(Number.isFinite)
}

export function summarizeColumn(table: Pick<DataTable, "rows">, index: number) {
  const values = numericColumn(table, index)
  const total = values.reduce((sum, value) => sum + value, 0)
  return {
    count: values.length,
    missing: table.rows.length - values.length,
    min: values.length ? Math.min(...values) : undefined,
    max: values.length ? Math.max(...values) : undefined,
    mean: values.length ? total / values.length : undefined,
  }
}

const quote = (value: string, delimiter: string) => {
  if (!value.includes(delimiter) && !value.includes('"') && !value.includes("\n") && !value.includes("\r")) return value
  return `"${value.replaceAll('"', '""')}"`
}

export function exportDelimited(table: Pick<DataTable, "columns" | "rows">, delimiter: "," | "\t" = ",") {
  const rows = [table.columns, ...table.rows]
  return `${rows.map((row) => row.map((value) => quote(value, delimiter)).join(delimiter)).join("\n")}\n`
}
