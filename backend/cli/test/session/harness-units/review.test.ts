import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Review } from "../../../src/harness/review"
import { HarnessState } from "../../../src/harness/state"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { tmpdir, trustProject } from "../../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../../fixture/stress-provider"

describe("Review", () => {
  test("a verdict is a list of gaps, or nothing when the reviewer says COMPLETE", () => {
    expect(Review.gaps("COMPLETE")).toEqual([])
    expect(Review.gaps("  complete.\n")).toEqual([])
    expect(
      Review.gaps(
        "1. The control group comparison the request names is absent.\n2) No limitations statement.\n- Figure 2 is claimed but no code produces it.",
      ),
    ).toEqual([
      "The control group comparison the request names is absent.",
      "No limitations statement.",
      "Figure 2 is claimed but no code produces it.",
    ])
    // Prose without a list is one gap, not silence.
    expect(Review.gaps("The report never addresses the second endpoint.")).toEqual([
      "The report never addresses the second endpoint.",
    ])
  })

  test("a report is what the request frames as written and what reads as prose", async () => {
    await using tmp = await tmpdir()
    const sentence = "The treated group shows a higher median than the control group in every replicate we examined. "
    const report = `# Analysis\n\n${sentence.repeat(40)}\n\n\`\`\`python\nimport pandas as pd\ndf = pd.read_csv("x.csv")\n\`\`\`\n\n| gene | p |\n| --- | --- |\n| A | 0.01 |\n`
    await fs.writeFile(path.join(tmp.path, "trace.md"), report)
    await fs.writeFile(path.join(tmp.path, "answer.txt"), "The treated group is higher.")
    await fs.writeFile(path.join(tmp.path, "result.json"), JSON.stringify({ a: 1 }))
    // A gene list and a table of numbers are text files of length too.
    await fs.writeFile(
      path.join(tmp.path, "leading_edge.txt"),
      Array.from({ length: 600 }, (_, i) => `GENE${i}`).join("\n"),
    )
    await fs.writeFile(
      path.join(tmp.path, "results.txt"),
      Array.from({ length: 600 }, (_, i) => `${i}\t${i / 7}`).join("\n"),
    )
    await fs.writeFile(path.join(tmp.path, "design_report.md"), report)
    const request = [
      "Write the analysis trace to `trace.md` and the final answer to `answer.txt`.",
      "Save the fitted parameters to `result.json`.",
      "Write the leading edge intersection of the analysis to `leading_edge.txt`, one identifier per line.",
      "Report the activity per sample in `results.txt`.",
      "Write up the design in `design_report.md`.",
    ].join("\n")
    const names = [
      "trace.md",
      "answer.txt",
      "result.json",
      "leading_edge.txt",
      "results.txt",
      "design_report.md",
      "missing.md",
    ]
    const reports = await Review.reports([tmp.path], names, request)
    expect(reports.map((r) => r.name)).toEqual(["trace.md", "design_report.md"])
    expect(Review.written(request, "leading_edge.txt")).toBe(true)
    expect(Review.prose(await fs.readFile(path.join(tmp.path, "leading_edge.txt"), "utf8"))).toBe(false)
    expect(Review.prose(await fs.readFile(path.join(tmp.path, "results.txt"), "utf8"))).toBe(false)
  })
})

/** A model that writes a report, is reviewed, and addresses the review. */
function server(root: string, options: { second?: boolean } = {}) {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-review",
      object: "chat.completion.chunk",
      created: 1,
      model: STRESS_PROVIDER_MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } : {}),
    })}\n\n`
  const reply = (content: string) =>
    new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
      headers: { "content-type": "text/event-stream" },
    })
  const instance = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json()
      requests.push(body)
      const conversation = JSON.stringify(body.messages)
      if (conversation.includes("You are a reviewer reading one finished report")) {
        if (conversation.includes("<earlier-review>")) return reply("1. No limitations statement.")
        return reply(
          options.second
            ? "1. The request asks for the control group comparison; the report has none.\n2. No limitations statement.\n3. No mechanism is given for the named genes."
            : "1. The request asks for the control group comparison; the report has none.\n2. No limitations statement.",
        )
      }
      if (!conversation.includes("Methods and deliverables")) return reply("title")
      if (conversation.includes("still finds these gaps"))
        return reply("Limitations section added; report.md is final.")
      if (conversation.includes("[Review]"))
        return reply("Added the control comparison with its code and a limitations section; report.md is updated.")
      // The first answer: the report is already on disk, as the model would have written it.
      return reply("Wrote the analysis to report.md as requested.")
    },
  })
  return { instance, requests }
}

const INSTRUCTION = [
  "Compare the treated and control groups in the supplied table.",
  "",
  "## Required Outputs",
  "",
  "### 1. Report (`report.md`)",
  "",
  "Write your complete analysis in markdown format.",
].join("\n")

describe("ReviewUnit in the loop", () => {
  test("a written report is read once against the request and the gaps come back as one continuation", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    const fixture = server(tmp.path)
    try {
      await using cfg = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
      await fs.writeFile(
        path.join(cfg.path, "report.md"),
        `# Report\n\n${"The treated group shows a higher median than the control group in every replicate we examined. ".repeat(50)}\n\nFinal token499.\n`,
      )
      await Instance.provide({
        directory: cfg.path,
        init: trustProject,
        fn: async () => {
          const session = await Session.create({ workspace: "project" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            delegationSettings: { level: "standard", autonomy: "autonomous" },
            parts: [{ type: "text", text: INSTRUCTION }],
          })
          const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
          const review = parts.find((part) => part.type === "text" && part.synthetic && part.text.includes("[Review]"))
          expect(review).toBeDefined()
          expect(review && review.type === "text" ? review.text : "").toContain("control group comparison")
          const texts = parts
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
          expect(texts.at(-1)).toContain("Added the control comparison")
          expect(HarnessState.get(session.id).reviewRounds).toBe(1)
          // The reviewer saw the request and the report, and nothing of the conversation.
          const reviewRequest = fixture.requests.find((request) =>
            JSON.stringify(request.messages).includes("You are a reviewer"),
          )
          expect(reviewRequest).toBeDefined()
          const seen = JSON.stringify(reviewRequest!.messages)
          expect(seen).toContain("report.md")
          expect(seen).toContain("token499")
          expect(seen).not.toContain("Wrote the analysis")
        },
      })
    } finally {
      fixture.instance.stop(true)
    }
  })

  test("three or more gaps earn one more read, which checks only the earlier list", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    const fixture = server(tmp.path, { second: true })
    try {
      await using cfg = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
      await fs.writeFile(
        path.join(cfg.path, "report.md"),
        `# Report\n\n${"The treated group shows a higher median than the control group in every replicate we examined. ".repeat(50)}\n`,
      )
      await Instance.provide({
        directory: cfg.path,
        init: trustProject,
        fn: async () => {
          const session = await Session.create({ workspace: "project" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            delegationSettings: { level: "standard", autonomy: "autonomous" },
            parts: [{ type: "text", text: INSTRUCTION }],
          })
          const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
          const texts = parts
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
          expect(texts.filter((text) => text.includes("[Review]"))).toHaveLength(2)
          expect(texts.some((text) => text.includes("still finds these gaps"))).toBe(true)
          expect(texts.at(-1)).toContain("report.md is final")
          expect(HarnessState.get(session.id).reviewRounds).toBe(2)
          const readerCalls = fixture.requests.filter((request) =>
            JSON.stringify(request.messages).includes("You are a reviewer"),
          )
          expect(readerCalls).toHaveLength(2)
          expect(JSON.stringify(readerCalls[1].messages)).toContain("<earlier-review>")
        },
      })
    } finally {
      fixture.instance.stop(true)
    }
  })

  test("a task whose outputs are code or data is never reviewed", async () => {
    await using tmp = await tmpdir({ git: true, config: {} })
    const fixture = server(tmp.path)
    try {
      await using cfg = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
      await fs.writeFile(path.join(cfg.path, "result.json"), JSON.stringify({ answer: 42 }))
      await Instance.provide({
        directory: cfg.path,
        init: trustProject,
        fn: async () => {
          const session = await Session.create({ workspace: "project" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            delegationSettings: { level: "standard", autonomy: "autonomous" },
            parts: [{ type: "text", text: "Compute the answer and write it to `result.json`." }],
          })
          expect(HarnessState.get(session.id).reviewRounds).toBe(0)
          expect(
            fixture.requests.some((request) => JSON.stringify(request.messages).includes("You are a reviewer")),
          ).toBe(false)
        },
      })
    } finally {
      fixture.instance.stop(true)
    }
  })
})
