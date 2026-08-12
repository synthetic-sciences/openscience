import { describe, expect, test } from "bun:test"
import { fetchWellKnownAuth, runApprovedWellKnownAuth, WellKnownAuthApprovalRequired } from "../../src/cli/cmd/auth"
import { WellKnownAuthCommand } from "../../src/auth/wellknown-command"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("unsigned well-known auth commands", () => {
  test("a non-interactive remote command is refused before its runner can execute", async () => {
    const document = await fetchWellKnownAuth("https://auth.example.test", {
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            auth: {
              command: ["/bin/sh", "-c", "printf pwned > /tmp/remote-wellknown-rce"],
              env: "EXAMPLE_TOKEN",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    })
    let confirmed = false
    let executed = false

    await expect(
      runApprovedWellKnownAuth(document, {
        interactive: false,
        confirm: async () => {
          confirmed = true
          return true
        },
        run: async () => {
          executed = true
          return "token"
        },
      }),
    ).rejects.toBeInstanceOf(WellKnownAuthApprovalRequired)
    expect(confirmed).toBe(false)
    expect(executed).toBe(false)
  })

  test("execution is bound to an explicit approval for the exact argv", async () => {
    const document = await fetchWellKnownAuth("https://auth.example.test", {
      fetcher: (async () =>
        new Response(JSON.stringify({ auth: { command: ["token-helper", "--print"], env: "EXAMPLE_TOKEN" } }), {
          status: 200,
        })) as unknown as typeof fetch,
    })
    let prompt = ""
    let argv: string[] = []
    const token = await runApprovedWellKnownAuth(document, {
      interactive: true,
      confirm: async (message) => {
        prompt = message
        return true
      },
      run: async (input) => {
        argv = input.argv
        return "approved-token"
      },
    })

    expect(prompt).toContain(JSON.stringify(document.auth.command))
    expect(argv).toEqual(document.auth.command)
    expect(token).toBe("approved-token")
  })

  test("malformed commands, env names, redirects and oversized documents fail closed", async () => {
    const fetcher = (value: unknown, init: ResponseInit = {}) =>
      (async () => new Response(JSON.stringify(value), { status: 200, ...init })) as unknown as typeof fetch

    await expect(
      fetchWellKnownAuth("https://auth.example.test", {
        fetcher: fetcher({ auth: { command: [], env: "TOKEN" } }),
      }),
    ).rejects.toThrow()
    await expect(
      fetchWellKnownAuth("https://auth.example.test", {
        fetcher: fetcher({ auth: { command: ["helper\0evil"], env: "TOKEN" } }),
      }),
    ).rejects.toThrow("argv cannot contain NUL")
    await expect(
      fetchWellKnownAuth("https://auth.example.test", {
        fetcher: fetcher({ auth: { command: ["helper"], env: "TOKEN;EVIL=1" } }),
      }),
    ).rejects.toThrow("invalid environment variable name")
    await expect(
      fetchWellKnownAuth("https://user:secret@auth.example.test", {
        fetcher: fetcher({ auth: { command: ["helper"], env: "TOKEN" } }),
      }),
    ).rejects.toThrow("must not contain credentials")
    await expect(
      fetchWellKnownAuth("https://auth.example.test?redirect=evil", {
        fetcher: fetcher({ auth: { command: ["helper"], env: "TOKEN" } }),
      }),
    ).rejects.toThrow("must not contain a query or fragment")
    await expect(
      fetchWellKnownAuth("https://auth.example.test", {
        maxBytes: 16,
        fetcher: fetcher({ auth: { command: ["helper"], env: "TOKEN" } }),
      }),
    ).rejects.toThrow("exceeds 16 bytes")
  })

  test("the governed runner environment excludes ambient credentials and loader injection", () => {
    const env = WellKnownAuthCommand.environment({
      PATH: "/usr/bin",
      HOME: "/home/researcher",
      LANG: "C.UTF-8",
      AWS_PROFILE: "research",
      OPENAI_API_KEY: "secret",
      SYNSC_API_KEY: "secret",
      LD_PRELOAD: "/tmp/evil.so",
      PYTHONPATH: "/tmp/evil",
      NODE_OPTIONS: "--require=/tmp/evil.js",
    })

    expect(env).toMatchObject({ PATH: "/usr/bin", HOME: "/home/researcher", AWS_PROFILE: "research" })
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.SYNSC_API_KEY).toBeUndefined()
    expect(env.LD_PRELOAD).toBeUndefined()
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  test("an approved command runs through the governed one-shot process boundary", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const token = await WellKnownAuthCommand.run({
          argv: ["/bin/sh", "-c", "printf governed-token"],
          timeoutMs: 5_000,
        })
        expect(token).toBe("governed-token")
      },
    })
  })
})
