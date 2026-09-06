import { afterAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { Platform } from "./platform"

const vite = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: { noExternal: true, resolve: { conditions: ["browser", "production"] } },
})
const runtime = (await vite.ssrLoadModule("solid-js")) as typeof import("solid-js")
const platform = (await vite.ssrLoadModule("/src/context/platform.tsx")) as typeof import("./platform")
const subject = (await vite.ssrLoadModule("/src/context/settings.tsx")) as typeof import("./settings")

afterAll(() => vite.close())

test("reasoning visibility defaults on for older settings and survives desktop provider remounts", async () => {
  const values = new Map([
    ["settings.v3", JSON.stringify({ general: { autoSave: false }, appearance: { fontSize: 16 } })],
  ])
  const desktop = {
    platform: "desktop",
    storage: () => ({
      async getItem(key: string) {
        return values.get(key) ?? null
      },
      async setItem(key: string, value: string) {
        values.set(key, value)
      },
      async removeItem(key: string) {
        values.delete(key)
      },
    }),
  } as Platform
  const cleanups: Array<() => void> = []
  const mount = async () => {
    const current: { settings?: ReturnType<typeof subject.useSettings> } = {}
    runtime.createRoot((dispose) => {
      cleanups.push(dispose)
      platform.PlatformProvider({
        value: desktop,
        get children() {
          return runtime.untrack(() =>
            subject.SettingsProvider({
              get children() {
                current.settings = subject.useSettings()
                return undefined
              },
            }),
          )
        },
      })
    })
    for (let attempt = 0; attempt < 50 && !current.settings; attempt++) await Bun.sleep(1)
    if (!current.settings) throw new Error("Settings provider did not hydrate")
    return current.settings
  }

  try {
    const first = await mount()
    expect(first.general.showReasoning()).toBe(true)
    expect(first.general.autoSave()).toBe(false)
    first.general.setShowReasoning(false)
    expect(first.general.showReasoning()).toBe(false)
    cleanups.pop()?.()

    const second = await mount()
    expect(second.general.showReasoning()).toBe(false)
    expect(second.general.autoSave()).toBe(false)
    expect(second.appearance.fontSize()).toBe(16)
    second.general.setShowReasoning(true)
    cleanups.pop()?.()

    const third = await mount()
    expect(third.general.showReasoning()).toBe(true)
    expect(third.appearance.fontSize()).toBe(16)
  } finally {
    cleanups.splice(0).forEach((dispose) => dispose())
  }
})
