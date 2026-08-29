import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Config } from "../../src/config/config"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"
import { McpSecretStorage } from "../../src/mcp/secret-storage"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("MCP config secrecy", () => {
  test("redacts local environment values and remote headers and client secrets", () => {
    const value = Config.redact({
      model: "openai/gpt-5.6",
      mcp: {
        local: {
          type: "local",
          command: ["bun", "server.mjs"],
          environment: {
            TOKEN: "local-secret",
          },
        },
        remote: {
          type: "remote",
          url: "https://mcp.example.com/mcp",
          headers: {
            Authorization: "Bearer remote-secret",
          },
          oauth: {
            clientId: "public-client",
            clientSecret: "oauth-secret",
          },
        },
        disabled: {
          enabled: false,
        },
      },
    })

    expect(value.model).toBe("openai/gpt-5.6")
    expect(value.mcp?.local).toEqual({
      type: "local",
      command: ["bun", "server.mjs"],
      environment: {
        TOKEN: Config.MCP_SECRET_MASK,
      },
    })
    expect(value.mcp?.remote).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: Config.MCP_SECRET_MASK,
      },
      oauth: {
        clientId: "public-client",
        clientSecret: Config.MCP_SECRET_MASK,
      },
    })
    expect(value.mcp?.disabled).toEqual({ enabled: false })
  })

  test("restores masked values on edit while allowing explicit deletion", () => {
    const previous: Config.Mcp = {
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: "Bearer original",
        "X-Remove-Me": "old",
      },
      oauth: {
        clientId: "client",
        clientSecret: "oauth-original",
      },
      timeout: 5_000,
    }
    const next = Config.restoreMcp(
      {
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: {
          Authorization: Config.MCP_SECRET_MASK,
          "X-New": "new",
        },
        oauth: {
          clientId: "client",
          clientSecret: Config.MCP_SECRET_MASK,
        },
        timeout: 8_000,
      },
      previous,
    )

    expect(next).toEqual({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: {
        Authorization: "Bearer original",
        "X-New": "new",
      },
      oauth: {
        clientId: "client",
        clientSecret: "oauth-original",
      },
      timeout: 8_000,
    })
  })

  test("never carries masked secrets across a changed remote or local authority", () => {
    expect(() =>
      Config.restoreMcp(
        {
          type: "remote",
          url: "https://replacement.example/mcp",
          headers: { Authorization: Config.MCP_SECRET_MASK },
        },
        {
          type: "remote",
          url: "https://original.example/mcp",
          headers: { Authorization: "Bearer original" },
        },
      ),
    ).toThrow(/Replace the masked value/)

    expect(() =>
      Config.restoreMcp(
        {
          type: "remote",
          url: "https://mcp.example/mcp",
          oauth: { clientId: "replacement-client", clientSecret: Config.MCP_SECRET_MASK },
        },
        {
          type: "remote",
          url: "https://mcp.example/mcp",
          oauth: { clientId: "original-client", clientSecret: "original-secret" },
        },
      ),
    ).toThrow(/Replace the masked value/)

    expect(() =>
      Config.restoreMcp(
        { type: "local", command: ["attacker"], environment: { TOKEN: Config.MCP_SECRET_MASK } },
        { type: "local", command: ["trusted"], environment: { TOKEN: "original" } },
      ),
    ).toThrow(/Replace the masked value/)
  })

  test("fails closed when a mask has no stored value", () => {
    expect(() =>
      Config.restoreMcp({
        type: "local",
        command: ["bun", "server.mjs"],
        environment: {
          TOKEN: Config.MCP_SECRET_MASK,
        },
      }),
    ).toThrow(/Replace the masked value/)

    expect(() =>
      Config.restoreMcp({
        type: "remote",
        url: "https://mcp.example.com/mcp",
        oauth: {
          clientSecret: Config.MCP_SECRET_MASK,
        },
      }),
    ).toThrow(/Replace the masked value/)
  })

  test("restores MCP secrets inside a general config patch", () => {
    const previous: Config.Info = {
      mcp: {
        local: {
          type: "local",
          command: ["bun", "server.mjs"],
          environment: {
            TOKEN: "original",
          },
        },
      },
    }
    const patch: Config.Info = {
      model: "openai/gpt-5.6",
      mcp: {
        local: {
          type: "local",
          command: ["bun", "server.mjs"],
          environment: {
            TOKEN: Config.MCP_SECRET_MASK,
          },
        },
      },
    }

    expect(Config.restore(patch, previous)).toEqual({
      model: "openai/gpt-5.6",
      mcp: {
        local: {
          type: "local",
          command: ["bun", "server.mjs"],
          environment: {
            TOKEN: "original",
          },
        },
      },
    })
  })

  test("migrates plaintext MCP fields to sealed JSON before returning them to runtime", async () => {
    const secret = `legacy-header-${crypto.randomUUID()}`
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(
          path.join(dir, "openscience.json"),
          JSON.stringify({
            mcp: {
              migrated: {
                type: "remote",
                url: "https://mcp.example.com",
                headers: { Authorization: `Bearer ${secret}` },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Config.get()).mcp?.migrated).toMatchObject({
          headers: { Authorization: `Bearer ${secret}` },
        })
        const disk = await fs.readFile(path.join(tmp.path, "openscience.json"), "utf8")
        expect(disk).toContain("openscience-secret:v2:")
        expect(disk).not.toContain(secret)
      },
    })
  })

  test("migrates legacy unbound ciphertext to a verified authority-bound envelope", async () => {
    const secret = `legacy-v1-${crypto.randomUUID()}`
    const legacy = await McpSecretStorage.seal(secret)
    expect(legacy).toStartWith(McpSecretStorage.PREFIX)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(
          path.join(dir, "openscience.json"),
          JSON.stringify({
            mcp: {
              migrated: {
                type: "remote",
                url: "https://mcp.example.com",
                headers: { Authorization: legacy },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await Config.get()).mcp?.migrated).toMatchObject({ headers: { Authorization: secret } })
        const disk = await fs.readFile(path.join(tmp.path, "openscience.json"), "utf8")
        expect(disk).toContain(McpSecretStorage.BOUND_PREFIX)
        expect(disk).not.toContain(legacy)
        expect(disk).not.toContain(secret)
      },
    })
  })

  test("seals new local environment, remote headers, and client secrets before config commit", async () => {
    const marker = crypto.randomUUID()
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.update({
          mcp: {
            local: {
              type: "local",
              command: ["node", "server.js"],
              environment: { TOKEN: `local-${marker}` },
            },
            remote: {
              type: "remote",
              url: "https://mcp.example.com",
              headers: { Authorization: `Bearer header-${marker}` },
              oauth: { clientId: "public", clientSecret: `client-${marker}` },
            },
          },
        })
        const disk = await fs.readFile(path.join(tmp.path, "openscience.jsonc"), "utf8")
        expect(disk).toContain("openscience-secret:v2:")
        expect(disk).not.toContain(marker)
      },
    })
  })

  test("general project config edits publish an MCP authority revision", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Config.update({
          mcp: {
            lifecycle: {
              type: "remote",
              url: "https://mcp.example.com",
              headers: { Authorization: "Bearer scoped-secret" },
            },
          },
        })
        const revision = JSON.parse(await fs.readFile(CredentialLifecycle.revisionPath(), "utf8")) as {
          phase: string
          reason: string
        }
        expect(revision).toMatchObject({ phase: "ready", reason: "mcp-config.project-update" })
      },
    })
  })

  test("bound ciphertext cannot be transplanted to another connector authority or field", async () => {
    const protectedConfig = await McpSecretStorage.protect({
      mcp: {
        original: {
          type: "remote",
          url: "https://original.example/mcp",
          headers: { Authorization: "Bearer bound-secret" },
        },
      },
    })
    const ciphertext = protectedConfig.mcp.original.headers.Authorization
    expect(ciphertext).toStartWith(McpSecretStorage.BOUND_PREFIX)

    await expect(
      McpSecretStorage.reveal({
        mcp: {
          original: {
            type: "remote",
            url: "https://replacement.example/mcp",
            headers: { Authorization: ciphertext },
          },
        },
      }),
    ).rejects.toThrow(/different connector authority or field/)
    await expect(
      McpSecretStorage.reveal({
        mcp: {
          renamed: {
            type: "remote",
            url: "https://original.example/mcp",
            headers: { Authorization: ciphertext },
          },
        },
      }),
    ).rejects.toThrow(/different connector authority or field/)
  })

  test("reveals bound secrets before expanding authority references", async () => {
    const names = {
      url: `MCP_REFERENCE_URL_${crypto.randomUUID().replaceAll("-", "")}`,
      client: `MCP_REFERENCE_CLIENT_${crypto.randomUUID().replaceAll("-", "")}`,
      command: `MCP_REFERENCE_COMMAND_${crypto.randomUUID().replaceAll("-", "")}`,
    }
    process.env[names.url] = "https://referenced.example/mcp"
    process.env[names.client] = "referenced-client"
    process.env[names.command] = "node"

    try {
      const protectedConfig = await McpSecretStorage.protect({
        mcp: {
          remote_url: {
            type: "remote",
            url: `{env:${names.url}}`,
            headers: { Authorization: "Bearer referenced-url-secret" },
          },
          remote_client: {
            type: "remote",
            url: "https://client.example/mcp",
            oauth: {
              clientId: `{env:${names.client}}`,
              clientSecret: "referenced-client-secret",
            },
          },
          local_command: {
            type: "local",
            command: [`{env:${names.command}}`, "server.js"],
            environment: { TOKEN: "referenced-command-secret" },
          },
        },
      })
      await using tmp = await tmpdir({
        init: async (dir) => {
          await fs.writeFile(path.join(dir, "openscience.json"), JSON.stringify(protectedConfig))
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await Config.get()
          expect(config.mcp?.remote_url).toMatchObject({
            url: "https://referenced.example/mcp",
            headers: { Authorization: "Bearer referenced-url-secret" },
          })
          expect(config.mcp?.remote_client).toMatchObject({
            oauth: { clientId: "referenced-client", clientSecret: "referenced-client-secret" },
          })
          expect(config.mcp?.local_command).toMatchObject({
            command: ["node", "server.js"],
            environment: { TOKEN: "referenced-command-secret" },
          })
        },
      })
    } finally {
      delete process.env[names.url]
      delete process.env[names.client]
      delete process.env[names.command]
    }
  })
})
