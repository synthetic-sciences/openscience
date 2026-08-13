import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { iconDefinitions, iconSpecs } from "./iconoir-registry"

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8")

describe("shared Iconoir system", () => {
  test("renders one decorative 24px coordinate system", () => {
    const source = read("./icon.tsx")

    expect(source).toContain('viewBox="0 0 24 24"')
    expect(source).toContain('preserveAspectRatio="xMidYMid meet"')
    expect(source).toContain("data-icon={local.name}")
    expect(source).toContain("data-icon-source={definition().source}")
    expect(source.match(/aria-hidden="true"/g)).toHaveLength(2)
  })

  test("bundles only the explicit Iconoir subset", () => {
    const registry = read("./iconoir-registry.ts")
    const pkg = JSON.parse(read("../../package.json")) as { dependencies: Record<string, string> }

    expect(pkg.dependencies.iconoir).toBe("7.12.1")
    expect(registry.match(/from "iconoir\/icons\/.+\.svg\?raw"/g)).toHaveLength(97)
    expect(registry).not.toContain("iconoir.css")
    expect(registry).not.toContain("iconoir-regular.css")
    expect(registry).not.toContain("fetch(")
  })

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

  test("uses a compact optical scale and one rounded stroke language", () => {
    const styles = read("./icon.css")

    expect(styles).toContain("--icon-size: 18px")
    expect(styles).toContain("--icon-stroke-width: 1.5")
    expect(styles).toContain('[data-size="small"]')
    expect(styles).toContain("--icon-size: 16px")
    expect(styles).toContain('[data-size="medium"]')
    expect(styles).toContain("--icon-size: 20px")
    expect(styles).toContain("stroke-width: var(--icon-stroke-width)")
    expect(styles).toContain("stroke-linecap: round")
    expect(styles).toContain("stroke-linejoin: round")
    expect(styles).toContain("pointer-events: none")
  })

  test("keeps provider and file brands on their dedicated sprite systems", () => {
    const provider = read("./provider-icon.tsx")
    const file = read("./file-icon.tsx")

    expect(provider).toContain('import sprite from "./provider-icons/sprite.svg"')
    expect(file).toContain('import sprite from "./file-icons/sprite.svg"')
  })

  test("gives icon controls a Fitts-safe target independent of glyph size", () => {
    const styles = read("./icon-button.css")

    expect(styles).toContain("appearance: none")
    expect(styles).toContain("border: 0")
    expect(styles).toContain("background: transparent")
    expect(styles).toContain("width: 32px")
    expect(styles).toContain("height: 32px")
    expect(styles).toContain("min-width: 44px")
    expect(styles).toContain("min-height: 44px")
  })
})
