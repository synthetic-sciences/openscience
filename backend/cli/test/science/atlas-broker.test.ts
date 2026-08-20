import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { AtlasBroker } from "../../src/science/atlas/broker"
import { AtlasRecorder } from "../../src/science/atlas/record"
import { Provenance } from "../../src/science/provenance/store"
import { ProvenanceEnvelope } from "../../src/science/provenance/envelope"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
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

  test("searches indexed sources by id instead of accepting host folder paths", async () => {
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
    })

    expect(request.url).toEndWith("/api/v1/search")
    expect(request.body).toEqual({
      query: "persistent kernels",
      mode: "universal",
      top_k: 4,
      data_sources: ["source-1", "source-2"],
    })
    expect(request.body).not.toHaveProperty("local_folders")
    expect(request.body).not.toHaveProperty("directory")
  })

  test("asks over a deduplicated source-id array", async () => {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(sessionPath, JSON.stringify({ api_key: "thk_test", user_id: "user-1" }))
    const request = { body: {} as Record<string, unknown> }
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      request.body = JSON.parse(String(init?.body))
      return Response.json({ answer: "grounded" })
    }) as typeof fetch

    await AtlasBroker.run({
      operation: "ask",
      query: "What changed?",
      sourceIDs: ["source-1", " source-2 ", "source-1"],
    })

    expect(request.body).toEqual({
      query: "What changed?",
      source_ids: ["source-1", "source-2"],
    })
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
    ).rejects.toThrow("source_ids must contain Gateway identifiers")
    await expect(
      AtlasBroker.run({
        operation: "ask",
        query: "private source",
        sourceIDs: ["../private-data"],
      }),
    ).rejects.toThrow("source_ids must contain Gateway identifiers")
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
                atlas_compute_id: { status: "unavailable", reason: "not_implemented" },
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
