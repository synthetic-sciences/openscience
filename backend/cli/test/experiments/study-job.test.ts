import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"
import { Experiments } from "../../src/experiments"
import { StudyDriver } from "../../src/experiments/driver"
import { TrackingSDK } from "../../src/experiments/sdk"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { tmpdir, trustProject } from "../fixture/fixture"

const python = Bun.which("python3") ?? Bun.which("python")

afterEach(() => Experiments.close())

describe("a study run through a real local compute job", () => {
  test.skipIf(!python)(
    "the sandboxed script's metrics reach the store from the job log and the driver settles the run",
    async () => {
      await using tmp = await tmpdir()
      const root = path.join(tmp.path, "state")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const session = await Session.create({})
          const workspace = await SessionFilesystem.workspace(session.id)
          const options = { root, workspace, projectDirectory: tmp.path }
          const study = await Experiments.createStudy({
            sessionID: session.id,
            name: "sgd",
            purpose: "fit a line",
            metric: "val_mse",
            direction: "minimize",
            root: workspace,
            concurrency: 1,
            killCriteria: "",
            budget: {},
          })
          const [idea] = await Experiments.proposeIdeas(study.id, [
            {
              title: "baseline",
              description: "plain sgd",
              why: "reference",
              ev: 0,
              priority: 1000,
              config: { steps: 5 },
            },
          ])
          await fs.writeFile(
            path.join(workspace, "train.py"),
            [
              "import openscience_track as track",
              "run = track.init(config={'steps': 5})",
              "mse = 4.0",
              "for step in range(5):",
              "    mse *= 0.5",
              "    track.log({'val_mse': mse}, step=step)",
              "print('done')",
              "track.summary['val_mse'] = mse",
              "track.finish()",
            ].join("\n"),
          )
          const entries = await TrackingSDK.materialize(workspace, { shim: false })
          const run = await Experiments.createRun({
            name: idea!.title,
            source: "job",
            studyID: study.id,
            ideaID: idea!.id,
            sessionID: session.id,
            config: idea!.config,
          })
          const job = await ComputeJobs.start(
            {
              name: "sgd baseline",
              command: TrackingSDK.wrap(`${python} train.py`, { runID: run.id, name: "baseline", entries }),
              target: { kind: "local" },
              sessionID: session.id,
            },
            options,
          )
          await Experiments.bindJob(run.id, job.id)
          StudyDriver.configure({
            idle: () => true,
            prompt: async () => undefined,
            job: (jobID) => ComputeJobs.get(jobID, options),
            cancel: async (jobID) => {
              await ComputeJobs.cancel(jobID, options)
            },
            logPath: (jobID) => ComputeJobs.logPath(jobID, options),
          })
          const finished = await ComputeJobs.wait(job.id, { ...options, timeout: 20_000 })
          expect(finished.status).toBe("succeeded")
          await StudyDriver.tick(study.id)
          const settled = await Experiments.getRun(run.id)
          expect(settled?.status).toBe("finished")
          expect(settled?.points).toBe(5)
          expect(settled?.headline).toBeCloseTo(0.125)
          expect(settled?.summary).toMatchObject({ val_mse: 0.125 })
          // The log shown to readers and the model carries the plain output only.
          const shown = await ComputeJobs.log(job.id, options)
          expect(shown).toContain("done")
          expect(shown).not.toContain("@@openscience.track")
          expect(await Bun.file(path.join(workspace, "results.tsv")).text()).toContain("baseline")
        },
      })
    },
    30_000,
  )
})
