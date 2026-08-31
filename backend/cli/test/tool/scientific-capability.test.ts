import { describe, expect, test } from "bun:test"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { CredentialsRoutes } from "../../src/server/routes/settings/credentials"
import { executionSession, tmpdir } from "../fixture/fixture"
import { ScientificCapabilityParameters, ScientificCapabilityTool } from "../../src/tool/scientific-capability"
import { Global } from "../../src/global"
import { BioNemoInputs } from "../../src/science/bionemo/schema"

const context = {
  sessionID: "ses_scientific_capability",
  messageID: "msg_scientific_capability",
  callID: "call_scientific_capability",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
}

describe("scientific_capability tool", () => {
  test("advertises one strict object-rooted lifecycle contract", () => {
    const schema = z.toJSONSchema(ScientificCapabilityParameters) as {
      type?: string
      required?: string[]
      properties?: { action?: { enum?: string[] } }
    }
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["action"])
    expect(schema.properties?.action?.enum).toEqual([
      "list",
      "describe",
      "doctor",
      "setup",
      "plan",
      "start",
      "smoke",
      "status",
      "wait",
      "logs",
      "artifacts",
      "verify",
      "cancel",
      "retry_delivery",
      "release",
    ])
    expect(ScientificCapabilityParameters.safeParse({ action: "describe" }).success).toBe(false)
    expect(ScientificCapabilityParameters.safeParse({ action: "smoke", id: "scipy" }).success).toBe(false)
    expect(ScientificCapabilityParameters.safeParse({ action: "smoke", id: "scipy", target: "modal" }).success).toBe(
      true,
    )
    expect(
      ScientificCapabilityParameters.safeParse({
        action: "plan",
        id: "scipy",
        packages: ["numpy==0.0.1"],
      }).success,
    ).toBe(false)
    expect(ScientificCapabilityParameters.safeParse({ action: "verify", id: "scipy" }).success).toBe(false)
  })

  test("lists the honest 54-entry maturity and availability inventory without claiming verification", async () => {
    const tool = await ScientificCapabilityTool.init()
    const listed = await tool.execute({ action: "list" }, context)
    const catalog = JSON.parse(listed.output) as {
      capabilities: Array<{ id: string; maturity: string; availability: { local: string; hosted: string } }>
    }
    expect(catalog.capabilities).toHaveLength(54)
    expect(catalog.capabilities.every((item) => item.maturity !== "verified")).toBe(true)
    expect(catalog.capabilities.find((item) => item.id === "boltz2")?.availability.hosted).toBe("setup_needed")
    expect(catalog.capabilities.find((item) => item.id === "openfold3")?.availability.hosted).toBe("setup_needed")
    expect(catalog.capabilities.find((item) => item.id === "paper-qa")?.availability.local).toBe("setup_needed")
    expect(catalog.capabilities.filter((item) => item.maturity === "blocked")).toHaveLength(2)
    expect(listed.metadata.scientific_capability.dispatched).toBe(false)
  })

  test("compiles a packaged plan without dispatching or exposing environment controls", async () => {
    const tool = await ScientificCapabilityTool.init()
    const planned = await tool.execute(
      {
        action: "plan",
        id: "scipy",
        name: "Fit model",
        purpose: "Fit and validate the requested model.",
        command: "python analysis.py",
        target: "modal",
        artifacts: ["results.json"],
      },
      context,
    )
    const proposal = JSON.parse(planned.output) as {
      tool: string
      input: { action: string; packages: string[]; image: string; uploads: string[]; gpu: string }
      execution?: unknown
    }
    expect(proposal.tool).toBe("compute_job")
    expect(proposal.input.action).toBe("plan")
    expect(proposal.input.packages).toContain("scipy==1.18.1")
    expect(proposal.input.image).toMatch(/@sha256:/)
    expect(proposal.input.uploads).toEqual([])
    expect(proposal.input.gpu).toBe("none")
    expect(proposal.execution).toBeUndefined()
    expect(planned.metadata.scientific_capability.dispatched).toBe(false)
  })

  test("describes each hosted adapter with its actual complete request schema", async () => {
    const tool = await ScientificCapabilityTool.init()
    for (const [id, schema] of Object.entries(BioNemoInputs)) {
      const described = await tool.execute({ action: "describe", id }, context)
      const result = JSON.parse(described.output)
      expect(result.request_schema).toEqual(z.toJSONSchema(schema, { io: "input" }))
      expect(result.request_schema.type).toBe("object")
      expect(Object.keys(result.request_schema.properties).length).toBeGreaterThan(0)
      expect(result.request_schema.additionalProperties).toBe(false)
      expect(described.metadata.scientific_capability.dispatched).toBe(false)
    }
    const local = await tool.execute({ action: "describe", id: "scipy" }, context)
    expect(JSON.parse(local.output).request_schema).toBeUndefined()
  })

  test("previews strict hosted BioNeMo requests and fails blocked work closed", async () => {
    const tool = await ScientificCapabilityTool.init()
    const hosted = await tool.execute(
      {
        action: "plan",
        id: "boltz2",
        payload: { polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKK" }] },
      },
      context,
    )
    const preview = JSON.parse(hosted.output) as { method: string; endpoint: string; dispatched: boolean }
    expect(preview.method).toBe("POST")
    expect(preview.endpoint).toBe("https://health.api.nvidia.com/v1/biology/mit/boltz2/predict")
    expect(preview.dispatched).toBe(false)
    await expect(
      tool.execute(
        {
          action: "plan",
          id: "diffdock",
          payload: { protein: "ATOM", ligand: "CCO", ligand_file_type: "txt", extra: true },
        },
        context,
      ),
    ).rejects.toThrow()

    const blocked = await tool.execute({ action: "plan", id: "alphafold2" }, context)
    expect(JSON.parse(blocked.output)).toMatchObject({ maturity: "blocked", dispatched: false })
    await expect(tool.execute({ action: "start", id: "alphafold2" }, context)).rejects.toThrow("weights")
  })

  test("returns setup guidance instead of pretending catalog-only entries are executable", async () => {
    const tool = await ScientificCapabilityTool.init()
    const planned = await tool.execute({ action: "plan", id: "paper-qa" }, context)
    expect(JSON.parse(planned.output)).toMatchObject({
      capability: "paper-qa",
      executable: false,
      dispatched: false,
    })
  })

  test("hosted start asks once for an exact non-standing approval covering request and status hosts", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const app = CredentialsRoutes()
          const saved = await app.request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-hosted-test-secret" } }),
          })
          expect(saved.ok).toBe(true)
          const tool = await ScientificCapabilityTool.init()
          const session = await executionSession()
          const asked: Array<{
            permission: string
            patterns: string[]
            always: string[]
            metadata: Record<string, unknown>
          }> = []
          globalThis.fetch = (async () =>
            new Response(
              JSON.stringify({
                structures: [
                  {
                    structure: "data_test\n_atom_site.id 1\n",
                    format: "mmcif",
                  },
                ],
                confidence_scores: [0.91],
              }),
              { headers: { "content-type": "application/json" } },
            )) as unknown as typeof fetch
          await tool.execute(
            {
              action: "start",
              id: "boltz2",
              payload: { polymers: [{ molecule_type: "protein", sequence: "MVLTIYPDELVQIVSDKKQQ" }] },
            },
            {
              ...context,
              sessionID: session.id,
              async ask(request) {
                asked.push(request as never)
              },
            },
          )
          expect(asked).toHaveLength(1)
          expect(asked[0]).toMatchObject({
            permission: "remote_compute",
            always: [],
          })
          expect(asked.some((item) => item.permission === "network")).toBe(false)
          expect(asked[0]?.patterns[0]).toMatch(/^[a-f0-9]{64}$/)
          expect(asked[0]?.metadata.scientific_capability).toMatchObject({
            id: "boltz2",
            provider: "nvidia",
            endpoint: "https://health.api.nvidia.com/v1/biology/mit/boltz2/predict",
            status_endpoint_template: "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/{requestId}",
            status_host: "api.nvcf.nvidia.com",
            api_schema_version: "api-schema-1.5.0",
            method: "POST",
          })
          expect((asked[0]?.metadata.scientific_capability as { payload_bytes: number }).payload_bytes).toBeGreaterThan(
            0,
          )
          expect((asked[0]?.metadata.scientific_capability as { terms_url: string }).terms_url).toContain(
            "NVIDIA_API_Trial_Service_Terms.pdf",
          )
          const egress = (
            asked[0]?.metadata.scientific_capability as {
              egress_summary: {
                input_kinds: string[]
                sequences: { count: number; lengths: number[]; sha256: string }
              }
            }
          ).egress_summary
          expect(egress.input_kinds).toContain("biological sequence")
          expect(egress.sequences).toMatchObject({ count: 1, lengths: [20] })
          expect(egress.sequences.sha256).toMatch(/^[a-f0-9]{64}$/)
          expect(JSON.stringify(egress)).not.toContain("MVLTIYPDELVQIVSDKKQQ")
          expect(JSON.stringify(asked[0]?.metadata)).not.toContain("nvapi-hosted-test-secret")
          expect(asked[0]?.metadata.scientific_capability).not.toHaveProperty("model_version")
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("requires another one-time approval before one POST retry after an initial NVIDIA auth rejection", async () => {
    await using tmp = await tmpdir({ git: true })
    const originalFetch = globalThis.fetch
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const credentials = CredentialsRoutes()
          await credentials.request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-expired-approval-secret" } }),
          })
          const tool = await ScientificCapabilityTool.init()
          const session = await executionSession()
          const asked: Array<{ permission: string; patterns: string[]; always: string[] }> = []
          let posts = 0
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            posts++
            expect(init?.method).toBe("POST")
            const authorization = new Headers(init?.headers).get("authorization")
            if (posts === 1) {
              expect(authorization).toBe("Bearer nvapi-expired-approval-secret")
              return new Response(JSON.stringify({ detail: "expired nvapi-expired-approval-secret" }), {
                status: 401,
                headers: { "content-type": "application/json" },
              })
            }
            expect(authorization).toBe("Bearer nvapi-refreshed-approval-secret")
            return new Response(JSON.stringify({ status: "success", molecules: [{ smiles: "CCO", score: 0.7 }] }), {
              headers: { "content-type": "application/json", "nvcf-status": "fulfilled" },
            })
          }) as unknown as typeof fetch
          const input = { action: "start" as const, id: "genmol", payload: { smiles: "CCO" } }
          const approvedContext = {
            ...context,
            sessionID: session.id,
            async ask(request: unknown) {
              asked.push(request as never)
            },
          }

          await expect(tool.execute(input, approvedContext)).rejects.toThrow("another one-time approval")
          expect(posts).toBe(1)
          expect(asked).toHaveLength(1)
          const durableAfterRejection = await Bun.file(
            `${Global.Path.data}/scientific-capability-hosted-dispatches.json`,
          ).text()
          expect(durableAfterRejection).not.toContain("nvapi-expired-approval-secret")

          await credentials.request("/nvidia", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fields: { api_key: "nvapi-refreshed-approval-secret" } }),
          })
          const completed = await tool.execute(input, approvedContext)
          expect(JSON.parse(completed.output)).toMatchObject({ capability: "genmol", provider: "nvidia" })
          expect(posts).toBe(2)
          expect(asked).toHaveLength(2)
          expect(asked.every((request) => request.permission === "remote_compute")).toBe(true)
          expect(asked.every((request) => request.always.length === 0)).toBe(true)
          expect(asked[1]?.patterns).toEqual(asked[0]?.patterns)
        },
      })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
