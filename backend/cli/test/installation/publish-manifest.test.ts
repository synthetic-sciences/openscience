import { describe, expect, test } from "bun:test"
import { assertPublicPackageSurface, createWrapperPackageManifest } from "../../script/publish-manifest"

describe("wrapper package manifest", () => {
  test("preserves declared optional companions while adding platform packages", () => {
    const manifest = createWrapperPackageManifest({
      source: {
        name: "@synsci/openscience",
        optionalDependencies: {
          "@synsci/companion": "^1.2.3",
        },
      },
      version: "1.2.3",
      binaries: {
        "@synsci/openscience-darwin-arm64": "1.2.3",
        "@synsci/openscience-linux-x64": "1.2.3",
      },
    })

    expect(manifest.optionalDependencies).toEqual({
      "@synsci/companion": "^1.2.3",
      "@synsci/openscience-darwin-arm64": "1.2.3",
      "@synsci/openscience-linux-x64": "1.2.3",
    })
  })

  test("publishes OpenScience with native packages and no Atlas dependency", async () => {
    const source = await Bun.file(new URL("../../package.json", import.meta.url)).json()
    const manifest = createWrapperPackageManifest({
      source,
      version: "1.2.3",
      binaries: {
        "@synsci/openscience-darwin-arm64": "1.2.3",
      },
    })

    expect(manifest.optionalDependencies).toEqual({
      "@synsci/openscience-darwin-arm64": "1.2.3",
    })
    expect(manifest.optionalDependencies).not.toHaveProperty("@synsci/atlas")
  })

  test("keeps postinstall verification advisory when lifecycle scripts are enabled", () => {
    const manifest = createWrapperPackageManifest({
      source: {
        name: "@synsci/openscience",
      },
      version: "1.2.3",
      binaries: {
        "@synsci/openscience-darwin-arm64": "1.2.3",
      },
    })

    expect(manifest.scripts.postinstall).toEndWith("|| exit 0")
  })

  test("rejects retired product and billing copy from npm-visible files", () => {
    expect(() => assertPublicPackageSurface({ "README.md": "OpenScience by Synthetic Sciences" })).not.toThrow()
    for (const copy of [
      "Install the Atlas CLI",
      "Managed compute is included",
      "Ace+ includes 150 credits",
      "Synthetic Scientists access",
      "$50 or $200, one-time or recurring monthly",
      "/initialize-atlas-graph",
      "/initialize-research-graph",
    ]) {
      expect(() => assertPublicPackageSurface({ "README.md": copy })).toThrow("retired public copy")
    }
  })
})
