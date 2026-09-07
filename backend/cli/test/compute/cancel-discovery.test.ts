import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ComputeJobs } from "../../src/compute/jobs"
import { tmpdir } from "../fixture/fixture"

for (const message of ["listing unauthorized", "listing transport unavailable", "ownership mismatch"]) {
  test(`Modal cancellation preserves uncertainty when ${message}`, async () => {
    await using tmp = await tmpdir()
    const root = path.join(tmp.path, "state")
    await fs.mkdir(root)
    const job = ComputeJobs.Job.parse({
      id: "cancel-discovery",
      name: "Cancellation fixture",
      command: "never executed",
      cwd: tmp.path,
      target: { kind: "modal" },
      target_label: "Modal",
      scheduler: "none",
      status: "queued",
      created_at: new Date().toISOString(),
      artifact_patterns: ["result.txt"],
      lifecycle: { execution: "queued", delivery: "none", resource: "none", recoverable: false },
      modal: {
        app: "offline",
        image: "unused",
        gpu: "none",
        network: "none",
        timeout_minutes: 1,
        uploads: [],
        upload_bytes: 0,
        approval: "a".repeat(64),
        sdk: "fixture",
      },
    })
    await Bun.write(path.join(root, "jobs.json"), JSON.stringify([job]))
    const calls: string[] = []
    let failed = true
    const unexpected = async () => {
      throw new Error("No compute, collection, release or closure is expected")
    }
    const provider: ComputeJobs.ModalProvider = {
      volume: () => "offline-volume",
      run: unexpected,
      recover: unexpected,
      close: unexpected,
      release: unexpected,
      collect: unexpected,
      find: async () => {
        calls.push("find")
        if (failed) throw new Error(message)
        return undefined
      },
    }
    const options = {
      root,
      workspace: tmp.path,
      provider,
      credentials: {
        app: "offline",
        image: "unused",
        gpu: "none",
        network: "none" as const,
        timeoutMinutes: 1,
        concurrency: 1,
        tokenId: "fixture",
        tokenSecret: "fixture",
      },
    }
    const result = await ComputeJobs.cancel(job.id, options)
    expect(result.lifecycle).toMatchObject({ execution: "cancelled", resource: "unknown", delivery: "none" })
    expect(result.cleanup_error).toContain(message)
    expect(result.cleanup_error).toContain("may still be billing")
    expect(result.modal?.retained_volume).not.toBe(true)
    const events = await ComputeJobs.events(job.id, options)
    expect(events).not.toContain("No live Modal sandbox remained")
    expect(events).toContain("sandbox discovery failed")
    expect(calls).toEqual(["find"])
    // A later confirmed absence clears only the warning, with no automatic rerun.
    failed = false
    const noArtifacts = {
      ...job,
      status: "cancelled",
      artifact_patterns: [],
      lifecycle: result.lifecycle,
      cleanup_error: result.cleanup_error,
    }
    await Bun.write(path.join(root, "jobs.json"), JSON.stringify([noArtifacts]))
    const confirmed = await ComputeJobs.cancel(job.id, options)
    expect(confirmed.cleanup_error).toBeUndefined()
    expect(confirmed.modal?.retained_volume).toBe(true)
    expect(confirmed.lifecycle?.resource).toBe("unknown")
    expect(calls).toEqual(["find", "find"])
  })
}
