import { describe, expect, test } from "bun:test"

const source = Bun.file(new URL("./Compute.tsx", import.meta.url)).text()

describe("Compute Settings interaction contract", () => {
  test("isolates busy state so unrelated compute controls remain usable", async () => {
    const component = await source

    expect(component).toContain("busy: {} as Record<string, boolean>")
    expect(component).toContain('const modalBusy = () => hasBusyPrefix("modal:")')
    expect(component).toContain("const busyKey = `ssh:test:${item.id}`")
    expect(component).toContain("const busyKey = `ssh:remove:${item.id}`")
    expect(component).not.toContain("disabled={Boolean(busy())}")
  })

  test("preserves unsaved Modal edits across background resource updates", async () => {
    const component = await source

    expect(component).toContain("let modalHydrated = false")
    expect(component).toContain("if (modalHydrated && dirty()) return")
  })

  test("uses the shared flat panel language and responsive action regions", async () => {
    const component = await source

    expect(component).toContain('class="settings-preferences-panel settings-preferences-panel--compute"')
    expect(component).toContain('class="settings-compute-host-actions"')
    expect(component).toContain('class="settings-compute-actions"')
    expect(component).toContain('import "./preference-panels.css"')
  })

  test("keeps SSH operational notes editable and explicitly advisory", async () => {
    const component = await source

    expect(component).toContain('method: "PATCH"')
    expect(component).toContain('class="settings-compute-host-notes-copy"')
    expect(component).toContain('class="settings-compute-host-notes-editor"')
    expect(component).toContain("Advisory only. Notes are shown during review and never run as commands.")
    expect(component).toContain('placeholder="Modules, partitions, scratch paths, or installation rules"')
  })

  test("offers explicit import for literal ~/.ssh/config hosts", async () => {
    const component = await source

    expect(component).toContain("From ~/.ssh/config")
    expect(component).toContain("Literal host entries only")
    expect(component).toContain("const importHost = async")
    expect(component).toContain("host: item.hostname ?? item.alias")
    expect(component).toContain("identity files")
    expect(component).toContain("proxy commands")
    expect(component).toContain('method: "POST"')
  })
})
