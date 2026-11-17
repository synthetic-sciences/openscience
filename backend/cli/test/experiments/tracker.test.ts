import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Experiments } from "../../src/experiments"
import { TrackingSDK } from "../../src/experiments/sdk"
import { Tracker } from "../../src/experiments/tracker"

const projectID = `prj_test_${Math.random().toString(36).slice(2, 10)}`
const python = Bun.which("python3") ?? Bun.which("python")

afterEach(() => Experiments.close())

describe("tracking SDK files", () => {
  test("a second materialize leaves matching files untouched and replaces a differing one whole", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-track-"))
    try {
      await TrackingSDK.materialize(workspace, { shim: true })
      const file = path.join(workspace, TrackingSDK.DIRECTORY, "openscience_track", "__init__.py")
      const before = await fs.stat(file)
      // Two study starts seconds apart: the second must not truncate what the
      // first run's dispatch is about to upload.
      await new Promise((resolve) => setTimeout(resolve, 20))
      await TrackingSDK.materialize(workspace, { shim: true })
      const after = await fs.stat(file)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      // A stale or hand-edited copy is replaced by a rename, never rewritten in place.
      await fs.writeFile(file, "print('old')")
      const stale = await fs.stat(file)
      await TrackingSDK.materialize(workspace, { shim: true })
      expect(await fs.readFile(file, "utf8")).toBe(TrackingSDK.PYTHON)
      expect((await fs.stat(file)).ino).not.toBe(stale.ino)
      expect((await fs.readdir(path.join(workspace, TrackingSDK.DIRECTORY, "openscience_track"))).sort()).toEqual([
        "__init__.py",
      ])
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })
})

describe("tracking SDK over stdout", () => {
  test.skipIf(!python)("a wandb-style script's records land in the store through the job log", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-track-"))
    try {
      const entries = await TrackingSDK.materialize(workspace, { shim: true })
      expect(entries).toEqual([TrackingSDK.DIRECTORY, `${TrackingSDK.DIRECTORY}/shim`])
      const script = path.join(workspace, "train.py")
      await fs.writeFile(
        script,
        [
          "import wandb",
          "run = wandb.init(project='p', name='ignored-by-env', config={'lr': 0.1, 'steps': 3})",
          "for step in range(3):",
          "    wandb.log({'val_loss': 1.0 / (step + 1), 'lr': 0.1}, step=step)",
          "print('plain output line')",
          "wandb.summary['val_loss'] = 0.25",
          "wandb.finish()",
        ].join("\n"),
      )
      const run = await Experiments.createRun({ projectID, name: "trial", source: "job", jobID: "job_x" })
      const command = TrackingSDK.wrap(`${python} train.py`, { runID: run.id, name: "trial", entries, slot: 1 })
      const proc = Bun.spawn(["sh", "-lc", command], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      const logFile = path.join(workspace, "job.log")
      await fs.writeFile(logFile, stdout)
      const follower = new Tracker.Follower(run.id, logFile, projectID)
      const first = await follower.poll()
      expect(first.records).toBe(6)
      expect(first.finished).toBe("finished")
      // Nothing new: a second poll is a no-op.
      expect((await follower.poll()).records).toBe(0)
      const stored = await Experiments.getRun(run.id, { projectID })
      expect(stored?.points).toBe(6)
      expect(stored?.lastStep).toBe(2)
      expect(stored?.config).toMatchObject({ lr: 0.1, steps: 3 })
      expect(stored?.summary).toMatchObject({ val_loss: 0.25 })
      expect(Tracker.strip(stdout).trim()).toBe("plain output line")
      expect(stdout).toContain("@@openscience.track")
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test.skipIf(!python)("wandb.init takes an argparse Namespace as its config", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-track-"))
    try {
      const entries = await TrackingSDK.materialize(workspace, { shim: true })
      await fs.writeFile(
        path.join(workspace, "train.py"),
        [
          "import argparse",
          "import wandb",
          "parser = argparse.ArgumentParser()",
          "parser.add_argument('--lr', type=float, default=0.1)",
          "parser.add_argument('--steps', type=int, default=3)",
          "args = parser.parse_args([])",
          "wandb.init(project='p', config=args)",
          "wandb.log({'val_loss': 0.5}, step=0)",
          "wandb.finish()",
        ].join("\n"),
      )
      const run = await Experiments.createRun({ projectID, name: "namespace", source: "job", jobID: "job_y" })
      const command = TrackingSDK.wrap(`${python} train.py`, { runID: run.id, name: "namespace", entries })
      const proc = Bun.spawn(["sh", "-lc", command], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      const logFile = path.join(workspace, "job.log")
      await fs.writeFile(logFile, stdout)
      await new Tracker.Follower(run.id, logFile, projectID).poll()
      const stored = await Experiments.getRun(run.id, { projectID })
      expect(stored?.config).toMatchObject({ lr: 0.1, steps: 3 })
      expect(stored?.points).toBe(1)
    } finally {
      await fs.rm(workspace, { recursive: true, force: true })
    }
  })

  test("parses only well-formed marked lines and survives partial writes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-track-"))
    try {
      const run = await Experiments.createRun({ projectID, name: "partial", source: "job" })
      const file = path.join(dir, "log")
      const line = `${TrackingSDK.MARKER}{"t":"log","step":1,"m":{"loss":0.5}}\n`
      await fs.writeFile(file, `noise\n${TrackingSDK.MARKER}{"t":"log","step":0,"m":{"loss":1}}\n${line.slice(0, 20)}`)
      const follower = new Tracker.Follower(run.id, file, projectID)
      expect((await follower.poll()).records).toBe(1)
      await fs.appendFile(file, line.slice(20))
      expect((await follower.poll()).records).toBe(1)
      await fs.appendFile(file, `${TrackingSDK.MARKER}not json\n${TrackingSDK.MARKER}{"t":"bogus"}\n`)
      expect((await follower.poll()).records).toBe(0)
      expect((await Experiments.getRun(run.id, { projectID }))?.points).toBe(2)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
