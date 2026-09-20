import { afterEach, describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"

const realFetch = globalThis.fetch

/** Answer every release lookup with the body its own source would return and
 *  record which URL was asked. Nothing here reaches the network. */
function stub(body: unknown) {
  const asked: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    asked.push(String(input instanceof Request ? input.url : input))
    return Response.json(body)
  }) as unknown as typeof fetch
  return asked
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("Installation.latest", () => {
  test("resolves a desktop copy from the GitHub release the app bundles ship in", async () => {
    // The desktop app is published as signed release assets, not to npm, so a
    // desktop install must not be told the npm dist-tag's version.
    const asked = stub({ tag_name: "v9.8.7" })

    expect(await Installation.latest("desktop")).toBe("9.8.7")
    expect(asked).toEqual(["https://api.github.com/repos/synthetic-sciences/OpenScience/releases/latest"])
  })

  test("resolves a package-manager copy from its npm channel tag", async () => {
    const asked = stub({ version: "9.8.6" })

    expect(await Installation.latest("npm")).toBe("9.8.6")
    expect(asked).toEqual([`https://registry.npmjs.org/@synsci/openscience/${Installation.npmReleaseChannel()}`])
  })
})
