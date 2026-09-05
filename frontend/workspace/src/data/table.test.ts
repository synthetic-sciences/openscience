import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { exportDelimited, parseTable, summarizeColumn } from "./table"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("tabular data model", () => {
  test("parses quoted CSV fields, escaped quotes, and embedded newlines", () => {
    const table = parseTable("csv", 'sample,value,note\nA,4,"first, row"\nB,,"line 1\nline 2"\nC,8,"said ""yes"""')

    expect(table.columns).toEqual(["sample", "value", "note"])
    expect(table.rows).toEqual([
      ["A", "4", "first, row"],
      ["B", "", "line 1\nline 2"],
      ["C", "8", 'said "yes"'],
    ])
    expect(table.totalRows).toBe(3)
    expect(table.truncated).toBe(false)
  })

  test("parses TSV, JSON arrays, and JSON Lines into one table shape", () => {
    expect(parseTable("tsv", "gene\tcount\nTP53\t12").rows).toEqual([["TP53", "12"]])
    expect(parseTable("json", '[{"gene":"TP53","count":12},{"gene":"EGFR","active":true}]')).toMatchObject({
      columns: ["gene", "count", "active"],
      rows: [
        ["TP53", "12", ""],
        ["EGFR", "", "true"],
      ],
    })
    expect(parseTable("jsonl", '{"gene":"TP53","count":12}\n{"gene":"EGFR","count":8}\n')).toMatchObject({
      columns: ["gene", "count"],
      rows: [
        ["TP53", "12"],
        ["EGFR", "8"],
      ],
    })
  })

  test("infers numeric, boolean, date, and string schemas with missingness", () => {
    const table = parseTable(
      "csv",
      "value,passed,date,label\n1,true,2026-01-01,alpha\n2,false,2026-01-02,beta\n,TRUE,,alpha",
    )

    expect(table.schema).toEqual([
      { name: "value", type: "number", missing: 1, unique: 2 },
      { name: "passed", type: "boolean", missing: 0, unique: 2 },
      { name: "date", type: "date", missing: 1, unique: 2 },
      { name: "label", type: "string", missing: 0, unique: 2 },
    ])
    expect(summarizeColumn(table, 0)).toMatchObject({ min: 1, max: 2, mean: 1.5, count: 2, missing: 1 })
  })

  test("caps preview rows while retaining the total count", () => {
    const body = `value\n${Array.from({ length: 12 }, (_, index) => index).join("\n")}`
    const table = parseTable("csv", body, 5)

    expect(table.rows).toHaveLength(5)
    expect(table.totalRows).toBe(12)
    expect(table.truncated).toBe(true)
  })

  test("exports selected rows with correct CSV quoting", () => {
    expect(
      exportDelimited(
        {
          columns: ["name", "note"],
          rows: [
            ["A", "plain"],
            ["B", 'comma, quote " and\nnewline'],
          ],
        },
        ",",
      ),
    ).toBe('name,note\nA,plain\nB,"comma, quote "" and\nnewline"\n')
  })

  test("rejects non-tabular JSON with a useful error", () => {
    expect(() => parseTable("json", '{"nested":{"value":1}}')).toThrow("array of records")
  })
})
