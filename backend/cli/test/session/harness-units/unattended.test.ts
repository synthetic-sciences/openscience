import { afterEach, describe, expect, test } from "bun:test"
import { Unattended } from "../../../src/harness/unattended"
import { HarnessState } from "../../../src/harness/state"

afterEach(() => HarnessState.reset())

describe("Unattended.asksTheUser", () => {
  test("a final answer that hands the next move to a person is a question", () => {
    for (const text of [
      "Please upload the corrected CDS and mutant-transcript files. I'll preserve the current calls as a partial report.",
      "The existing report is retracted and must not be used.\n\nAwaiting corrected NM-based files:\n- /app/data/a.txt",
      "Could you confirm which transcript model to use before I continue?",
      "Let me know whether to proceed with the cached model or the supplied one.",
      "Which would you prefer: the conservative fit or the flexible one?",
      "Do you want me to rerun the calibration with the wider prior?",
      "Should I proceed on the supplied files, or wait for the corrected ones?",
      "Once you provide the updated table I can finish the annotation.",
      "I need the corrected coordinates to complete the mapping.",
    ])
      expect(Unattended.asksTheUser(text)).toBe(true)
  })

  test("a delivered answer, a note, or a quoted command is not a question", () => {
    for (const text of [
      "Created /app/output/report.json and validated it in a fresh process. All 16 checks pass.",
      "Please note that the third band is closest to its bound (1.63 against 1.75).",
      "The user can re-run `make check` at any time; the script prints 'please upload' when the input is missing.",
      "```\nprint('Please provide the file')\n```\nThe script above is the validator; the outputs are in /results.",
      "I assumed the supplied sequence is the frame and recorded the alternative in the report.",
      "Which of the two candidates wins is decided by the held-out score, and it is the second.",
    ])
      expect(Unattended.asksTheUser(text)).toBe(false)
  })
})

describe("Unattended.decide", () => {
  const asking = "Please upload the corrected input files you selected."
  test("only an unattended root session, once, and only on a question", () => {
    expect(Unattended.decide({ autonomy: "autonomous", root: true, rounds: 0, finalText: asking })).toContain(
      "No one is available",
    )
    // A person is there to answer under the other postures.
    expect(Unattended.decide({ autonomy: "balanced", root: true, rounds: 0, finalText: asking })).toBeUndefined()
    expect(Unattended.decide({ autonomy: "interactive", root: true, rounds: 0, finalText: asking })).toBeUndefined()
    // A worker's question is for its lead, which the Task tool delivers.
    expect(Unattended.decide({ autonomy: "autonomous", root: false, rounds: 0, finalText: asking })).toBeUndefined()
    // Once: a model that asks again after being told no one is there is answered by the loop's own bounds.
    expect(Unattended.decide({ autonomy: "autonomous", root: true, rounds: 1, finalText: asking })).toBeUndefined()
    // A delivered answer is left alone.
    expect(
      Unattended.decide({
        autonomy: "autonomous",
        root: true,
        rounds: 0,
        finalText: "Wrote /app/out.csv; checks pass.",
      }),
    ).toBeUndefined()
  })

  test("the continuation says to proceed on the supplied inputs and to state the assumption", () => {
    const text = Unattended.render()
    expect(text).toContain("inputs exactly as supplied")
    expect(text).toContain("state the assumption")
    expect(text).toContain("deliver every output")
    // It names nothing about any task.
    expect(text).not.toMatch(/transcript|CDS|VEP|variant|lake|solver/i)
  })
})

import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionPrompt } from "../../../src/session/prompt"
import { tmpdir, trustProject } from "../../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../../fixture/stress-provider"

/** A model that asks for corrected files until told no one is there, then delivers. */
function server() {
  const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-unattended",
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
      if (!conversation.includes("Methods and deliverables")) return reply("title")
      if (conversation.includes("No one is available to answer in this run"))
        return reply("Proceeding on the supplied inputs as they are; the assumption is recorded in the report.")
      return reply("The supplied input and the cached reference disagree. Please upload the corrected input files.")
    },
  })
  return { instance, requests }
}

describe("UnattendedUnit in the loop", () => {
  test("under autonomous autonomy a final question is answered once and the run goes on to deliver", async () => {
    const fixture = server()
    try {
      await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
      await Instance.provide({
        directory: tmp.path,
        init: trustProject,
        fn: async () => {
          const session = await Session.create({ workspace: "project" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            delegationSettings: { level: "standard", autonomy: "autonomous" },
            parts: [{ type: "text", text: "Annotate the supplied records and write the report." }],
          })
          const messages = await Session.messages({ sessionID: session.id })
          const parts = messages.flatMap((message) => message.parts)
          const answer = parts.find(
            (part) => part.type === "text" && part.synthetic && part.text.includes("No one is available"),
          )
          expect(answer).toBeDefined()
          const texts = parts
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
          expect(texts.at(-1)).toContain("Proceeding on the supplied inputs")
          expect(HarnessState.get(session.id).unattendedRounds).toBe(1)
          // The continuation reached the model as the runtime's message, not as a person's.
          expect(
            fixture.requests.some((request) => JSON.stringify(request.messages).includes("No one is available")),
          ).toBe(true)
        },
      })
    } finally {
      fixture.instance.stop(true)
    }
  })

  test("under balanced autonomy the question stands: a person is there to answer it", async () => {
    const fixture = server()
    try {
      await using tmp = await tmpdir({ git: true, config: stressProviderConfig(`${fixture.instance.url.origin}/v1`) })
      await Instance.provide({
        directory: tmp.path,
        init: trustProject,
        fn: async () => {
          const session = await Session.create({ workspace: "project" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            delegationSettings: { level: "standard", autonomy: "balanced" },
            parts: [{ type: "text", text: "Annotate the supplied records and write the report." }],
          })
          const parts = (await Session.messages({ sessionID: session.id })).flatMap((message) => message.parts)
          expect(parts.some((part) => part.type === "text" && part.text.includes("No one is available"))).toBe(false)
          const texts = parts
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
          expect(texts.at(-1)).toContain("Please upload the corrected input files")
          expect(HarnessState.get(session.id).unattendedRounds).toBe(0)
        },
      })
    } finally {
      fixture.instance.stop(true)
    }
  })
})
