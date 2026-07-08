import { describe, expect, test } from "bun:test"
import { journalName } from "../../src/science/connectors/literature/europepmc"

describe("europepmc journalName", () => {
  test("reads the nested journalInfo.journal.title from a resultType=core record", () => {
    expect(journalName({ journalInfo: { journal: { title: "Nature" } } })).toBe("Nature")
  })

  test("falls back to the top-level journalTitle for lite-shaped records", () => {
    expect(journalName({ journalTitle: "Cell" })).toBe("Cell")
  })

  test("prefers the nested title when both are present", () => {
    expect(journalName({ journalTitle: "Old", journalInfo: { journal: { title: "New" } } })).toBe("New")
  })

  test("returns undefined when no journal is present", () => {
    expect(journalName({})).toBeUndefined()
    expect(journalName({ journalInfo: {} })).toBeUndefined()
    expect(journalName({ journalInfo: { journal: {} } })).toBeUndefined()
  })
})
