import { afterEach, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { saveProviderConnection } from "../../src/server/routes/provider-connection"
import { tmpdir } from "../fixture/fixture"

const original = process.env.OPENAI_API_KEY

afterEach(async () => {
  await Auth.remove("openai")
  await Config.removeProvider("openai")
  if (original === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = original
  Provider.invalidate()
})

test.each(["", "https://provider.example/v1", "http://127.0.0.1:4999/v1"])(
  "removing a saved key disconnects without losing endpoint preferences: %s",
  async (baseURL) => {
    await using tmp = await tmpdir()
    await Config.setProvider("openai", { options: { timeout: 9000 } })
    await saveProviderConnection("openai", { key: "fixture", baseURL, api: "chat" })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        Provider.invalidate()
        expect((await Provider.list()).openai?.source).toBe("api")
        await Auth.remove("openai")
        Provider.invalidate()
        expect((await Provider.list()).openai).toBeUndefined()
        expect((await Config.getGlobal()).provider?.openai?.options).toMatchObject({
          api: "chat",
          timeout: 9000,
          ...(baseURL ? { baseURL } : {}),
        })
        await Auth.set("openai", { type: "api", key: "replacement" })
        Provider.invalidate()
        expect((await Provider.list()).openai?.source).toBe("api")
        await Auth.remove("openai")
        Env.set("OPENAI_API_KEY", "environment-fixture")
        Provider.invalidate()
        expect((await Provider.list()).openai?.source).toBe("env")
      },
    })
  },
)

test("an explicitly configured credential remains connected after removing the local key", async () => {
  await using tmp = await tmpdir()
  await Config.setProvider("openai", { options: { apiKey: "config-fixture" } })
  await saveProviderConnection("openai", { key: "fixture", baseURL: "", api: "responses" })
  await Auth.remove("openai")
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      Provider.invalidate()
      expect((await Provider.list()).openai?.source).toBe("config")
    },
  })
})
