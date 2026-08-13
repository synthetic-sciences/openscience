import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SshPlan } from "../../src/compute/ssh/plan"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-ssh-plan-"))
  roots.push(root)
  await fs.writeFile(path.join(root, "analysis.py"), "print('ready')\n")
  return root
}

const host = {
  id: "lab",
  label: "Lab cluster",
  host: "login.lab.example",
  user: "researcher",
  scheduler: "slurm" as const,
  workdir: "/scratch/team",
  fingerprint: `SHA256:${"a".repeat(43)}`,
  host_key: `login.lab.example ssh-ed25519 ${Buffer.from("test-key").toString("base64")}`,
}

describe("SshPlan", () => {
  test("keeps exact approval stable across conversation-local staging roots and job ids", async () => {
    const firstRoot = await workspace()
    const secondRoot = await workspace()
    const common = {
      purpose: "Run the reviewed analysis on the lab cluster.",
      command: "python analysis.py",
      remoteCwd: "experiments/reviewed",
      uploads: ["analysis.py"],
      outputs: ["results.json"],
      host,
    }

    const first = await SshPlan.prepare({ ...common, id: "job-one", cwd: firstRoot })
    const second = await SshPlan.prepare({ ...common, id: "job-two", cwd: secondRoot })

    expect(first.plan.local_cwd).not.toBe(second.plan.local_cwd)
    expect(first.plan.remote_root).not.toBe(second.plan.remote_root)
    expect(first.plan.remote_cwd).toBe("experiments/reviewed")
    expect(first.plan.uploads).toEqual(second.plan.uploads)
    expect(first.plan.digest).toBe(second.plan.digest)
  })
})
