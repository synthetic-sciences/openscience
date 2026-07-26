import { describe, expect, test } from "bun:test"
import { webAssetContentSecurityPolicy } from "../../src/web/csp"

function directive(policy: string, name: string): string | undefined {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `))
}

describe("web asset content security policy", () => {
  test("keeps JavaScript string evaluation disabled in the application", () => {
    const policy = webAssetContentSecurityPolicy("/index.html")
    expect(directive(policy, "script-src")).toBe("script-src 'self' 'wasm-unsafe-eval'")
    expect(directive(policy, "worker-src")).toBe("worker-src 'self'")
  })

  test("allows RDKit's generated bindings only in its isolated worker", () => {
    const policy = webAssetContentSecurityPolicy("/assets/rdkit.worker-Ab_19-x.js")
    expect(directive(policy, "default-src")).toBe("default-src 'none'")
    expect(directive(policy, "script-src")).toBe("script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'")
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'")
  })

  test("does not relax lookalike asset paths", () => {
    const appPolicy = webAssetContentSecurityPolicy("/index.html")
    expect(webAssetContentSecurityPolicy("/assets/rdkit.worker-abc.js.map")).toBe(appPolicy)
    expect(webAssetContentSecurityPolicy("/assets/rdkit.worker-abc.js/extra")).toBe(appPolicy)
    expect(webAssetContentSecurityPolicy("/other/rdkit.worker-abc.js")).toBe(appPolicy)
  })
})
