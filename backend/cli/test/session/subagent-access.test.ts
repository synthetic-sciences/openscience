import { expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { resolveAccessRoute } from "../../src/session/access-route"
import { tmpdir } from "../fixture/fixture"

for (const [providerID, variable] of [
  ["openai", "OPENAI_API_KEY"],
  ["anthropic", "ANTHROPIC_API_KEY"],
] as const) {
  for (const source of ["env", "config", "saved"] as const) {
    test(`${source} ${providerID} API keys select the paid allowance route`, async () => {
      const previous = { key: process.env[variable], auth: await Auth.get(providerID) }
      if (source === "env") process.env[variable] = "sk-subagent-fixture-only"
      else delete process.env[variable]
      if (source === "saved") await Auth.set(providerID, { type: "api", key: "sk-old-saved-fixture" })
      else await Auth.remove(providerID)
      try {
        await using tmp = await tmpdir({
          git: true,
          config: {
            provider: { [providerID]: source !== "env" ? { options: { apiKey: "sk-subagent-fixture-only" } } : {} },
          },
        })
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const provider = await Provider.getProvider(providerID)
            expect(Provider.effectiveKey(provider)).toBe("sk-subagent-fixture-only")
            expect(await resolveAccessRoute(providerID, Object.keys(provider.models)[0]!)).toBe("byok")
          },
        })
      } finally {
        if (previous.key === undefined) delete process.env[variable]
        else process.env[variable] = previous.key
        if (previous.auth) await Auth.set(providerID, previous.auth)
        else await Auth.remove(providerID)
      }
    })
  }
}
