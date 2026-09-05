import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { detectScientificFile } from "./files"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("detectScientificFile", () => {
  test("routes small-molecule structures into the 3D chemistry renderer", () => {
    expect(detectScientificFile("xyz", "2\nwater\nO 0 0 0\nH 0 0 1")).toEqual({
      kind: "chem-3d",
      data: {
        data: "2\nwater\nO 0 0 0\nH 0 0 1",
        format: "xyz",
      },
      format: "xyz",
    })
  })

  test("routes macromolecular structures case-insensitively", () => {
    expect(detectScientificFile("PDB", "ATOM      1")).toEqual({
      kind: "protein-structure",
      data: {
        data: "ATOM      1",
        format: "pdb",
      },
      format: "pdb",
    })
  })

  test("does not infer a scientific renderer from file contents alone", () => {
    expect(detectScientificFile("txt", "ATOM      1")).toBeUndefined()
  })

  test("does not render empty scientific files", () => {
    expect(detectScientificFile("sdf", "   \n")).toBeUndefined()
  })

  test("uses the first SMILES record for two-dimensional chemistry", () => {
    expect(detectScientificFile("smi", "# compounds\n\nCCO ethanol\nCCC propane")).toEqual({
      kind: "chem-2d",
      data: {
        smiles: "CCO",
        records: 2,
      },
      format: "smiles",
    })
  })

  test("combines wrapped FASTA lines into a single sequence", () => {
    expect(detectScientificFile("fasta", ">alpha human sample\nAC GT\nTG\n")).toEqual({
      kind: "sequence",
      data: {
        id: "alpha human sample",
        sequence: "ACGTTG",
        records: 1,
      },
      format: "fasta",
    })
  })

  test("routes equal-length FASTA records into the alignment viewer", () => {
    expect(detectScientificFile("FA", ">alpha\nACGT\n>beta\nAC-T")).toEqual({
      kind: "msa",
      data: {
        sequences: [
          { id: "alpha", seq: "ACGT" },
          { id: "beta", seq: "AC-T" },
        ],
      },
      format: "fasta",
    })
  })

  test("does not pretend unequal FASTA records form an alignment", () => {
    expect(detectScientificFile("faa", ">alpha\nMKT\n>beta\nMKTA")).toEqual({
      kind: "sequence",
      data: {
        id: "alpha",
        sequence: "MKT",
        records: 2,
      },
      format: "fasta",
    })
  })
})
