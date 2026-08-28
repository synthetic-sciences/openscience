import { describe, expect, test } from "bun:test"
import z from "zod"
import { ScientificCapabilityParameters, ScientificCapabilityTool } from "../../src/tool/scientific-capability"

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
  test("advertises one object-rooted list, describe, and plan contract", () => {
    const schema = z.toJSONSchema(ScientificCapabilityParameters) as {
      type?: string
      required?: string[]
      properties?: { action?: { enum?: string[] } }
    }
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["action"])
    expect(schema.properties?.action?.enum).toEqual(["list", "describe", "plan"])
    expect(ScientificCapabilityParameters.safeParse({ action: "describe" }).success).toBe(false)
    expect(ScientificCapabilityParameters.safeParse({ action: "plan", id: "scipy" }).success).toBe(false)
  })

  test("exposes truthful status and compiles without dispatching", async () => {
    const tool = await ScientificCapabilityTool.init()
    const listed = await tool.execute({ action: "list" }, context)
    const catalog = JSON.parse(listed.output) as {
      capabilities: Array<{ id: string; status: string }>
    }
    expect(catalog.capabilities).toHaveLength(6)
    expect(catalog.capabilities.every((item) => item.status !== "verified")).toBe(true)
    expect(listed.metadata.scientific_capability.dispatched).toBe(false)

    const planned = await tool.execute(
      {
        action: "plan",
        id: "scipy",
        name: "Fit model",
        purpose: "Fit and validate the requested model.",
        command: "python analysis.py",
        target: { kind: "modal" },
        uploads: ["analysis.py"],
        artifacts: ["results.json"],
      },
      context,
    )
    const proposal = JSON.parse(planned.output) as {
      tool: string
      input: { action: string; packages: string[] }
    }
    expect(proposal.tool).toBe("compute_job")
    expect(proposal.input).toMatchObject({ action: "plan", packages: ["scipy==1.18.1"] })
    expect(planned.metadata.scientific_capability.dispatched).toBe(false)
  })

  test("describes blocked capabilities but refuses to plan them", async () => {
    const tool = await ScientificCapabilityTool.init()
    const described = await tool.execute({ action: "describe", id: "alphafold2" }, context)
    expect(JSON.parse(described.output)).toMatchObject({ id: "alphafold2", status: "blocked" })
    await expect(
      tool.execute(
        {
          action: "plan",
          id: "alphafold2",
          name: "Predict structure",
          purpose: "Predict a protein structure.",
          command: "python predict.py",
          target: { kind: "modal" },
        },
        context,
      ),
    ).rejects.toThrow("reviewed runtime image")
  })
})
