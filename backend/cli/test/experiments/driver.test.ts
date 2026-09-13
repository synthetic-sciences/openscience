import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Experiments } from "../../src/experiments"
import { StudyDriver } from "../../src/experiments/driver"
import { TrackingSDK } from "../../src/experiments/sdk"
import { Instance } from "../../src/project/instance"
import type { JobBroker } from "../../src/compute/job-broker"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Experiments.close())

type FakeJob = { status: JobBroker.Job["status"]; error?: string }

function harness(root: string) {
  const jobs = new Map<string, FakeJob>()
  const prompts: string[] = []
  const cancelled: string[] = []
  const clock = { now: Date.now() }
  const state = { idle: true }
  StudyDriver.configure({
    now: () => clock.now,
    idle: () => state.idle,
    prompt: async ({ text }) => {
      prompts.push(text)
    },
    job: async (jobID) => (jobs.has(jobID) ? ({ id: jobID, ...jobs.get(jobID)! } as JobBroker.Job) : undefined),
    cancel: async (jobID) => {
      cancelled.push(jobID)
      jobs.set(jobID, { status: "cancelled" })
    },
    logPath: async (jobID) => path.join(root, `${jobID}.log`),
  })
  const record = (jobID: string, records: object[]) =>
    fs.appendFile(
      path.join(root, `${jobID}.log`),
      records.map((item) => `${TrackingSDK.MARKER}${JSON.stringify(item)}\n`).join(""),
    )
  return { jobs, prompts, cancelled, clock, state, record }
}

describe("study driver", () => {
  test("follows a run's log, settles it when the job ends, and wakes the session once", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const h = harness(tmp.path)
        const study = await Experiments.createStudy({
          sessionID: "ses_driver",
          name: "loop",
          purpose: "test",
          metric: "val_loss",
          direction: "minimize",
          root: path.join(tmp.path, "study"),
          concurrency: 1,
          killCriteria: "",
          budget: {},
        })
        const [idea] = await Experiments.proposeIdeas(study.id, [
          { title: "baseline", description: "d", why: "w", ev: 0, priority: 1000 },
          { title: "next", description: "d", why: "w", ev: 0.5 },
        ])
        const run = await Experiments.createRun({
          name: "baseline",
          source: "job",
          studyID: study.id,
          ideaID: idea!.id,
          jobID: "job_a",
          sessionID: "ses_driver",
        })
        h.jobs.set("job_a", { status: "running" })
        await h.record("job_a", [
          { t: "init", name: "baseline", config: { lr: 0.01 } },
          { t: "log", step: 1, m: { val_loss: 1.0 } },
          { t: "log", step: 2, m: { val_loss: 0.7 } },
        ])
        await StudyDriver.tick(study.id)
        expect((await Experiments.getRun(run.id))?.points).toBe(2)
        expect((await Experiments.getRun(run.id))?.status).toBe("running")
        expect(h.prompts).toEqual([])

        await h.record("job_a", [{ t: "summary", s: { val_loss: 0.65 } }, { t: "finish" }])
        h.jobs.set("job_a", { status: "succeeded" })
        await StudyDriver.tick(study.id)
        const settled = await Experiments.getRun(run.id)
        expect(settled?.status).toBe("finished")
        expect(settled?.headline).toBe(0.65)
        expect(h.prompts).toHaveLength(1)
        expect(h.prompts[0]).toContain('Study update for "loop"')
        expect(h.prompts[0]).toContain("val_loss 0.65")
        expect(h.prompts[0]).toContain("study record")
        // The ledger files are rendered into the study root.
        expect(await Bun.file(path.join(tmp.path, "study", "results.tsv")).text()).toContain("baseline")
        expect(await Bun.file(path.join(tmp.path, "study", "ideas.md")).text()).toContain("next")
        // Nothing new: no second wake-up, and a busy session is never interrupted.
        await StudyDriver.tick(study.id)
        expect(h.prompts).toHaveLength(1)
        expect((await Experiments.getStudy(study.id))?.turns).toBe(1)
      },
    })
  })

  test("applies kill criteria to a live run and reports the reason", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const h = harness(tmp.path)
        const study = await Experiments.createStudy({
          sessionID: "ses_kill",
          name: "kill",
          purpose: "test",
          metric: "val_loss",
          direction: "minimize",
          root: path.join(tmp.path, "study"),
          concurrency: 2,
          killCriteria: "val_loss > 5 for 2 steps",
          budget: {},
        })
        const [idea] = await Experiments.proposeIdeas(study.id, [
          { title: "diverges", description: "d", why: "w", ev: 0.1 },
        ])
        const run = await Experiments.createRun({
          name: "diverges",
          source: "job",
          studyID: study.id,
          ideaID: idea!.id,
          jobID: "job_k",
        })
        h.jobs.set("job_k", { status: "running" })
        await h.record("job_k", [
          { t: "log", step: 1, m: { val_loss: 7 } },
          { t: "log", step: 2, m: { val_loss: 9 } },
        ])
        await StudyDriver.tick(study.id)
        expect(h.cancelled).toEqual(["job_k"])
        const killed = await Experiments.getRun(run.id)
        expect(killed?.status).toBe("killed")
        expect(killed?.killReason).toContain("val_loss > 5 for 2 steps")
        expect(h.prompts[0]).toContain("killed")
        expect((await Experiments.getIdea(idea!.id))?.status).toBe("running")
      },
    })
  })

  test("nudges an idle session with free slots and queued ideas, at most once per window", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const h = harness(tmp.path)
        const study = await Experiments.createStudy({
          sessionID: "ses_idle",
          name: "idle",
          purpose: "test",
          metric: "acc",
          direction: "maximize",
          root: path.join(tmp.path, "study"),
          concurrency: 2,
        })
        await Experiments.proposeIdeas(study.id, [{ title: "try wd", description: "d", why: "w", ev: 0.2 }])
        await StudyDriver.tick(study.id)
        expect(h.prompts).toHaveLength(1)
        expect(h.prompts[0]).toContain("2 of 2 slots free")
        expect(h.prompts[0]).toContain("try wd")
        await StudyDriver.tick(study.id)
        expect(h.prompts).toHaveLength(1)
        // Time passes without action: the same situation is not repeated.
        h.clock.now += StudyDriver.IDLE_NUDGE_MS + 1
        await StudyDriver.tick(study.id)
        expect(h.prompts).toHaveLength(1)
        // A busy session is left alone even when a wake-up is due.
        h.state.idle = false
        await StudyDriver.resume(study.id)
        await StudyDriver.tick(study.id)
        expect(h.prompts).toHaveLength(1)
      },
    })
  })

  test("a thin backlog, a stuck streak and a step-back ride along with run news, and a directive wakes at once", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const h = harness(tmp.path)
        const study = await Experiments.createStudy({
          sessionID: "ses_loop",
          name: "loop",
          purpose: "test",
          metric: "score",
          direction: "maximize",
          root: path.join(tmp.path, "study"),
          concurrency: 1,
          budget: { maxHours: 4 },
        })
        const ideas = await Experiments.proposeIdeas(
          study.id,
          Array.from({ length: 7 }, (_, index) => ({ title: `idea ${index}`, description: "d", why: "w", ev: 0.1 })),
        )
        // Baseline, then six runs that never beat it.
        const baseline = await Experiments.createRun({
          name: "idea 0",
          source: "job",
          studyID: study.id,
          ideaID: ideas[0]!.id,
          jobID: "job_0",
        })
        h.jobs.set("job_0", { status: "succeeded" })
        await h.record("job_0", [{ t: "log", step: 1, m: { score: 1.0 } }])
        await StudyDriver.tick(study.id)
        await Experiments.setBaseline(study.id, baseline.id)
        await Experiments.recordResult({ studyID: study.id, runID: baseline.id, kept: true, analysis: "ref" })
        expect(h.prompts).toHaveLength(1)
        expect(h.prompts[0]).not.toContain("Backlog is thin")
        for (let index = 1; index <= 5; index++) {
          const run = await Experiments.createRun({
            name: `idea ${index}`,
            source: "job",
            studyID: study.id,
            ideaID: ideas[index]!.id,
            jobID: `job_${index}`,
          })
          h.jobs.set(`job_${index}`, { status: "succeeded" })
          await h.record(`job_${index}`, [{ t: "log", step: 1, m: { score: 0.9 } }])
          await StudyDriver.tick(study.id)
          await Experiments.recordResult({ studyID: study.id, runID: run.id, kept: false, analysis: "worse" })
        }
        const all = h.prompts.join("\n")
        // One queued idea left after five reverts: the backlog warning appears.
        expect(all).toContain("Backlog is thin (1 queued)")
        // Four reverts in a row: asked to change the kind of idea, once.
        expect(all.split("No progress in the last 4 runs").length - 1).toBe(1)
        // Six completed runs: one step-back review.
        expect(all.split("Step back (6 runs done)").length - 1).toBe(1)

        // A directive is stored on the study and delivered as its own wake-up.
        const before = h.prompts.length
        await StudyDriver.directive(study.id, "Only vary the optimizer from now on")
        expect(h.prompts).toHaveLength(before + 1)
        expect(h.prompts.at(-1)).toContain("Directive from the user: Only vary the optimizer from now on")
        const updated = (await Experiments.getStudy(study.id))!
        expect(updated.directives).toHaveLength(1)
        expect(updated.directives[0]!.active).toBe(true)
        await Experiments.retireDirective(study.id, updated.directives[0]!.id)
        expect((await Experiments.getStudy(study.id))!.directives[0]!.active).toBe(false)
      },
    })
  })

  test("a cost budget reads the session's spend and pauses when it is exceeded", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const h = harness(tmp.path)
        const spend = { value: 0.5 }
        StudyDriver.configure({
          now: () => h.clock.now,
          idle: () => true,
          prompt: async ({ text }) => {
            h.prompts.push(text)
          },
          job: async () => undefined,
          cancel: async () => undefined,
          logPath: async (jobID) => path.join(tmp.path, `${jobID}.log`),
          cost: async () => spend.value,
        })
        const study = await Experiments.createStudy({
          sessionID: "ses_cost",
          name: "cost",
          purpose: "test",
          metric: "val_loss",
          direction: "minimize",
          root: path.join(tmp.path, "study"),
          budget: { maxCostUSD: 2 },
        })
        await StudyDriver.tick(study.id)
        expect((await Experiments.getStudy(study.id))?.costUSD).toBe(0.5)
        expect((await Experiments.getStudy(study.id))?.status).toBe("running")
        spend.value = 2.25
        await StudyDriver.tick(study.id)
        expect((await Experiments.getStudy(study.id))?.status).toBe("paused")
        expect(h.prompts.at(-1)).toContain("$2.25 reached the $2.00 limit")
      },
    })
  })

  test("pauses at the budget and asks for a conclusion", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const h = harness(tmp.path)
        const study = await Experiments.createStudy({
          sessionID: "ses_budget",
          name: "budget",
          purpose: "test",
          metric: "val_loss",
          direction: "minimize",
          root: path.join(tmp.path, "study"),
          budget: { maxRuns: 1 },
        })
        const [idea] = await Experiments.proposeIdeas(study.id, [
          { title: "only", description: "d", why: "w", ev: 0.1 },
        ])
        const run = await Experiments.createRun({
          name: "only",
          source: "job",
          studyID: study.id,
          ideaID: idea!.id,
          jobID: "job_b",
        })
        h.jobs.set("job_b", { status: "failed", error: "exit 1" })
        await StudyDriver.tick(study.id)
        expect((await Experiments.getRun(run.id))?.status).toBe("failed")
        expect((await Experiments.getStudy(study.id))?.status).toBe("paused")
        expect(h.prompts).toHaveLength(1)
        expect(h.prompts[0]).toContain("Budget reached")
        expect(h.prompts[0]).toContain("study conclude")
        // Halting cancels nothing more and records the state.
        await StudyDriver.halt(study.id)
        expect((await Experiments.getStudy(study.id))?.status).toBe("halted")
      },
    })
  })
})
