import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Experiments } from "../../src/experiments"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { ExperimentsTool } from "../../src/tool/experiments"
import { StudyTool } from "../../src/tool/study"
import type { Tool } from "../../src/tool/tool"
import { tmpdir, trustProject } from "../fixture/fixture"

afterEach(() => Experiments.close())

type Asked = { permission: string; patterns?: string[]; always?: string[]; metadata?: Record<string, unknown> }

function context(sessionID: string, asked: Asked[] = []): Tool.Context {
  return {
    sessionID,
    messageID: "msg_test",
    agent: "research",
    abort: new AbortController().signal,
    extra: {},
    messages: [],
    metadata: () => undefined,
    ask: async (input) => {
      asked.push(input as Asked)
    },
  }
}

describe("study and experiments tools", () => {
  test("create, propose, status, record and conclude keep one study per session and render the ledger", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const ctx = context(session.id)
        const study = await StudyTool.init()
        const experiments = await ExperimentsTool.init()

        await expect(study.execute({ action: "status" }, ctx)).rejects.toThrow("No study is active")
        await expect(
          study.execute(
            {
              action: "create",
              name: "s",
              purpose: "p",
              metric: "val_loss",
              direction: "minimize",
              kill_criteria: "gibberish here",
              budget: { maxRuns: 3 },
            },
            ctx,
          ),
        ).rejects.toThrow("Could not read kill criteria")

        await expect(
          study.execute({ action: "create", name: "s", purpose: "p", metric: "val_loss", direction: "minimize" }, ctx),
        ).rejects.toThrow("needs a budget")

        const created = await study.execute(
          {
            action: "create",
            name: "line fit",
            purpose: "fit y = 3x + 2",
            question: "Can momentum improve the fit?",
            hypothesis: "Momentum reduces validation MSE at the same step count.",
            metric: "val_mse",
            direction: "minimize",
            concurrency: 1,
            kill_criteria: "30 minutes",
            budget: { maxRuns: 6 },
          },
          ctx,
        )
        expect(created.title).toBe("Study created: line fit")
        expect(created.output).toContain("openscience_track")
        // An isolated session's study lives in Project files, not in scratch.
        const workspace = (await Experiments.studyForSession(session.id))!.root
        expect(workspace).toBe(tmp.path)
        expect(await Bun.file(path.join(workspace, ".openscience/sdk/openscience_track/__init__.py")).exists()).toBe(
          true,
        )
        expect(await Bun.file(path.join(workspace, ".openscience/sdk/shim/wandb.py")).exists()).toBe(true)
        expect(await Bun.file(path.join(workspace, "study.md")).text()).toContain("fit y = 3x + 2")

        expect((await Experiments.studyForSession(session.id))?.question).toBe("Can momentum improve the fit?")
        const revised = await study.execute(
          { action: "update", hypothesis: "Momentum reaches the same MSE sooner." },
          ctx,
        )
        expect(revised.output).toContain("Momentum reaches the same MSE sooner.")
        const ledger = await Bun.file(path.join(workspace, "study.md")).text()
        expect(ledger).toContain("Can momentum improve the fit?")
        expect(ledger).toContain("Momentum reaches the same MSE sooner.")

        await expect(
          study.execute({ action: "create", name: "again", purpose: "p", metric: "m", direction: "maximize" }, ctx),
        ).rejects.toThrow("already drives study")

        const proposed = await study.execute(
          {
            action: "propose",
            ideas: [
              {
                title: "baseline",
                description: "plain",
                why: "reference",
                ev: 0,
                priority: 1000,
                config: { lr: 0.01 },
              },
              { title: "momentum", description: "add momentum", why: "smoother", ev: 0.4, config: { momentum: 0.9 } },
            ],
          },
          ctx,
        )
        expect(proposed.title).toBe("2 ideas queued")
        expect(proposed.output).toContain("keep at least 3 ahead")
        const ideas = JSON.parse(proposed.output.split("\n\n")[0]!) as Array<{ idea_id: string; title: string }>
        await expect(
          study.execute(
            {
              action: "propose",
              ideas: [{ title: "momentum again", description: "d", why: "w", ev: 0.1, config: { momentum: 0.9 } }],
            },
            ctx,
          ),
        ).rejects.toThrow("repeats a configuration")

        const status = await study.execute({ action: "status" }, ctx)
        const parsed = JSON.parse(status.output)
        expect(parsed.study.metric).toBe("val_mse")
        expect(parsed.queue[0].title).toBe("baseline")
        expect(parsed.baseline).toBeNull()

        // A run that ended outside the tool (the driver settles real jobs) can be recorded.
        const active = (await Experiments.studyForSession(session.id))!
        const run = await Experiments.createRun({
          name: "baseline",
          source: "job",
          studyID: active.id,
          ideaID: ideas[0]!.idea_id,
          jobID: "job_1",
        })
        await expect(
          study.execute({ action: "record", run_id: run.id, kept: true, analysis: "reference" }, ctx),
        ).rejects.toThrow("still running")
        await Experiments.ingest(run.id, [{ key: "val_mse", step: 10, value: 0.5 }])
        await Experiments.finishRun(run.id, "finished")
        const recorded = await study.execute(
          {
            action: "record",
            run_id: run.id,
            kept: true,
            analysis: "reference run",
            baseline: true,
            lessons: "plain sgd converges",
          },
          ctx,
        )
        expect(recorded.output).toContain("set as the baseline")
        expect(await Bun.file(path.join(workspace, "results.tsv")).text()).toContain("baseline")
        expect(await Bun.file(path.join(workspace, "lessons.md")).text()).toContain("plain sgd converges")

        const compare = await experiments.execute({ action: "compare" }, ctx)
        expect(JSON.parse(compare.output).runs[0]).toMatchObject({ name: "baseline", role: "baseline", headline: 0.5 })
        const runs = await experiments.execute({ action: "runs" }, ctx)
        expect(JSON.parse(runs.output).runs).toHaveLength(1)

        const dropped = await study.execute({ action: "drop", idea_id: ideas[1]!.idea_id, reason: "not worth it" }, ctx)
        expect(dropped.title).toBe("Dropped: momentum")

        const concluded = await study.execute({ action: "conclude", conclusion: "plain sgd is enough here" }, ctx)
        expect(concluded.title).toBe("Study concluded: line fit")
        expect((await Experiments.getStudy(active.id))?.status).toBe("concluded")
        expect(await Experiments.studyForSession(session.id)).toBeUndefined()
        expect(await Bun.file(path.join(workspace, "study.md")).text()).toContain("plain sgd is enough here")

        // "Continue the study": reopening adds the budget the person agreed
        // to and keeps the record, instead of a second study from nothing.
        await expect(study.execute({ action: "reopen" }, ctx)).rejects.toThrow("additional budget")
        const reopened = await study.execute({ action: "reopen", budget: { maxRuns: 4, maxHours: 1 } }, ctx)
        expect(reopened.title).toBe("Study reopened: line fit")
        expect(reopened.output).toContain("maxRuns 10")
        expect(reopened.output).toContain("maxHours 1")
        expect(reopened.output).toContain(`best run (${run.id})`)
        const again = (await Experiments.studyForSession(session.id))!
        expect(again.id).toBe(active.id)
        expect(again.status).toBe("running")
        expect(again.budget).toMatchObject({ maxRuns: 10, maxHours: 1 })
        expect((await Experiments.listRuns({ studyID: again.id })).map((item) => item.id)).toEqual([run.id])
        await expect(study.execute({ action: "reopen", budget: { maxRuns: 1 } }, ctx)).rejects.toThrow(
          "already running",
        )
      },
    })
  })

  test("an isolated session's study roots in Project files, and a remote target is approved once for the whole study", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({ title: "durable", workspace: "isolated" })
        const scratch = await SessionFilesystem.toolDirectory(session.id)
        expect(scratch).not.toBe(tmp.path)
        const asked: Asked[] = []
        const ctx = context(session.id, asked)
        const study = await StudyTool.init({ agent: undefined })
        const created = await study.execute(
          {
            action: "create",
            name: "churn climb",
            purpose: "p",
            metric: "cv_roc_auc",
            direction: "maximize",
            root: "autoresearch_churn",
            target: { kind: "modal", gpu: "T4" },
            concurrency: 2,
            kill_criteria: "6 minutes",
            budget: { maxRuns: 12, maxHours: 1 },
          },
          ctx,
        )
        const active = (await Experiments.studyForSession(session.id))!
        // The ledger and the SDK live where the person can find them and
        // where they outlive the conversation: under Project files.
        expect(active.root).toBe(path.join(tmp.path, "autoresearch_churn"))
        expect(await Bun.file(path.join(active.root, "study.md")).exists()).toBe(true)
        expect(await Bun.file(path.join(active.root, ".openscience/sdk/openscience_track/__init__.py")).exists()).toBe(
          true,
        )
        expect(await Bun.file(path.join(scratch, "study.md")).exists()).toBe(false)
        // One approval for the study's remote runs, with the budget on the card.
        const remote = asked.filter((item) => item.permission === "modal")
        expect(remote).toHaveLength(1)
        expect(remote[0]!.patterns).toEqual([`study:${active.id}`])
        // The approval also carries an hour of follow-up Modal time (the
        // study's hour budget) for the refit and baselines after the runs.
        expect(remote[0]!.always).toEqual([`study:${active.id}`, "allowance:60"])
        expect(JSON.stringify(remote[0]!.metadata)).toContain("maxRuns")
        expect(JSON.stringify(remote[0]!.metadata)).toContain('"followUpMinutes":60')
        expect(created.output).toContain("Remote runs approved for this study")
      },
    })
  })

  test("start refuses a run beyond the study's run budget before anything is dispatched", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({ title: "budget" })
        const ctx = context(session.id)
        const study = await StudyTool.init({ agent: undefined })
        await study.execute(
          {
            action: "create",
            name: "capped",
            purpose: "p",
            metric: "val_mse",
            direction: "minimize",
            concurrency: 2,
            budget: { maxRuns: 1 },
          },
          ctx,
        )
        const active = (await Experiments.studyForSession(session.id))!
        const [first, second] = await Experiments.proposeIdeas(active.id, [
          { title: "first", description: "d", why: "w", ev: 0.1 },
          { title: "second", description: "d", why: "w", ev: 0.2 },
        ])
        // A dispatch that never reached a job does not spend the budget.
        const lost = await Experiments.createRun({ name: "lost", source: "job", studyID: active.id, ideaID: first!.id })
        await Experiments.finishRun(lost.id, "failed", { killReason: "dispatch failed: no runtime" })
        await Experiments.updateIdea(first!.id, { status: "queued", runID: undefined })
        expect(Experiments.dispatchFailed((await Experiments.getRun(lost.id))!)).toBe(true)
        expect(Experiments.budgeted((await Experiments.getRun(lost.id))!)).toBe(false)
        // Nor does a job that died before logging a single point: nothing was evaluated.
        const crashed = await Experiments.createRun({
          name: "crashed",
          source: "job",
          studyID: active.id,
          ideaID: first!.id,
          jobID: "job_crashed",
        })
        await Experiments.finishRun(crashed.id, "failed", { killReason: "job failed: ModuleNotFoundError" })
        await Experiments.updateIdea(first!.id, { status: "queued", runID: undefined })
        expect(Experiments.budgeted((await Experiments.getRun(crashed.id))!)).toBe(false)
        // A live run does: with maxRuns 1 and one job running, no second start.
        await Experiments.createRun({
          name: "first",
          source: "job",
          studyID: active.id,
          ideaID: first!.id,
          jobID: "job_x",
        })
        await expect(
          study.execute({ action: "start", idea_id: second!.id, command: "python train.py" }, ctx),
        ).rejects.toThrow("budget of 1 runs is spent")
      },
    })
  })
})
