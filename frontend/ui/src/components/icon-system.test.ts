import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { iconDefinitions, iconSpecs } from "./iconoir-registry"

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")

describe("shared Iconoir system", () => {
  test("covers the stable public API with distinct semantic glyphs", () => {
    expect(Object.keys(iconSpecs)).toHaveLength(110)
    expect(new Set(Object.values(iconSpecs).map((entry) => entry.source)).size).toBe(97)

    expect(iconSpecs.models.source).toBe("brain-electricity")
    expect(iconSpecs.providers.source).toBe("database-settings")
    expect(iconSpecs.task.source).toBe("task-list")
    expect(iconSpecs.split.source).toBe("vertical-split")
    expect(iconSpecs.network.source).toBe("network")
    expect(iconSpecs.artifact.source).toBe("reports")
    expect(iconSpecs.file.source).toBe("page")
    expect(iconSpecs["folder-tree"].source).toBe("network-reverse")

    const concepts = ["models", "providers", "task", "split", "network", "artifact", "file", "folder-tree"] as const
    expect(new Set(concepts.map((name) => iconSpecs[name].source)).size).toBe(concepts.length)
  })

  test("extracts trusted local SVG bodies without nesting or remote loading", () => {
    for (const definition of Object.values(iconDefinitions)) {
      expect(definition.body.length).toBeGreaterThan(0)
      expect(definition.body).not.toContain("<svg")
      expect(definition.body).not.toContain("http://")
      expect(definition.body).not.toContain("https://")
    }
  })
})
