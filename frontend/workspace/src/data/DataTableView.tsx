import { For, Show, createMemo, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { exportDelimited, parseTable, summarizeColumn, type DataTable, type TableFormat } from "./table"
import "./DataTableView.css"

const PAGE_SIZE = 100

interface TableViewState {
  query: string
  sort?: { index: number; direction: "asc" | "desc" }
  page: number
  schema: boolean
  plot: boolean
  column: number
}

export function DataTableView(props: { text: string; format: TableFormat; name: string }): JSX.Element {
  const [view, setView] = createStore<TableViewState>({
    query: "",
    page: 0,
    schema: false,
    plot: false,
    column: 0,
  })

  const parsed = createMemo(() => {
    try {
      return { table: parseTable(props.format, props.text), error: "" }
    } catch (cause) {
      return {
        table: undefined,
        error: cause instanceof Error ? cause.message : "Could not parse table",
      }
    }
  })
  const table = () => parsed().table
  const numeric = createMemo(
    () =>
      table()
        ?.schema.map((value, index) => ({ ...value, index }))
        .filter((value) => value.type === "number") ?? [],
  )
  const plottedColumn = () =>
    numeric().some((value) => value.index === view.column) ? view.column : (numeric()[0]?.index ?? 0)
  const filtered = createMemo(() => {
    const data = table()
    if (!data) return []
    const term = view.query.trim().toLowerCase()
    const rows = term ? data.rows.filter((row) => row.some((value) => value.toLowerCase().includes(term))) : data.rows
    const order = view.sort
    if (!order) return rows
    const type = data.schema[order.index]?.type ?? "string"
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const left = a.row[order.index] ?? ""
        const right = b.row[order.index] ?? ""
        const result = compare(left, right, type)
        return (result || a.index - b.index) * (order.direction === "asc" ? 1 : -1)
      })
      .map((value) => value.row)
  })
  const pages = () => Math.max(1, Math.ceil(filtered().length / PAGE_SIZE))
  const visible = () => filtered().slice(view.page * PAGE_SIZE, (view.page + 1) * PAGE_SIZE)

  const sortBy = (index: number) => {
    setView("page", 0)
    setView("sort", (current) => {
      if (!current || current.index !== index) return { index, direction: "asc" }
      if (current.direction === "asc") return { index, direction: "desc" }
      return undefined
    })
  }

  const sortState = (index: number) => {
    const active = view.sort
    if (!active || active.index !== index) return "none" as const
    return active.direction === "asc" ? ("ascending" as const) : ("descending" as const)
  }

  const download = () => {
    const data = table()
    if (!data) return
    const text = exportDelimited({ columns: data.columns, rows: filtered() })
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${props.name.replace(/\.[^.]+$/, "")}.filtered.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div class="data-table-view" data-component="data-table">
      <Show
        when={table()}
        fallback={
          <section class="data-table-empty" role="alert">
            <strong>Couldn’t read this table</strong>
            <span>{parsed().error}</span>
          </section>
        }
      >
        {(data) => (
          <>
            <header class="data-table-toolbar">
              <div class="data-table-summary" aria-label="Dataset dimensions">
                <strong>{data().totalRows.toLocaleString()} rows</strong>
                <span aria-hidden="true">×</span>
                <span>{data().columns.length.toLocaleString()} columns</span>
              </div>

              <label class="data-table-search">
                <span class="sr-only">Filter every column</span>
                <input
                  type="search"
                  data-action="table-filter"
                  aria-label="Filter rows"
                  placeholder="Filter every column…"
                  value={view.query}
                  onInput={(event) => {
                    setView({ query: event.currentTarget.value, page: 0 })
                  }}
                />
                <Show when={view.query}>
                  <span class="data-table-matches" role="status">
                    {filtered().length.toLocaleString()} matches
                  </span>
                </Show>
              </label>

              <div class="data-table-actions" aria-label="Table tools">
                <button
                  type="button"
                  data-action="table-schema"
                  classList={{ "is-active": view.schema }}
                  aria-pressed={view.schema}
                  onClick={() => setView("schema", (value) => !value)}
                >
                  Schema
                </button>
                <label class="data-table-column-picker">
                  <span class="sr-only">Distribution column</span>
                  <select
                    aria-label="Plot column"
                    value={String(plottedColumn())}
                    disabled={!numeric().length}
                    onChange={(event) => setView("column", Number(event.currentTarget.value))}
                  >
                    <For each={numeric()}>{(value) => <option value={value.index}>{value.name}</option>}</For>
                  </select>
                </label>
                <button
                  type="button"
                  data-action="table-plot"
                  classList={{ "is-active": view.plot }}
                  aria-pressed={view.plot}
                  disabled={!numeric().length}
                  onClick={() => setView("plot", (value) => !value)}
                >
                  Distribution
                </button>
                <button type="button" data-action="table-export" onClick={download}>
                  Export filtered
                </button>
              </div>
            </header>

            <Show when={view.schema}>
              <section class="atlas-scroll data-table-schema" aria-label="Column schema">
                <For each={data().schema}>
                  {(value) => (
                    <article class="data-table-schema-card">
                      <div class="data-table-schema-name" title={value.name}>
                        {value.name}
                      </div>
                      <div class="data-table-schema-meta">
                        <span>{value.type}</span>
                        <span>{value.unique.toLocaleString()} unique</span>
                        <span>{value.missing.toLocaleString()} missing</span>
                      </div>
                      <div class="data-table-missing-track" title={`${value.missing} missing values`}>
                        <span
                          class="data-table-missing-value"
                          style={{ width: `${(value.missing / Math.max(1, data().totalRows)) * 100}%` }}
                        />
                      </div>
                    </article>
                  )}
                </For>
              </section>
            </Show>

            <Show when={view.plot && numeric().length}>
              <Histogram table={data()} index={plottedColumn()} onClose={() => setView("plot", false)} />
            </Show>

            <div class="atlas-scroll data-table-scroll" tabindex={0} aria-label={`${props.name} table preview`}>
              <table>
                <thead>
                  <tr>
                    <th class="data-table-index-head" scope="col">
                      <span class="sr-only">Row</span>
                      <span aria-hidden="true">#</span>
                    </th>
                    <For each={data().columns}>
                      {(name, index) => (
                        <th scope="col" aria-sort={sortState(index())}>
                          <button type="button" title={`Sort by ${name}`} onClick={() => sortBy(index())}>
                            <span class="data-table-column-label">
                              <span class="data-table-column-name">{name}</span>
                              <span class="data-table-column-type">{data().schema[index()]?.type ?? "string"}</span>
                            </span>
                            <span class="data-table-sort" aria-hidden="true">
                              {view.sort?.index === index() ? (view.sort?.direction === "asc" ? "↑" : "↓") : "↕"}
                            </span>
                          </button>
                        </th>
                      )}
                    </For>
                  </tr>
                </thead>
                <tbody>
                  <For each={visible()}>
                    {(row, index) => (
                      <tr>
                        <th class="data-table-index" scope="row">
                          {(view.page * PAGE_SIZE + index() + 1).toLocaleString()}
                        </th>
                        <For each={data().columns}>
                          {(_, column) => (
                            <td title={row[column()] ?? ""}>
                              <Show
                                when={(row[column()] ?? "") !== ""}
                                fallback={<span class="data-table-empty-value">—</span>}
                              >
                                {row[column()]}
                              </Show>
                            </td>
                          )}
                        </For>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>

            <footer class="data-table-pagination">
              <button type="button" disabled={view.page === 0} onClick={() => setView("page", (value) => value - 1)}>
                Previous
              </button>
              <span>
                Page {view.page + 1} of {pages()}
                {data().truncated ? " · Preview capped at 5,000 rows" : ""}
              </span>
              <button
                type="button"
                disabled={view.page + 1 >= pages()}
                onClick={() => setView("page", (value) => value + 1)}
              >
                Next
              </button>
            </footer>
          </>
        )}
      </Show>
    </div>
  )
}

function Histogram(props: { table: DataTable; index: number; onClose: () => void }): JSX.Element {
  const values = () => props.table.rows.map((row) => Number(row[props.index])).filter(Number.isFinite)
  const stats = () => summarizeColumn(props.table, props.index)
  const bars = createMemo(() => {
    const items = values()
    if (!items.length) return []
    const min = Math.min(...items)
    const max = Math.max(...items)
    const width = max - min || 1
    const count = Math.min(24, Math.max(6, Math.ceil(Math.sqrt(items.length))))
    const bins = Array.from({ length: count }, (_, index) => ({ index, count: 0 }))
    for (const value of items) {
      const index = Math.min(count - 1, Math.floor(((value - min) / width) * count))
      const bin = bins[index]
      if (bin) bin.count += 1
    }
    return bins
  })
  const peak = () => Math.max(1, ...bars().map((value) => value.count))

  return (
    <section class="data-table-plot" data-slot="table-plot">
      <header>
        <strong>{props.table.columns[props.index]} distribution</strong>
        <div class="data-table-metrics" aria-label="Distribution summary">
          <span>N {stats().count.toLocaleString()}</span>
          <span>Min {number(stats().min)}</span>
          <span>Mean {number(stats().mean)}</span>
          <span>Max {number(stats().max)}</span>
        </div>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </header>
      <svg viewBox="0 0 720 150" role="img" aria-label={`${props.table.columns[props.index]} histogram`}>
        <line x1="24" y1="132" x2="710" y2="132" />
        <For each={bars()}>
          {(bar, index) => {
            const width = 674 / Math.max(1, bars().length)
            const height = (bar.count / peak()) * 112
            return (
              <rect x={28 + index() * width} y={132 - height} width={Math.max(2, width - 3)} height={height} rx="2">
                <title>{bar.count} rows</title>
              </rect>
            )
          }}
        </For>
      </svg>
    </section>
  )
}

function compare(left: string, right: string, type: string) {
  if (!left && right) return 1
  if (left && !right) return -1
  if (type === "number") return Number(left) - Number(right)
  if (type === "date") return Date.parse(left) - Date.parse(right)
  if (type === "boolean") return Number(/^true$/i.test(left)) - Number(/^true$/i.test(right))
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" })
}

const number = (value: number | undefined) =>
  value === undefined ? "—" : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(value)

export default DataTableView
