import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import solid from "vite-plugin-solid"

const server = await createServer({
  root: fileURLToPath(new URL("../../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const subject = (await server.ssrLoadModule("/src/components/settings/Storage.tsx")) as typeof import("./Storage")

afterAll(() => server.close())

describe("Storage settings recovery", () => {
  test("targets the explicit refresh endpoint only for a requested refresh", () => {
    expect(subject.storageUsagePath()).toBe("/settings/storage")
    expect(subject.storageUsagePath(true)).toBe("/settings/storage?refresh=1")

    const source = readFileSync(fileURLToPath(new URL("./Storage.tsx", import.meta.url)), "utf8")
    expect(source).toContain("const retry = () => load({ background: Boolean(usage()), refresh: true })")
    expect(source.match(/onClick=\{\(\) => void retry\(\)\}/g)).toHaveLength(2)
  })

  test("distinguishes picker cancellation, selection, and a host error", async () => {
    await expect(subject.storageLocationChoice(async () => null)).resolves.toEqual({ kind: "cancelled" })
    await expect(subject.storageLocationChoice(async () => ["/data/selected", "/data/ignored"])).resolves.toEqual({
      kind: "selected",
      path: "/data/selected",
    })
    await expect(
      subject.storageLocationChoice(async () => {
        throw new Error("native bridge unavailable")
      }),
    ).resolves.toEqual({ kind: "error", message: "native bridge unavailable" })

    const source = readFileSync(fileURLToPath(new URL("./Storage.tsx", import.meta.url)), "utf8")
    expect(source).toContain("const [picker, setPicker] = createSignal<string>()")
    expect(source).toContain("Enter a path manually below.")
    expect(source).toContain("<Show when={picker()}>")
    expect(source).not.toContain("setError(`The system folder picker could not open.")
  })

  test("describes active phases without fake percentages and offers truthful interrupted recovery", () => {
    expect(subject.storageRelocationCopy({ phase: "copying", active: true })).toEqual({
      title: "Copying and verifying data",
      detail: "The current location remains active until the verified copy is ready.",
      tone: "neutral",
    })
    expect(subject.storageRelocationCopy({ phase: "publishing", active: false })).toEqual({
      title: "Storage move was interrupted",
      detail: "Your current data is still protected. Resume to recover the verified transaction safely.",
      tone: "warning",
    })

    const source = readFileSync(fileURLToPath(new URL("./Storage.tsx", import.meta.url)), "utf8")
    expect(source).toContain("Resume safely")
    expect(source).not.toContain("aria-valuenow={relocation")
  })

  test("keeps cache cleanup local, explicit, and immediately responsive", () => {
    const source = readFileSync(fileURLToPath(new URL("./Storage.tsx", import.meta.url)), "utf8")

    expect(source).toContain('"/settings/storage/cache"')
    expect(source).toContain('{ method: "DELETE" }')
    expect(source).toContain("Local cache cleared")
    expect(source).toContain('clearing() ? "Clearing…" : "Clear cache"')
    expect(source).not.toMatch(/account|sign[ -]?in|hosted service/iu)
  })
})
