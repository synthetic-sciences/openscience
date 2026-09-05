import { describe, expect, test } from "bun:test"
import path from "node:path"
import { analyzeMolecularSource, narrowMolecularSource } from "./model"

const fixtures = path.join(import.meta.dir, "../../../../e2e/science")

describe("molecular source analysis", () => {
  test("reports declared XYZ count mismatches and malformed coordinate rows", () => {
    expect(analyzeMolecularSource({ xyz: "3\nbad\nO 0 0 0\nH nope 0 1" }, "chem-3d")).toEqual({
      format: "xyz",
      source: "inline",
      atomCount: 1,
      moleculeCount: 1,
      elements: [{ element: "O", count: 1 }],
      warnings: ["XYZ declares 3 atoms but 1 valid coordinate row was parsed."],
    })
  })

  test("keeps remote source metadata honest without pretending it fetched scientific properties", () => {
    expect(analyzeMolecularSource({ url: "https://example.test/model.cif" }, "protein-structure")).toEqual({
      format: "mmcif",
      source: "remote",
      elements: [],
      warnings: ["Scientific properties are available after the remote structure is loaded."],
    })
  })

  test("normalizes supported source shapes for the Molstar renderer", () => {
    expect(narrowMolecularSource("1CBS", "protein-structure")).toEqual({
      url: "https://files.rcsb.org/download/1CBS.cif",
      format: "mmcif",
    })
    expect(narrowMolecularSource({ data: "3\nwater", format: "xyz" }, "chem-3d")).toEqual({
      raw: "3\nwater",
      format: "xyz",
    })
  })
})
