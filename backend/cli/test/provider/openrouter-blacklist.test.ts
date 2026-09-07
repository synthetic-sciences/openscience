import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { tmpdir, trustProject } from "../fixture/fixture"

test("OpenRouter exclusions survive whitelist synthesis for catalog and unknown models", async () => {
  const blocked = ["anthropic/claude-sonnet-5", "fixture/unknown-denied"]
  const allowed = "fixture/unknown-allowed"
  await using tmp = await tmpdir({
    git: true,
    config: {
      provider: {
        openrouter: {
          options: { apiKey: "local-fixture-key", baseURL: "http://127.0.0.1:9/v1" },
          whitelist: [...blocked, allowed],
          blacklist: blocked,
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    init: trustProject,
    fn: async () => {
      const provider = (await Provider.list()).openrouter
      expect(Object.keys(provider.models)).toEqual([allowed])
      await expect(Provider.getModel("openrouter", blocked[0]!)).rejects.toBeInstanceOf(Provider.ModelNotFoundError)
      await expect(Provider.getModel("openrouter", blocked[1]!)).rejects.toBeInstanceOf(Provider.ModelNotFoundError)
      expect((await Provider.getModel("openrouter", allowed)).id).toBe(allowed)
    },
  })
})
