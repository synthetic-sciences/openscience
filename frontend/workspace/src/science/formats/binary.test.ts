import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { detectBinaryScienceFormat, embedding, formatBytes, normalizeInspection } from "./binary"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

describe("binary scientific format helpers", () => {
  test.each([
    ["bam", "bam"],
    ["CRAM", "cram"],
    ["h5ad", "h5ad"],
    ["loom", "loom"],
  ])("detects %s", (extension, format) => {
    expect(detectBinaryScienceFormat(extension)).toBe(format as ReturnType<typeof detectBinaryScienceFormat>)
  })

  test("does not claim generic binaries", () => {
    expect(detectBinaryScienceFormat("bin")).toBeUndefined()
  })

  test("formats scientific file sizes compactly", () => {
    expect(formatBytes(1024)).toBe("1 KB")
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB")
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3 GB")
  })

  test("normalizes malformed API data into a safe inspection", () => {
    expect(
      normalizeInspection({ format: "bam", size: 12, tool: { name: "samtools", available: false } }),
    ).toMatchObject({
      format: "bam",
      size: 12,
      signature: false,
      details: {},
      tool: { name: "samtools", available: false },
    })
  })

  test("normalizes finite embedding previews and preserves categorical labels", () => {
    expect(
      embedding({
        name: "X_umap",
        label: "cell_type",
        total: 10_000,
        points: [
          { x: 1, y: 2, label: "T cell" },
          { x: Number.NaN, y: 3, label: "invalid" },
          { x: -4, y: 5, label: "B cell" },
        ],
      }),
    ).toEqual({
      name: "X_umap",
      label: "cell_type",
      total: 10_000,
      points: [
        { x: 1, y: 2, label: "T cell" },
        { x: -4, y: 5, label: "B cell" },
      ],
    })
  })
})
