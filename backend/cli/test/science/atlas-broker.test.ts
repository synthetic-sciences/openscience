import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AtlasBroker } from "../../src/science/atlas/broker"
import { AtlasRecorder } from "../../src/science/atlas/record"
import { Provenance } from "../../src/science/provenance/store"
import { ProvenanceEnvelope } from "../../src/science/provenance/envelope"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { AtlasTool } from "../../src/tool/atlas"
import { tmpdir } from "../fixture/fixture"

const realFetch = globalThis.fetch
const sessionPath = path.join(Global.Path.data, "openscience-session.json")

afterEach(async () => {
  globalThis.fetch = realFetch
  await fs.unlink(sessionPath).catch(() => {})
})

describe("Atlas host broker", () => {
  test("loads a project brief with host credentials and no folder mount", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    const request = { url: "", authorization: "" }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request.url = String(input)
      request.authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "")
      return Response.json({ project_id: "project-1", suggested_next: ["inspect evidence"] })
    }) as typeof fetch

    const result = await AtlasBroker.run({ operation: "brief", project: "project-1", full: true })

    expect(request.url).toEndWith("/api/v1/projects/project-1/brief?full=true")
    expect(request.authorization).toBe("Bearer thk_test")
    expect(result).toEqual({ project_id: "project-1", suggested_next: ["inspect evidence"] })
    expect(JSON.stringify(result)).not.toContain("thk_test")
  })

  test("searches remote and private local sources through their dedicated scopes", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    const request = { url: "", body: {} as Record<string, unknown> }
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      request.url = String(input)
      request.body = JSON.parse(String(init?.body))
      return Response.json({ hits: [{ source_id: "source-1", text: "grounded result" }] })
    }) as typeof fetch

    await AtlasBroker.run({
      operation: "search",
      query: "persistent kernels",
      mode: "universal",
      topK: 4,
      sourceIDs: ["source-1", "source-2"],
      localSourceIDs: ["local-1", " local-2 ", "local-1"],
    })

    expect(request.url).toEndWith("/api/v1/search")
    expect(request.body).toEqual({
      query: "persistent kernels",
      mode: "universal",
      top_k: 4,
      data_sources: ["source-1", "source-2"],
      local_folders: ["local-1", "local-2"],
    })
    expect(request.body).not.toHaveProperty("directory")
  })

  test("lists and inspects indexed library sources through the host broker", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    const requests: Array<{ method: string; url: string; body?: unknown }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      return Response.json({ ok: true })
    }) as typeof fetch

    await AtlasBroker.run({
      operation: "library_list",
      sourceType: "repository",
      sourceStatus: "completed",
      limit: 7,
      offset: 2,
    })
    await AtlasBroker.run({ operation: "library_summary" })
    await AtlasBroker.run({ operation: "library_show", sourceID: "source/one" })
    await AtlasBroker.run({ operation: "library_tree", sourceID: "source/one", sourcePath: "src", depth: 3 })
    await AtlasBroker.run({ operation: "library_read", sourceID: "source/one", sourcePath: "README.md" })
    await AtlasBroker.run({ operation: "library_grep", sourceID: "source/one", pattern: "claim", pathPrefix: "paper" })

    expect(
      requests.map((request) => `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`),
    ).toEqual([
      "GET /api/v1/sources?type=repository&status=completed&limit=7&offset=2",
      "GET /api/v1/sources/summary",
      "GET /api/v1/sources/source%2Fone",
      "GET /api/v1/sources/source%2Fone/tree?path=src&depth=3",
      "GET /api/v1/sources/source%2Fone/content?path=README.md",
      "POST /api/v1/sources/source%2Fone/grep",
    ])
    expect(requests.at(-1)?.body).toEqual({ pattern: "claim", path_prefix: "paper" })
  })

  test("subscribes or adds a remote source without exposing host credentials", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({ source_id: `source-${requests.length}` }, { status: 201 })
    }) as typeof fetch

    await AtlasBroker.run({
      operation: "library_subscribe",
      url: "https://github.com/synthetic-sciences/atlas",
      sourceType: "repository",
      displayName: "Atlas",
    })
    await AtlasBroker.run({
      operation: "library_add",
      sourceType: "repository",
      repository: "synthetic-sciences/openscience",
      displayName: "OpenScience",
    })

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/sources/subscribe",
      "/api/v1/sources",
    ])
    expect(requests[0]?.body).toEqual({
      url: "https://github.com/synthetic-sciences/atlas",
      type: "repository",
      display_name: "Atlas",
    })
    expect(requests[1]?.body).toEqual({
      type: "repository",
      repository: "synthetic-sciences/openscience",
      display_name: "OpenScience",
    })
    expect(JSON.stringify(requests)).not.toContain("thk_test")
  })

  test("indexes only safe text from an authorized local folder and keeps it private", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Session.create({ title: "local indexing owner" })
        const sibling = await Session.create({ title: "local indexing sibling" })
        try {
          const siblingRoot = await SessionFilesystem.workspace(sibling.id)
          const outside = path.join(siblingRoot, "outside.txt")
          await Bun.write(path.join(tmp.path, "README.md"), "safe research text\n")
          await Bun.write(path.join(tmp.path, ".env"), "OPENAI_API_KEY=must-not-leak\n")
          await Bun.write(path.join(tmp.path, ".env.sample"), "OPENAI_API_KEY=replace-me\n")
          await Bun.write(path.join(tmp.path, ".npmrc"), "//registry.example.test/:_authToken=must-not-leak\n")
          await Bun.write(path.join(tmp.path, "service.pem"), "PRIVATE KEY must-not-leak\n")
          await fs.mkdir(path.join(tmp.path, ".ssh"))
          await Bun.write(path.join(tmp.path, ".ssh", "config"), "IdentityFile must-not-leak\n")
          await Bun.write(path.join(tmp.path, "binary.dat"), new Uint8Array([1, 0, 2]))
          await Bun.write(outside, "sibling private text\n")
          await fs.symlink(outside, path.join(tmp.path, "escape.txt"))

          const requests: Array<{ url: string; body: Record<string, unknown> }> = []
          globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            requests.push({ url: String(input), body: JSON.parse(String(init?.body)) })
            return Response.json({ source_id: "local-1", type: "local_folder" }, { status: 201 })
          }) as typeof fetch

          const added = await AtlasBroker.run({
            operation: "library_add_local",
            sessionID: owner.id,
            folder: tmp.path,
            displayName: "Safe local source",
          })
          await AtlasBroker.run({
            operation: "library_sync_local",
            sessionID: owner.id,
            sourceID: "local-1",
            folder: tmp.path,
          })

          expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
            "/api/v1/sources",
            "/api/v1/sources/local-1/sync",
          ])
          expect(requests[0]?.body).toMatchObject({
            type: "local_folder",
            display_name: "Safe local source",
            add_as_global_source: false,
          })
          expect(requests[0]?.body.files).toEqual([
            { path: ".env.sample", content: "OPENAI_API_KEY=replace-me\n" },
            { path: "README.md", content: "safe research text\n" },
          ])
          expect(requests[1]?.body).toEqual({ files: requests[0]?.body.files })
          expect(JSON.stringify(requests)).not.toContain("must-not-leak")
          expect(JSON.stringify(requests)).not.toContain("sibling private text")
          expect(added).toMatchObject({
            collection: {
              files: 2,
              omitted: { binary: 1, secret: 4, symlink: 1 },
            },
          })
        } finally {
          await Promise.all([Session.remove(owner.id), Session.remove(sibling.id)])
        }
      },
    })
  })

  test("indexes an explicitly selected folder ignored by its parent repository", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "nested ignored indexing" })
        try {
          const folder = path.join(tmp.path, "ignored", "CERBench")
          await fs.mkdir(folder, { recursive: true })
          await Bun.write(path.join(tmp.path, ".gitignore"), "ignored/\n")
          await Bun.write(path.join(folder, "paper.md"), "# Explicitly selected paper\n")
          const request = { body: {} as Record<string, unknown> }
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            request.body = JSON.parse(String(init?.body))
            return Response.json({ source_id: "nested-ignored" }, { status: 201 })
          }) as typeof fetch

          const result = await AtlasBroker.run({
            operation: "library_add_local",
            sessionID: session.id,
            folder,
          })

          expect(request.body.files).toEqual([{ path: "paper.md", content: "# Explicitly selected paper\n" }])
          expect(result).toMatchObject({
            collection: {
              files: 1,
              discovery: { method: "walk-nested-fallback", truncated: false },
            },
          })
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("uses one consumed external-folder grant for one Atlas upload", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using project = await tmpdir({ git: true })
    await using source = await tmpdir()
    await Bun.write(path.join(source.path, "paper.md"), "# One-shot source\n")
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "one-shot indexing" })
        try {
          const calls = { external: 0, sourceUploads: 0, telemetry: 0 }
          globalThis.fetch = (async (input: string | URL | Request) => {
            const pathname = new URL(String(input)).pathname
            if (pathname.includes("/telemetry/")) calls.telemetry++
            else calls.sourceUploads++
            return Response.json({ source_id: "one-shot-source" }, { status: 201 })
          }) as unknown as typeof fetch

          const result = await (
            await AtlasTool.init()
          ).execute(
            { operation: "library_add_local", folder: source.path },
            {
              sessionID: session.id,
              messageID: "msg_atlas_once",
              callID: "call_atlas_once",
              agent: "research",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: () => undefined,
              ask: async (input) => {
                if (input.permission !== "external_directory") return
                calls.external++
                await SessionFilesystem.grant({
                  sessionID: session.id,
                  path: source.path,
                  access: "read",
                  scope: "once",
                  source: "permission",
                })
              },
            },
          )

          expect(calls.external).toBe(1)
          expect(calls.sourceUploads).toBe(1)
          expect(JSON.parse(result.output)).toMatchObject({
            source: { source_id: "one-shot-source" },
            collection: { files: 1 },
          })
          expect(
            (await SessionFilesystem.list(session.id)).find((item) => item.scope === "once")?.time.consumed,
          ).toBeNumber()
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("rejects a copied folder authorization before any upload", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using project = await tmpdir({ git: true })
    await using source = await tmpdir()
    await Bun.write(path.join(source.path, "paper.md"), "must remain local\n")
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "forged indexing authority" })
        try {
          await SessionFilesystem.grant({
            sessionID: session.id,
            path: source.path,
            access: "read",
            scope: "session",
          })
          const authorized = await SessionFilesystem.authorize({
            sessionID: session.id,
            path: source.path,
            access: "read",
          })
          const authorization = await SessionFilesystem.bindAuthorization({
            sessionID: session.id,
            access: "read",
            authorized,
          })
          const copied = { ...authorization }
          const calls = { sourceUploads: 0 }
          globalThis.fetch = (async (input: string | URL | Request) => {
            if (new URL(String(input)).pathname === "/api/v1/sources") calls.sourceUploads++
            return Response.json({})
          }) as unknown as typeof fetch

          await expect(
            AtlasBroker.run({
              operation: "library_add_local",
              sessionID: session.id,
              folder: source.path,
              authorization: copied,
            }),
          ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
          expect(calls.sourceUploads).toBe(0)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("releases transferred folder authority on success, request failure, and abort while preserving borrowed authority", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using project = await tmpdir({ git: true })
    await using source = await tmpdir({ init: (directory) => Bun.write(path.join(directory, "paper.md"), "paper\n") })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "indexing authority ownership" })
        try {
          await SessionFilesystem.grant({
            sessionID: session.id,
            path: source.path,
            access: "read",
            scope: "session",
          })
          const bind = async () => {
            const authorized = await SessionFilesystem.authorize({
              sessionID: session.id,
              path: source.path,
              access: "read",
            })
            return SessionFilesystem.bindAuthorization({ sessionID: session.id, access: "read", authorized })
          }
          const run = (
            authorization: SessionFilesystem.Authorization,
            ownership: "borrowed" | "owned",
            signal?: AbortSignal,
          ) =>
            AtlasBroker.run(
              {
                operation: "library_add_local",
                sessionID: session.id,
                folder: source.path,
                authorization,
                authorizationOwnership: ownership,
              },
              signal,
            )

          globalThis.fetch = (async () =>
            Response.json({ source_id: "owned-success" }, { status: 201 })) as unknown as typeof fetch
          const owned = await bind()
          await run(owned, "owned")
          await expect(SessionFilesystem.revalidateAuthorization(owned)).rejects.toBeInstanceOf(
            SessionFilesystem.DeniedError,
          )

          globalThis.fetch = (async () => new Response("injected failure", { status: 500 })) as unknown as typeof fetch
          const failed = await bind()
          await expect(run(failed, "owned")).rejects.toThrow("injected failure")
          await expect(SessionFilesystem.revalidateAuthorization(failed)).rejects.toBeInstanceOf(
            SessionFilesystem.DeniedError,
          )

          const aborted = await bind()
          const controller = new AbortController()
          controller.abort()
          await expect(run(aborted, "owned", controller.signal)).rejects.toBeInstanceOf(DOMException)
          await expect(SessionFilesystem.revalidateAuthorization(aborted)).rejects.toBeInstanceOf(
            SessionFilesystem.DeniedError,
          )

          globalThis.fetch = (async () =>
            Response.json({ source_id: "borrowed-success" }, { status: 201 })) as unknown as typeof fetch
          const borrowed = await bind()
          await run(borrowed, "borrowed")
          await expect(SessionFilesystem.revalidateAuthorization(borrowed)).resolves.toMatchObject({
            path: source.path,
          })
          SessionFilesystem.releaseAuthorization(borrowed)

          const malformed = await bind()
          await expect(
            AtlasBroker.run({
              operation: "library_add_local",
              sessionID: session.id,
              authorization: malformed,
              authorizationOwnership: "owned",
            }),
          ).rejects.toThrow("folder is required")
          await expect(SessionFilesystem.revalidateAuthorization(malformed)).rejects.toBeInstanceOf(
            SessionFilesystem.DeniedError,
          )

          const unrelated = await bind()
          await expect(
            AtlasBroker.run({
              operation: "brief",
              project: "project-1",
              authorization: unrelated,
              authorizationOwnership: "owned",
            }),
          ).rejects.toThrow("only for local folder operations")
          await expect(SessionFilesystem.revalidateAuthorization(unrelated)).rejects.toBeInstanceOf(
            SessionFilesystem.DeniedError,
          )

          const unrelatedBorrowed = await bind()
          await expect(
            AtlasBroker.run({
              operation: "brief",
              project: "project-1",
              authorization: unrelatedBorrowed,
              authorizationOwnership: "borrowed",
            }),
          ).rejects.toThrow("only for local folder operations")
          await expect(SessionFilesystem.revalidateAuthorization(unrelatedBorrowed)).resolves.toMatchObject({
            path: source.path,
          })
          SessionFilesystem.releaseAuthorization(unrelatedBorrowed)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("serializes the final folder revalidation and upload against grant revocation", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using project = await tmpdir({ git: true })
    await using source = await tmpdir({ init: (directory) => Bun.write(path.join(directory, "paper.md"), "paper\n") })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "serialized indexing upload" })
        try {
          const grant = await SessionFilesystem.grant({
            sessionID: session.id,
            path: source.path,
            access: "read",
            scope: "session",
          })
          const state = { settled: false, revocation: undefined as Promise<unknown> | undefined }
          globalThis.fetch = (async (input: string | URL | Request) => {
            const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
            if (pathname.includes("/telemetry/")) return Response.json({ enabled: false })
            state.revocation = SessionFilesystem.revoke(session.id, grant.id).then((value) => {
              state.settled = true
              return value
            })
            await Bun.sleep(25)
            expect(state.settled).toBe(false)
            return Response.json({ source_id: "serialized-source" }, { status: 201 })
          }) as unknown as typeof fetch

          await AtlasBroker.run({
            operation: "library_add_local",
            sessionID: session.id,
            folder: source.path,
          })
          await state.revocation
          expect(state.settled).toBe(true)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("aborts before upload when folder authority is revoked during collection", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using project = await tmpdir({ git: true })
    await using source = await tmpdir()
    for (const index of Array.from({ length: 1_200 }, (_, value) => value)) {
      await Bun.write(path.join(source.path, `paper-${String(index).padStart(4, "0")}.md`), `claim ${index}\n`)
    }
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "revoked indexing" })
        try {
          const grant = await SessionFilesystem.grant({
            sessionID: session.id,
            path: source.path,
            access: "read",
            scope: "session",
          })
          const authorized = await SessionFilesystem.authorize({
            sessionID: session.id,
            path: source.path,
            access: "read",
          })
          const authorization = await SessionFilesystem.bindAuthorization({
            sessionID: session.id,
            access: "read",
            authorized,
          })
          const calls = { network: 0 }
          globalThis.fetch = (async (input: string | URL | Request) => {
            const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
            if (pathname.includes("/telemetry/")) return Response.json({ enabled: false })
            calls.network++
            return Response.json({ source_id: "must-not-upload" }, { status: 201 })
          }) as unknown as typeof fetch

          const pending = AtlasBroker.run({
            operation: "library_add_local",
            sessionID: session.id,
            folder: source.path,
            authorization,
          }).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          await Bun.sleep(20)
          await SessionFilesystem.revoke(session.id, grant.id)
          const outcome = await pending

          expect("error" in outcome).toBe(true)
          if ("error" in outcome) expect(outcome.error).toBeInstanceOf(SessionFilesystem.DeniedError)
          expect(calls.network).toBe(0)
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("never uploads bytes reached through a concurrent symlink swap", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "symlink-race indexing" })
        const state = { stop: false }
        const folder = path.join(tmp.path, "source")
        const victim = path.join(folder, "zz-victim.md")
        const outside = path.join(tmp.path, "outside-secret.md")
        try {
          await fs.mkdir(folder)
          await Bun.write(path.join(folder, "000-keep.md"), "safe stable text\n")
          await Bun.write(victim, "safe transient text\n")
          await Bun.write(outside, "OUTSIDE_SECRET_MUST_NOT_LEAK\n")
          for (const index of Array.from({ length: 300 }, (_, value) => value)) {
            await Bun.write(path.join(folder, `filler-${String(index).padStart(3, "0")}.md`), `safe ${index}\n`)
          }
          const request = { body: {} as Record<string, unknown> }
          globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
            if (pathname.includes("/telemetry/")) return Response.json({ enabled: false })
            request.body = JSON.parse(String(init?.body))
            return Response.json({ source_id: "race-safe" }, { status: 201 })
          }) as typeof fetch
          const swapping = (async () => {
            while (!state.stop) {
              await fs.unlink(victim).catch(() => undefined)
              await fs.symlink(outside, victim).catch(() => undefined)
              await Bun.sleep(0)
              await fs.unlink(victim).catch(() => undefined)
              await Bun.write(victim, "safe transient text\n")
              await Bun.sleep(0)
            }
          })()

          try {
            await AtlasBroker.run({
              operation: "library_add_local",
              sessionID: session.id,
              folder,
            })
          } finally {
            state.stop = true
            await swapping
          }

          expect(JSON.stringify(request.body)).not.toContain("OUTSIDE_SECRET_MUST_NOT_LEAK")
          expect(request.body.files).toContainEqual({ path: "000-keep.md", content: "safe stable text\n" })
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("preserves readable files when another subtree is stale or unreadable", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using project = await tmpdir({ git: true })
    await using source = await tmpdir()
    const locked = path.join(source.path, "locked")
    await fs.mkdir(locked)
    await Bun.write(path.join(locked, "hidden.md"), "unavailable text\n")
    await Bun.write(path.join(source.path, "paper.md"), "readable text\n")
    await fs.symlink(path.join(source.path, "missing"), path.join(source.path, "stale"))
    await fs.chmod(locked, 0)
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "partial indexing" })
        try {
          await SessionFilesystem.grant({
            sessionID: session.id,
            path: source.path,
            access: "read",
            scope: "session",
          })
          const request = { body: {} as Record<string, unknown> }
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            request.body = JSON.parse(String(init?.body))
            return Response.json({ source_id: "partial-source" }, { status: 201 })
          }) as typeof fetch

          const result = await AtlasBroker.run({
            operation: "library_add_local",
            sessionID: session.id,
            folder: source.path,
          })

          expect(request.body.files).toContainEqual({ path: "paper.md", content: "readable text\n" })
          expect(result).toMatchObject({
            collection: {
              discovery: { unavailable: 1 },
              omitted: { symlink: 1, unavailable: 1 },
            },
          })
        } finally {
          await fs.chmod(locked, 0o700)
          await Session.remove(session.id)
        }
      },
    })
  })

  test("bounds candidate enumeration and reports truncation", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using project = await tmpdir({ git: true })
    await using source = await tmpdir()
    for (const index of Array.from({ length: 1_100 }, (_, value) => value)) {
      await Bun.write(path.join(source.path, `item-${String(index).padStart(4, "0")}.md`), `${index}\n`)
    }
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "bounded indexing" })
        try {
          await SessionFilesystem.grant({
            sessionID: session.id,
            path: source.path,
            access: "read",
            scope: "session",
          })
          globalThis.fetch = (async () =>
            Response.json({ source_id: "bounded-source" }, { status: 201 })) as unknown as typeof fetch

          const result = await AtlasBroker.run({
            operation: "library_add_local",
            sessionID: session.id,
            folder: source.path,
            maxFiles: 1,
          })

          expect(result).toMatchObject({
            collection: {
              files: 1,
              discovery: { candidates: 1_024, truncated: true },
              omitted: { enumeration_limit: 1, file_limit: 1_023 },
            },
          })
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("refuses to index another session's private workspace before any network request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Session.create({ title: "indexing owner" })
        const sibling = await Session.create({ title: "indexing sibling" })
        try {
          const siblingRoot = await SessionFilesystem.workspace(sibling.id)
          await Bun.write(path.join(siblingRoot, "private.txt"), "not yours\n")
          let called = false
          globalThis.fetch = (async () => {
            called = true
            return Response.json({})
          }) as unknown as typeof fetch

          await expect(
            AtlasBroker.run({
              operation: "library_add_local",
              sessionID: owner.id,
              folder: siblingRoot,
            }),
          ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
          expect(called).toBe(false)
        } finally {
          await Promise.all([Session.remove(owner.id), Session.remove(sibling.id)])
        }
      },
    })
  })

  test("exposes authorized local indexing through the model-facing Atlas tool", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "tool indexing" })
        try {
          await Bun.write(path.join(tmp.path, "paper.md"), "# Verifiable paper\n")
          const permissions: string[] = []
          const metadata: Array<Record<string, unknown>> = []
          globalThis.fetch = (async () =>
            Response.json({ source_id: "local-tool-1" }, { status: 201 })) as unknown as typeof fetch

          const result = await (
            await AtlasTool.init()
          ).execute(
            {
              operation: "library_add_local",
              folder: tmp.path,
              display_name: "Tool source",
            },
            {
              sessionID: session.id,
              messageID: "msg_atlas_tool",
              callID: "call_atlas_tool",
              agent: "research",
              abort: AbortSignal.any([]),
              messages: [],
              metadata: (input) => metadata.push(input.metadata ?? {}),
              ask: async (input) => {
                permissions.push(input.permission)
              },
            },
          )

          expect(permissions).toEqual(["atlas"])
          expect(metadata).toContainEqual({
            operation: "library_add_local",
            broker: "host",
            credentials: "host_only",
            mutation: true,
          })
          expect(JSON.parse(result.output)).toMatchObject({
            source: { source_id: "local-tool-1" },
            collection: { files: 1 },
          })
          expect(result.output).not.toContain("thk_test")
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("does not expose the retired hosted document-answer operation", async () => {
    const tool = await Bun.file(new URL("../../src/tool/atlas.ts", import.meta.url)).text()
    const broker = await Bun.file(new URL("../../src/science/atlas/broker.ts", import.meta.url)).text()
    expect(tool).not.toMatch(/^\s*"ask",$/m)
    expect(broker).not.toContain('operation === "ask"')
    expect(broker).not.toContain("/api/v1/documents/ask")
  })

  test("rejects local paths at the source-id boundary", async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return Response.json({})
    }) as unknown as typeof fetch

    await expect(
      AtlasBroker.run({
        operation: "search",
        query: "private source",
        sourceIDs: ["/Users/researcher/private-data"],
      }),
    ).rejects.toThrow("source_ids must contain Synthetic Sciences identifiers")
    await expect(
      AtlasBroker.run({
        operation: "search",
        query: "private source",
        sourceIDs: ["../private-data"],
      }),
    ).rejects.toThrow("source_ids must contain Synthetic Sciences identifiers")
    expect(called).toBe(false)
  })

  test("rejects missing operation selectors before making a request", async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return Response.json({})
    }) as unknown as typeof fetch

    await expect(AtlasBroker.run({ operation: "node", node: "" })).rejects.toThrow("node is required")
    expect(called).toBe(false)
  })

  test("publishes an owned kernel provenance record without accepting a folder", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const capturedAt = new Date().toISOString()
        const envelope = ProvenanceEnvelope.create({
          kind: "kernel",
          projectID: Instance.project.id,
          sessionID: "ses_atlas_record",
          runID: "local-run-1",
          code: "40 + 2",
          cwd: tmp.path,
          codeState: ProvenanceEnvelope.code(tmp.path),
          status: "succeeded",
          outputs: [
            ProvenanceEnvelope.output({
              kind: "result",
              label: "text/plain",
              content: "42",
              createdAt: capturedAt,
            }),
          ],
          createdAt: capturedAt,
          startedAt: capturedAt,
          completedAt: capturedAt,
        })
        const node = await Provenance.record({
          kind: "run",
          label: "python cell · analysis.ipynb",
          tool: "notebook",
          sessionID: "ses_atlas_record",
          status: "ok",
          provenance: envelope,
          inputs: {
            path: "analysis.ipynb",
            language: "python",
            code: "40 + 2",
          },
          meta: {
            directory: tmp.path,
            projectID: Instance.project.id,
            executionCount: 1,
            stdout: "",
            stderr: "",
            result: "42",
            error: "",
          },
        } as Parameters<typeof Provenance.record>[0])
        const request = { url: "", body: {} as Record<string, unknown> }
        globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
          request.url = String(input)
          request.body = JSON.parse(String(init?.body))
          return Response.json({ node: { id: "atlas-run-1" }, outcome: "success" }, { status: 201 })
        }) as typeof fetch

        await AtlasRecorder.publish({
          project: "project-1",
          provenanceID: node.id,
          metrics: { score: 0.9 },
          plan: "plan-1",
        })

        expect(request.url).toEndWith("/api/v1/runs:record")
        expect(request.body).toMatchObject({
          project_id: "project-1",
          title: "python cell · analysis.ipynb",
          config: {
            path: "analysis.ipynb",
            language: "python",
            code: "40 + 2",
            provenance_id: node.id,
            openscience_provenance: {
              format: "openscience.provenance.v1",
              kind: "kernel",
              identity: {
                project_id: { status: "available", value: Instance.project.id },
                session_id: { status: "available", value: "ses_atlas_record" },
                run_id: { status: "available", value: "local-run-1" },
              },
              input: {
                code: { status: "available", value: "40 + 2" },
                cwd: { status: "available", value: tmp.path },
                code_state: {
                  status: "available",
                  value: {
                    commit: { status: "available", value: expect.stringMatching(/^[a-f0-9]{40}$/) },
                    dirty: { status: "available", value: false },
                  },
                },
              },
              outputs: {
                status: "succeeded",
                items: [
                  {
                    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
                  },
                ],
              },
              handoff: {
                atlas_run_id: { status: "unavailable", reason: "not_published" },
              },
            },
          },
          metrics: { score: 0.9 },
          stdout_tail: "42",
          exit_code: 0,
          outcome: "success",
          plan_id: "plan-1",
          head_commit_sha: expect.stringMatching(/^[a-f0-9]{40}$/),
          git_dirty: false,
        })
        expect(request.body).not.toHaveProperty("directory")
        expect(request.body).not.toHaveProperty("folder")
      },
    })
  })

  test("refuses to publish provenance owned by another project directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const node = await Provenance.record({
          kind: "run",
          label: "foreign run",
          tool: "notebook",
          status: "ok",
          meta: { directory: path.join(tmp.path, "other") },
        } as Parameters<typeof Provenance.record>[0])
        let called = false
        globalThis.fetch = (async () => {
          called = true
          return Response.json({})
        }) as unknown as typeof fetch

        await expect(AtlasRecorder.publish({ project: "project-1", provenanceID: node.id })).rejects.toThrow(
          "provenance record was not found in this project",
        )
        expect(called).toBe(false)
      },
    })
  })

  test("publishes bounded Git context while retaining dirty-state truth", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await fs.appendFile(
      path.join(tmp.path, ".git", "config"),
      `\n[remote "origin"]\n\turl = https://example.com/${"x".repeat(70 * 1024)}\n`,
    )
    await Bun.write(path.join(tmp.path, "untracked.txt"), "dirty")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const node = await Provenance.record({
          kind: "run",
          label: "bounded Git context",
          tool: "notebook",
          sessionID: "ses_bounded_git",
          status: "ok",
          meta: { directory: tmp.path, result: "x".repeat(100_000) },
        } as Parameters<typeof Provenance.record>[0])
        const request = { body: {} as Record<string, unknown> }
        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
          request.body = JSON.parse(String(init?.body))
          return Response.json({ node: { id: "atlas-run-bounded" }, outcome: "success" }, { status: 201 })
        }) as typeof fetch

        await AtlasRecorder.publish({ project: "project-1", provenanceID: node.id })

        expect(request.body.git_dirty).toBe(true)
        expect(request.body).not.toHaveProperty("repo_url")
        expect(String(request.body.stdout_tail)).toStartWith("x".repeat(1_000))
        expect(String(request.body.stdout_tail)).toEndWith("... (truncated)")
        expect(String(request.body.stdout_tail).length).toBeLessThanOrEqual(30_020)
        expect(JSON.stringify(request.body).length).toBeLessThan(40_000)
      },
    })
  })

  test("keeps a provenance record with no outcome inconclusive", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const node = await Provenance.record({
          kind: "run",
          label: "unfinished run",
          tool: "notebook",
          meta: { directory: tmp.path },
        } as Parameters<typeof Provenance.record>[0])
        const request = { body: {} as Record<string, unknown> }
        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
          request.body = JSON.parse(String(init?.body))
          return Response.json({ node: { id: "atlas-run-2" }, outcome: "inconclusive" }, { status: 201 })
        }) as typeof fetch

        await AtlasRecorder.publish({ project: "project-1", provenanceID: node.id })

        expect(request.body.outcome).toBe("inconclusive")
        expect(request.body).not.toHaveProperty("exit_code")
        expect(request.body).not.toHaveProperty("failure_mode")
      },
    })
  })
})
