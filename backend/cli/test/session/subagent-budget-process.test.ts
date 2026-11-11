import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Instance } from "../../src/project/instance"
import { SubagentBudget } from "../../src/session/subagent-budget"
import { tmpdir } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"

const fixture = fileURLToPath(new URL("../fixture/subagent-budget-process.ts", import.meta.url))

test("separate processes cannot double-grant or double-reserve the root allowance", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.initialize("root", { enabled: true, tokens: 200 })
      const race = async (mode: "open" | "reserve", sessionID?: string) => {
        const gate = `${tmp.path}/${mode}-gate`
        const runs = ["a", "b"].map((id) => {
          const ready = `${tmp.path}/${mode}-${id}-ready`
          const child = spawn(
            [process.execPath, fixture, tmp.path, mode, sessionID ?? id, `${mode}-${id}`, ready, gate],
            {
              stdout: "pipe",
              stderr: "pipe",
            },
          )
          return { child, ready }
        })
        try {
          const end = Date.now() + 8000
          while (!(await Promise.all(runs.map((run) => Bun.file(run.ready).exists()))).every(Boolean)) {
            if (Date.now() >= end) throw new Error("Budget processes did not become ready")
            await Bun.sleep(10)
          }
          await Bun.write(gate, "start")
          return await Promise.all(
            runs.map(async ({ child }) => {
              const [exit, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
              ])
              if (exit !== 0) throw new Error(`Budget worker exited ${exit}: ${stderr}`)
              return JSON.parse(stdout) as { admitted: boolean; reason?: string }
            }),
          )
        } finally {
          for (const run of runs) run.child.kill()
          await Promise.all(runs.map((run) => run.child.exited))
        }
      }
      expect((await race("open")).filter((result) => result.admitted)).toHaveLength(1)
      const pool = (await SubagentBudget.inspect("root"))!
      expect(Object.values(pool.workers)).toHaveLength(1)
      expect(SubagentBudget.available(pool, "tokens")).toBe(50)
      const worker = Object.values(pool.workers)[0]!
      expect((await race("reserve", worker.sessionID)).filter((result) => result.admitted)).toHaveLength(1)
      const calls = (await SubagentBudget.read(worker.sessionID))!.worker.calls
      expect(Object.values(calls)).toEqual([{ amount: 150, state: "pending" }])
    },
  })
})

test("process recovery retains the accepted timestamp and deadline of the same assignment", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const acceptedAt = Date.now() - 8000
      const deadline = acceptedAt + 10000
      await SubagentBudget.open({
        rootSessionID: "root",
        parentSessionID: "root",
        sessionID: "child",
        assignmentID: "assignment",
        objective: "test",
        expectedOutput: "report",
        model: { providerID: "test", modelID: "test" },
        route: "subscription",
        unit: "tokens",
        allocation: 150,
        settings: { tokens: 200 },
        acceptedAt,
        deadline,
      })
      const gate = `${tmp.path}/recover-gate`
      await Bun.write(gate, "start")
      const child = spawn(
        [process.execPath, fixture, tmp.path, "recover", "child", "assignment", `${tmp.path}/recover-ready`, gate],
        { stdout: "pipe", stderr: "pipe" },
      )
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (exit !== 0) throw new Error(`Recovery worker exited ${exit}: ${stderr}`)
      expect(JSON.parse(stdout)).toEqual({ admitted: true, acceptedAt, deadline })
      expect((await SubagentBudget.read("child"))!.worker).toMatchObject({ acceptedAt, deadline })
    },
  })
})
