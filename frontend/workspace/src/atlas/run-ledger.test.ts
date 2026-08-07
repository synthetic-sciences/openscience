import { describe, expect, test } from "bun:test"
import { ledger } from "./run-ledger"
import type { Status } from "@/atlas/ComputeJobsAPI"

const run = (status: Status, target = "Modal") => ({ status, target_label: target })

describe("run ledger", () => {
  test("numbers rows by the position the reader sees, newest first", () => {
    // The API returns newest first, so 01 is the newest run — the number is a
    // position in the list, not an identifier.
    const rows = ledger([run("succeeded"), run("failed"), run("cancelled")])

    expect(rows.map((row) => row.index)).toEqual(["01", "02", "03"])
  })

  test("pads past nine so the column stays aligned", () => {
    const rows = ledger(Array.from({ length: 11 }, () => run("succeeded")))

    expect(rows[8]?.index).toBe("09")
    expect(rows[9]?.index).toBe("10")
  })

  test("states the status on every row, not only where something is wrong", () => {
    // The deliberate reversal: in a ledger the status is a column, and a column
    // with holes is harder to scan than one that is always filled.
    const rows = ledger([run("succeeded"), run("running"), run("failed")])

    expect(rows.map((row) => row.statusLabel)).toEqual(["Succeeded", "Running", "Failed"])
  })

  test("names a semantic tone rather than a colour", () => {
    const rows = ledger([
      run("succeeded"),
      run("failed"),
      run("interrupted"),
      run("cancelled"),
      run("running"),
      run("queued"),
    ])

    expect(rows.map((row) => row.tone)).toEqual(["success", "danger", "danger", "muted", "active", "muted"])
  })

  test("upper-cases the target so the two mono columns sit together", () => {
    const rows = ledger([run("succeeded", "This computer"), run("succeeded", "Modal")])

    // The target reads as the server names it rather than being shouted.
    expect(rows.map((row) => row.target)).toEqual(["This computer", "Modal"])
  })

  test("keeps every field the caller passed in", () => {
    const rows = ledger([{ status: "failed" as Status, target_label: "Modal", id: "job_1", name: "cifar" }])

    expect(rows[0]).toMatchObject({ id: "job_1", name: "cifar", status: "failed", statusLabel: "Failed", index: "01" })
  })

  test("returns nothing for an empty list", () => {
    expect(ledger([])).toEqual([])
  })
})
