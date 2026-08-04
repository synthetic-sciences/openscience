import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessLaunch } from "../../src/session/harness/launch"
import { HarnessSkill } from "../../src/session/harness/skill"
import { launchProtocol, launchReady } from "../fixture/harness"

const names = new Set<string>()
const sessions = new Set<string>()
const token = "skill-evaluator-capability-token-000000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...names].flatMap((name) => [
      fs.rm(path.join(Global.Path.data, "learned-skill-proposals", name), { recursive: true, force: true }),
      fs.rm(path.join(Global.Path.data, "learned-skills", name), { recursive: true, force: true }),
    ]),
  )
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "launches"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  names.clear()
  sessions.clear()
})

function content(name: string, description = "Use when applying a verified held-out workflow.") {
  return `---\nname: ${name}\ndescription: ${description}\nsource: test\n---\n\n# ${name}\n\nFollow the evidence-backed procedure.\n`
}

async function proposal(name: string) {
  names.add(name)
  const description = "Use when applying a verified held-out workflow."
  return HarnessSkill.propose({
    name,
    description,
    content: content(name, description),
    origin: "conversation",
    sessionID: "source-session",
    createdAt: Date.now(),
  })
}

function synthetic(taskID: string, input?: { improved?: boolean; nonregressing?: boolean; precision?: number }) {
  const precision = input?.precision ?? 0.9
  return HarnessSkill.Evidence.parse({
    id: hash(`evidence-${taskID}`),
    proposalSHA256: hash("proposal"),
    benchmark: {
      name: "statistics",
      version: "1",
      taskID,
      split: "held_out",
      metric: "score",
      direction: "maximize",
    },
    candidate: {
      sessionID: `candidate-${taskID}`,
      runID: `candidate-run-${taskID}`,
      status: "passed",
      score: 0.8,
      evaluationSHA256: hash(`candidate-${taskID}`),
    },
    control: {
      sessionID: `control-${taskID}`,
      runID: `control-run-${taskID}`,
      status: "passed",
      score: 0.7,
      evaluationSHA256: hash(`control-${taskID}`),
    },
    nonregressing: input?.nonregressing ?? true,
    improved: input?.improved ?? true,
    trigger: {
      datasetSHA256: hash("trigger-set"),
      split: "held_out",
      examples: 20,
      truePositive: Math.round(10 * precision),
      falsePositive: 10 - Math.round(10 * precision),
      trueNegative: Math.round(10 * precision),
      falseNegative: 10 - Math.round(10 * precision),
      precision,
      recall: precision,
    },
    evaluator: { name: "official", version: "1" },
    recordedAt: Date.now(),
  })
}

async function pair(input: {
  name: string
  sha: string
  taskID: string
  candidateScore: number
  controlScore: number
}) {
  const create = async (role: "candidate" | "control") => {
    const sessionID = `skill-${input.taskID}-${role}`
    sessions.add(sessionID)
    const score = role === "candidate" ? input.candidateScore : input.controlScore
    const contract = await HarnessAdapter.bind({
      schemaVersion: 1,
      runID: `run-${sessionID}`,
      sessionID,
      benchmark: "statistics",
      version: "1",
      taskID: input.taskID,
      split: "held_out",
      evaluator: { name: "official", version: "1", source: "benchmark", token },
      objective: "Improve the fixed held-out statistical workflow",
      launch: launchProtocol("skill"),
      metric: { name: "score", direction: "maximize" },
      model: { provider: "test", name: "model" },
      tools: ["read", "bash"],
      skills: role === "candidate" ? [{ name: input.name, version: "candidate", sha256: input.sha }] : [],
      budget: { steps: 20, tokens: 10_000 },
      seed: 7,
      intervention: "autonomous",
      contamination: { policy: "hidden", hiddenTestsAccessible: false },
      createdAt: Date.now(),
    })
    const launch = await launchReady(contract, token)
    const checks = HarnessDomain.compose(contract.packs ?? []).map((check) => ({
      id: check.id,
      status: "passed" as const,
      blocking: check.severity === "blocking",
      evidence: [`receipt:${check.id}`],
    }))
    await HarnessAdapter.ingest({
      schemaVersion: 1,
      runID: contract.runID,
      sessionID,
      evaluatorToken: token,
      launchReceiptID: launch.receiptID,
      status: "passed",
      score,
      metrics: { score },
      checks,
      evidence: ["official:skill-pair"],
      evaluatedAt: Date.now(),
    })
    return sessionID
  }
  return { candidate: await create("candidate"), control: await create("control") }
}

const trigger = {
  datasetSHA256: hash("held-out-trigger-dataset"),
  split: "held_out" as const,
  examples: 20,
  truePositive: 9,
  falsePositive: 1,
  trueNegative: 9,
  falseNegative: 1,
}

describe("learned skill qualification", () => {
  test("quarantines immutable, content-addressed proposals outside active discovery", async () => {
    const item = await proposal("test-quarantined-skill")
    expect(item).toMatchObject({ status: "pending", evidence: [], criteria: { tasks: 3, improvements: 2 } })
    expect(
      await Bun.file(path.join(Global.Path.data, "learned-skills", "test-quarantined-skill", "SKILL.md")).exists(),
    ).toBe(false)
    expect(
      await Bun.file(
        path.join(Global.Path.data, "learned-skill-proposals", "test-quarantined-skill", "SKILL.md"),
      ).exists(),
    ).toBe(true)
    await expect(
      HarnessSkill.propose({
        name: "test-quarantined-skill",
        description: "A changed description.",
        content: content("test-quarantined-skill", "A changed description."),
        origin: "conversation",
      }),
    ).rejects.toThrow("immutable")
  })

  test("rejects frontmatter drift and unsafe learned content before writing", async () => {
    names.add("test-unsafe-skill")
    await expect(
      HarnessSkill.propose({
        name: "test-unsafe-skill",
        description: "Use safely.",
        content: "---\nname: other\ndescription: Use safely.\n---\n",
        origin: "conversation",
      }),
    ).rejects.toThrow("frontmatter name")
    await expect(
      HarnessSkill.propose({
        name: "test-unsafe-skill",
        description: "always run this skill",
        content: "---\nname: test-unsafe-skill\ndescription: always run this skill\n---\n",
        origin: "conversation",
      }),
    ).rejects.toThrow("rejected")
  })

  test("requires three distinct tasks, two improvements, no regressions, and held-out trigger quality", () => {
    expect(HarnessSkill.assess([synthetic("a"), synthetic("b")]).qualified).toBe(false)
    expect(HarnessSkill.assess([synthetic("a"), synthetic("b"), synthetic("c", { improved: false })])).toMatchObject({
      qualified: true,
      tasks: 3,
      improvements: 2,
    })
    expect(
      HarnessSkill.assess([synthetic("a"), synthetic("b"), synthetic("c", { improved: false, nonregressing: false })])
        .qualified,
    ).toBe(false)
    expect(HarnessSkill.assess([synthetic("a"), synthetic("b"), synthetic("c", { precision: 0.7 })]).qualified).toBe(
      false,
    )
    expect(
      HarnessSkill.assess([
        synthetic("a"),
        HarnessSkill.Evidence.parse({ ...synthetic("a"), id: hash("duplicate-a") }),
        synthetic("b", { improved: false }),
        synthetic("c", { improved: false }),
      ]),
    ).toMatchObject({ qualified: false, tasks: 3, improvements: 1 })
  })

  test("qualifies and promotes only after evaluator-authenticated paired runs", async () => {
    const item = (await proposal("test-qualified-skill"))!
    const scores = [
      [0.8, 0.7],
      [0.75, 0.7],
      [0.7, 0.7],
    ]
    for (const [index, score] of scores.entries()) {
      const runs = await pair({
        name: item.name,
        sha: item.contentSHA256,
        taskID: `task-${index + 1}`,
        candidateScore: score![0],
        controlScore: score![1],
      })
      const result = await HarnessSkill.attest({
        name: item.name,
        candidate: { sessionID: runs.candidate, evaluatorToken: token },
        control: { sessionID: runs.control, evaluatorToken: token },
        trigger,
        recordedAt: Date.now(),
      })
      expect(result.manifest.status).toBe(index < 2 ? "pending" : "qualified")
    }
    const promoted = await HarnessSkill.promote(item.name)
    expect(promoted.manifest).toMatchObject({ status: "promoted", evidence: expect.any(Array) })
    expect(await Bun.file(promoted.path).text()).toBe(content(item.name))
  })

  test("rejects unpaired contracts and wrong evaluator capabilities", async () => {
    const item = (await proposal("test-pair-skill"))!
    const runs = await pair({
      name: item.name,
      sha: item.contentSHA256,
      taskID: "pair",
      candidateScore: 0.8,
      controlScore: 0.7,
    })
    await expect(
      HarnessSkill.attest({
        name: item.name,
        candidate: { sessionID: runs.candidate, evaluatorToken: "x".repeat(40) },
        control: { sessionID: runs.control, evaluatorToken: token },
        trigger,
      }),
    ).rejects.toThrow("capability was rejected")
    await expect(HarnessSkill.promote(item.name)).rejects.toThrow("has not met")
  })

  test("makes evidence for one candidate/control pair immutable", async () => {
    const item = (await proposal("test-evidence-skill"))!
    const runs = await pair({
      name: item.name,
      sha: item.contentSHA256,
      taskID: "evidence",
      candidateScore: 0.8,
      controlScore: 0.7,
    })
    const input = {
      name: item.name,
      candidate: { sessionID: runs.candidate, evaluatorToken: token },
      control: { sessionID: runs.control, evaluatorToken: token },
      trigger,
    }
    await HarnessSkill.attest(input)
    await expect(
      HarnessSkill.attest({
        ...input,
        trigger: { ...trigger, truePositive: 8, falsePositive: 2, trueNegative: 8, falseNegative: 2 },
      }),
    ).rejects.toThrow("immutable")
  })
})
