import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("provider config secrecy", () => {
  test("redacts provider keys and auth headers from the served config", () => {
    const value = Config.redact({
      model: "openai/gpt-5.6",
      provider: {
        mycorp: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            apiKey: "sk-live-secret",
            baseURL: "https://llm.mycorp.example/v1",
            headers: { Authorization: "Bearer gateway-secret", "X-Team": "research" },
          },
          models: {
            "big-model": { name: "Big", headers: { "X-Model-Key": "model-secret" } },
            "plain-model": { name: "Plain" },
          },
        },
        // A block the strict schema rejects still cannot leak its key.
        odd: { options: { apiKey: "sk-odd" }, unexpected: true } as never,
        bare: { name: "No options" },
      },
    })

    expect(value.provider?.mycorp?.options).toEqual({
      apiKey: Config.MCP_SECRET_MASK,
      baseURL: "https://llm.mycorp.example/v1",
      headers: { Authorization: Config.MCP_SECRET_MASK, "X-Team": Config.MCP_SECRET_MASK },
    })
    expect(value.provider?.mycorp?.models?.["big-model"]).toEqual({
      name: "Big",
      headers: { "X-Model-Key": Config.MCP_SECRET_MASK },
    })
    expect(value.provider?.mycorp?.models?.["plain-model"]).toEqual({ name: "Plain" })
    expect((value.provider?.odd as { options: { apiKey: string } }).options.apiKey).toBe(Config.MCP_SECRET_MASK)
    expect(value.provider?.bare).toEqual({ name: "No options" })
    expect(JSON.stringify(value)).not.toContain("secret")
  })

  test("a masked provider secret in an edit leaves the stored value untouched", () => {
    const previous: Config.Info = {
      provider: {
        mycorp: {
          options: { apiKey: "resolved-literal", headers: { Authorization: "Bearer resolved" } },
        },
      },
    }
    const restored = Config.restore(
      {
        provider: {
          mycorp: {
            options: {
              apiKey: Config.MCP_SECRET_MASK,
              baseURL: "https://moved.example/v1",
              headers: { Authorization: Config.MCP_SECRET_MASK, "X-Team": "ops" },
            },
            models: { m: { headers: { "X-Model-Key": Config.MCP_SECRET_MASK, "X-Public": "yes" } } },
          },
          fresh: { options: { apiKey: "sk-new" } },
        },
      },
      previous,
    )

    // The patch carries no key at all, so the file keeps its own form
    // (literal or {env:…}) instead of receiving the resolved literal.
    expect(restored.provider?.mycorp?.options).toEqual({
      baseURL: "https://moved.example/v1",
      headers: { "X-Team": "ops" },
    })
    expect(restored.provider?.mycorp?.models?.m).toEqual({ headers: { "X-Public": "yes" } })
    expect(restored.provider?.fresh?.options).toEqual({ apiKey: "sk-new" })
  })

  test("a project config edit keeps environment references and plugin specifiers as written", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "openscience.json")
    process.env.PROVIDER_SECRETS_TEST_KEY = "resolved-from-env"
    await fs.writeFile(
      file,
      JSON.stringify(
        {
          provider: { mycorp: { options: { apiKey: "{env:PROVIDER_SECRETS_TEST_KEY}" } } },
          plugin: ["my-plugin@1.0.0"],
        },
        null,
        2,
      ),
    )
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const served = Config.redact(await Config.get())
          expect(served.provider?.mycorp?.options?.apiKey).toBe(Config.MCP_SECRET_MASK)

          await Config.update(
            Config.restore(
              { model: "mycorp/big", provider: { mycorp: { options: { apiKey: Config.MCP_SECRET_MASK } } } },
              await Config.get(),
            ),
          )
        },
      })
      const written = JSON.parse(await fs.readFile(file, "utf8")) as Config.Info
      expect(written.model).toBe("mycorp/big")
      expect(written.provider?.mycorp?.options?.apiKey).toBe("{env:PROVIDER_SECRETS_TEST_KEY}")
      expect(written.plugin).toEqual(["my-plugin@1.0.0"])
      expect(await fs.readFile(file, "utf8")).not.toContain("resolved-from-env")
    } finally {
      delete process.env.PROVIDER_SECRETS_TEST_KEY
    }
  })
})
