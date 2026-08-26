import { describe, expect, test } from "bun:test"
import { resolveViewer, viewerUsesText } from "./viewer-registry"

describe("viewer registry", () => {
  test("resolves common formats consistently", () => {
    expect(resolveViewer({ name: "report.md" }).kind).toBe("markdown")
    expect(resolveViewer({ name: "analysis.ipynb" }).kind).toBe("notebook")
    expect(resolveViewer({ name: "results.csv" })).toMatchObject({ kind: "table", table: "csv" })
    expect(resolveViewer({ name: "records.json", content: "[{}]" })).toMatchObject({ kind: "table", table: "json" })
    expect(resolveViewer({ name: "paper.pdf" }).kind).toBe("pdf")
    expect(resolveViewer({ name: "plot.png" }).kind).toBe("image")
  })

  test("keeps source formats as text and unfamiliar containers as binary", () => {
    expect(resolveViewer({ name: "analysis.py" })).toMatchObject({ kind: "code", language: "python" })
    expect(viewerUsesText(resolveViewer({ name: "notes.yaml" }))).toBeTrue()
    expect(resolveViewer({ name: "weights.safetensors" }).kind).toBe("binary")
    expect(resolveViewer({ name: "dataset.h5ad", encoding: "base64" }).kind).toBe("binary")
  })
})
