import { describe, expect, test } from "bun:test"

const files = {
  composer: await Bun.file(new URL("./prompt-input.css", import.meta.url)).text(),
  chat: await Bun.file(new URL("./chat-surface.css", import.meta.url)).text(),
  settings: await Bun.file(new URL("./model-settings-popover.css", import.meta.url)).text(),
  models: await Bun.file(new URL("./dialog-select-model.css", import.meta.url)).text(),
  servers: await Bun.file(new URL("./dialog-select-server.css", import.meta.url)).text(),
}

describe("live interaction radius contract", () => {
  test("routes every non-zero radius through a semantic token", () => {
    for (const [name, css] of Object.entries(files)) {
      const radii = [...css.matchAll(/border-radius:\s*([^;]+);/g)].map((match) => match[1]!.replace(/\s+/g, " "))

      expect(radii.length, `${name} should own at least one radius`).toBeGreaterThan(0)
      for (const radius of radii) {
        expect(radius, `${name}: ${radius}`).not.toMatch(/\d+(?:\.\d+)?px/)
        expect(radius, `${name}: ${radius}`).toMatch(/var\(--|^(?:0|50%|inherit)$/)
      }
    }
  })

  test("keeps pills, message surfaces, and sheet shapes explicit", () => {
    expect(files.composer).toContain("--composer-radius-pill: 999px")
    expect(files.composer).toContain("border-radius: var(--composer-radius-pill)")
    expect(files.servers).toContain("--server-radius-pill: 999px")
    expect(files.servers).toContain("border-radius: var(--server-radius-pill)")
    expect(files.chat).toContain("--chat-radius-pill: 999px")
    expect(files.chat).toContain("border-radius: var(--chat-radius-pill)")
    expect(files.chat).toContain("--user-message-radius: var(--radius-sm)")
    expect(files.chat).toContain("border-radius: var(--user-message-radius)")
    expect(files.chat).not.toContain("--user-message-tail-radius")
    expect(files.settings).toContain("border-radius: var(--radius-lg) var(--radius-lg) 0 0 !important")
    expect(files.models).toContain("border-radius: var(--radius-xl) var(--radius-xl) 0 0")
  })

  test("keeps necessary positioning overrides while avoiding cascade-force for local edges", () => {
    expect(files.composer).toContain("outline: 2px solid var(--color-focus);")
    expect(files.composer).not.toContain("outline: 2px solid var(--color-focus) !important")
    expect(files.settings).toContain(
      '[data-component="button"][data-variant="ghost"][data-model-settings-trigger-style="label"]',
    )
    expect(files.settings).toContain("border-radius: var(--radius-md);")
    expect(files.settings).not.toContain("border-radius: var(--radius-md) !important")
    expect(files.models).toContain('.model-picker-sheet [data-component="button"].model-picker-sheet__manage')
    expect(files.servers).toContain("margin: 0;")
    expect(files.servers).not.toContain("margin: 0 !important")
    expect(files.settings).toContain("transform: none !important")
  })

  test("uses solid semantic structure and limits tint mixing to restrained state and common-region surfaces", () => {
    // The composer keeps its base surface solid. Tint mixing is confined to
    // the suggestion elevation and the compact delegation segmented control.
    expect(files.composer.match(/color-mix/g)).toHaveLength(6)
    expect(files.composer).toContain("border: 1px solid color-mix(in srgb, var(--color-border) 88%, transparent)")
    expect(files.composer).toContain(
      "background: color-mix(in srgb, var(--surface-raised-base-hover) 62%, transparent)",
    )
    expect(files.chat.match(/color-mix/g)).toHaveLength(4)
    expect(files.chat).toContain("border: 1px solid color-mix(in srgb, var(--color-border) 72%, transparent)")
    expect(files.settings.match(/color-mix/g)).toHaveLength(1)
    expect(files.models).not.toContain("color-mix")
    expect(files.servers.match(/color-mix/g)).toHaveLength(2)

    expect(files.composer).toContain("border: 1px solid var(--border-weak-base)")
    expect(files.chat).toContain("box-shadow: none")
    expect(files.servers).toContain("border: 1px solid var(--border-base)")
    expect(files.servers).toContain("border-top: 1px solid var(--border-weak-base)")
    expect(files.settings).toContain("--model-control-shadow: var(--atlas-shadow-md)")
    expect(files.settings).toContain("box-shadow: var(--model-control-shadow)")
    expect(files.models).toContain("box-shadow: var(--atlas-shadow-float)")
    expect(Object.values(files).join("\n")).not.toContain("#000")
  })
})
