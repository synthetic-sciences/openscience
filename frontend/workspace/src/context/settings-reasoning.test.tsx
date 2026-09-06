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

test.each([undefined, false, true])(
  "legacy global reasoning preference %s is ignored without resetting settings",
  async (showReasoning) => {
    const saved = {
      general: { autoSave: false, releaseNotes: false, ...(showReasoning === undefined ? {} : { showReasoning }) },
      appearance: { fontSize: 16, font: "fira-code" },
      keybinds: { "session.new": "mod+shift+n" },
    }
    const values = new Map([["settings.v3", JSON.stringify(saved)]])
    const removed: string[] = []
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
          removed.push(key)
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
      expect("showReasoning" in first.general).toBe(false)
      expect("setShowReasoning" in first.general).toBe(false)
      expect(first.general.autoSave()).toBe(false)
      expect(first.general.releaseNotes()).toBe(false)
      expect(first.appearance.font()).toBe("fira-code")
      expect(first.appearance.fontSize()).toBe(16)
      expect(first.keybinds.get("session.new")).toBe("mod+shift+n")
      first.general.setAutoSave(true)
      cleanups.pop()?.()

      const second = await mount()
      expect("showReasoning" in second.general).toBe(false)
      expect(second.general.autoSave()).toBe(true)
      expect(second.general.releaseNotes()).toBe(false)
      expect(second.appearance.fontSize()).toBe(16)
      expect(second.appearance.font()).toBe("fira-code")
      expect(second.keybinds.get("session.new")).toBe("mod+shift+n")
      // The obsolete field may remain on disk for compatibility; it is not a
      // reason to rewrite or erase the user's preference store.
      expect(JSON.parse(values.get("settings.v3")!).general.showReasoning).toBe(showReasoning)
      expect(removed).toEqual([])
    } finally {
      cleanups.splice(0).forEach((dispose) => dispose())
    }
  },
)
