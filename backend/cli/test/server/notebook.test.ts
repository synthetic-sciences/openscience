import { describe, expect, test } from "bun:test"
import { KernelRoutes, NotebookRoutes } from "../../src/server/routes/notebook"
import { Instance } from "../../src/project/instance"
import { sandboxedExecution, tmpdir, trustProject } from "../fixture/fixture"
import { Provenance } from "../../src/science/provenance/store"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { Server } from "../../src/server/server"
import { KernelRuntime } from "../../src/science/kernel/registry"
import { KernelMetrics } from "../../src/science/kernel/metrics"
import { Sandbox } from "../../src/sandbox/sandbox"
import { SessionFilesystem } from "../../src/session/filesystem"
import fs from "node:fs/promises"
import path from "node:path"

async function createPythonEnvironment(root: string, name: string) {
  const python = Bun.which("python3") ?? Bun.which("python")
  if (!python) throw new Error("Python is required for the notebook route tests")
  const target = path.join(root, ".venv", name)
  const proc = Bun.spawn([python, "-m", "venv", "--without-pip", target], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`Could not create ${name} test environment: ${stderr}`)
  return process.platform === "win32" ? path.join(target, "Scripts", "python.exe") : path.join(target, "bin", "python")
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForExit = async (pid: number, attempt = 0): Promise<void> => {
  if (!alive(pid)) return
  if (attempt >= 100) throw new Error(`process ${pid} was not reaped`)
  await Bun.sleep(20)
  return waitForExit(pid, attempt + 1)
}

describe("/notebook routes", () => {
  test("publishes canonical and compatibility lifecycle routes in the generated API contract", async () => {
    const specs = await Server.openapi()
    const paths = specs.paths as Record<
      string,
      {
        get?: {
          parameters?: Array<{ name?: string; required?: boolean }>
        }
        post?: {
          requestBody?: {
            content?: {
              "application/json"?: {
                schema?: { required?: string[] }
              }
            }
          }
        }
        delete?: {
          parameters?: Array<{ name?: string; required?: boolean }>
        }
      }
    >
    const required = (path: string) =>
      paths[path]?.post?.requestBody?.content?.["application/json"]?.schema?.required ?? []

    expect(paths["/kernels"]?.get).toBeDefined()
    expect(paths["/kernels/{kernelID}/restart"]?.post).toBeDefined()
    expect(paths["/kernels/{kernelID}/stop"]?.post).toBeDefined()
    expect(paths["/kernels/{kernelID}/interrupt"]?.post).toBeDefined()
    expect(paths["/kernels/{kernelID}"]?.delete).toBeDefined()
    expect(paths["/kernels/execute"]?.post).toBeDefined()
    expect(paths["/kernels/compute"]?.get).toBeDefined()
    expect(paths["/kernels/status"]?.get).toBeDefined()
    expect(paths["/kernels/restart"]?.post).toBeDefined()
    expect(paths["/kernels/stop"]?.post).toBeDefined()
    expect(paths["/kernels/interrupt"]?.post).toBeDefined()
    expect(required("/kernels/execute")).toContain("sessionID")
    expect(required("/kernels/execute")).not.toContain("id")
    expect(paths["/kernels/status"]?.get?.parameters).toContainEqual(
      expect.objectContaining({ name: "sessionID", required: true }),
    )
    expect(paths["/notebook/kernels"]?.get).toBeDefined()
    expect(paths["/notebook/kernels"]?.post).toBeUndefined()
    expect(paths["/notebook/kernels/{kernelID}/restart"]?.post).toBeDefined()
    expect(paths["/notebook/kernels/{kernelID}/stop"]?.post).toBeDefined()
    expect(paths["/notebook/kernels/{kernelID}/interrupt"]?.post).toBeDefined()
    expect(paths["/notebook/kernels/{kernelID}"]?.delete).toBeDefined()
    expect(paths["/notebook/execute"]?.post).toBeDefined()
    expect(paths["/notebook/compute"]?.get).toBeDefined()
    expect(paths["/notebook/status"]?.get).toBeDefined()
    expect(paths["/notebook/restart"]?.post).toBeDefined()
    expect(paths["/notebook/stop"]?.post).toBeDefined()
    expect(paths["/notebook/interrupt"]?.post).toBeDefined()
    expect(required("/notebook/execute")).toContain("sessionID")
    expect(required("/notebook/restart")).toContain("sessionID")
    expect(required("/notebook/stop")).toContain("sessionID")
    expect(required("/notebook/interrupt")).toContain("sessionID")
    expect(paths["/notebook/status"]?.get?.parameters).toContainEqual(
      expect.objectContaining({ name: "sessionID", required: true }),
    )
    expect(paths["/notebook/kernels/{kernelID}"]?.delete?.parameters).toContainEqual(
      expect.objectContaining({ name: "sessionID", required: true }),
    )

    const canonical = Object.entries(paths).filter(([path]) => path.startsWith("/kernels"))
    const copy = JSON.stringify(canonical)
    expect(copy).not.toMatch(/notebook|cell|Jupyter|magic/i)
  })

  test("uses the canonical root while retaining the compatibility inventory path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect(await (await KernelRoutes().request("/")).json()).toEqual({ kernels: [] })
        expect(await (await NotebookRoutes().request("/kernels")).json()).toEqual({ kernels: [] })
        expect((await KernelRoutes().request("/kernels")).status).toBe(404)
      },
    })
  })

  test("canonical source labels cannot create extra runtimes while compatibility names stay isolated", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const kernels = KernelRoutes()
        const notebook = NotebookRoutes()
        const session = await Session.create({})
        const body = { sessionID: session.id, language: "python" } as const
        const first = await kernels.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, source: "analysis-a.py", code: "shared_value = 40" }),
        })
        expect(first.status).toBe(200)

        const second = await kernels.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, source: "analysis-b.py", code: "shared_value + 2" }),
        })
        const result = (await second.json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }
        expect(result.execution_count).toBe(2)
        expect(result.outputs.some((item) => item.data?.["text/plain"] === "42")).toBe(true)

        const legacy = (await (
          await notebook.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...body,
              id: "analysis.py",
              code: "globals().get('shared_value', 'missing')",
            }),
          })
        ).json()) as typeof result
        expect(legacy.execution_count).toBe(1)
        expect(legacy.outputs.some((item) => item.data?.["text/plain"] === "'missing'")).toBe(true)

        const canonical = (await (
          await kernels.request(`/status?sessionID=${encodeURIComponent(session.id)}&language=python`)
        ).json()) as Record<string, unknown>
        const compatible = (await (
          await notebook.request(`/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.py&language=python`)
        ).json()) as Record<string, unknown>
        expect(canonical.execution_count).toBe(2)
        expect(canonical.name).toBe("python")
        expect(canonical.last_execution).toBeDefined()
        expect(canonical.last_cell).toBeUndefined()
        expect(compatible.execution_count).toBe(1)
        expect(compatible.last_cell).toBeDefined()

        const visible = (await (await kernels.request(`/?sessionID=${encodeURIComponent(session.id)}`)).json()) as {
          kernels: Array<{ name: string }>
        }
        expect(visible.kernels.map((value) => value.name)).toEqual(["python"])

        await kernels.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        await notebook.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, id: "analysis.py" }),
        })
      },
    })
  }, 30_000)

  test("keeps canonical state warm, then autonomously reaps the idle process", async () => {
    const previous = process.env.OPENSCIENCE_KERNEL_IDLE_MS
    process.env.OPENSCIENCE_KERNEL_IDLE_MS = "1000"
    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const app = KernelRoutes()
          const session = await Session.create({})
          const body = { sessionID: session.id, language: "python" } as const
          const execute = (code: string) =>
            app.request("/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...body, code }),
            })
          const status = async () => {
            const response = await app.request(`/status?sessionID=${encodeURIComponent(session.id)}&language=python`)
            return response.json() as Promise<{
              active: boolean
              state: string
              process_id: number | null
              execution_count: number
            }>
          }

          expect((await execute("warm_value = 41")).status).toBe(200)
          const warm = (await (await execute("warm_value + 1")).json()) as {
            execution_count: number
            outputs: Array<{ data?: Record<string, string> }>
          }
          expect(warm.execution_count).toBe(2)
          expect(warm.outputs.some((item) => item.data?.["text/plain"] === "42")).toBe(true)

          const live = await status()
          expect(live).toMatchObject({ active: true, state: "idle", execution_count: 2 })
          if (live.process_id === null) throw new Error("live runtime did not expose its process")

          const inactive = async (attempt = 0): Promise<Awaited<ReturnType<typeof status>>> => {
            const value = await status()
            if (!value.active) return value
            if (attempt >= 150) throw new Error("idle runtime was not reaped")
            await Bun.sleep(20)
            return inactive(attempt + 1)
          }
          expect(await inactive()).toMatchObject({ active: false, state: "stopped", process_id: null })
          await waitForExit(live.process_id)

          const capacity = (await (await app.request("/compute?client=idle-expiry-test")).json()) as {
            kernels: { live: number; running: number }
          }
          expect(capacity.kernels).toEqual({ live: 0, running: 0 })

          const fresh = (await (await execute("globals().get('warm_value', 'missing')")).json()) as typeof warm
          expect(fresh.execution_count).toBe(1)
          expect(fresh.outputs.some((item) => item.data?.["text/plain"] === "'missing'")).toBe(true)
          await app.request("/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENSCIENCE_KERNEL_IDLE_MS
      else process.env.OPENSCIENCE_KERNEL_IDLE_MS = previous
    }
  }, 30_000)

  test("does not invent kernels for untouched sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = NotebookRoutes()
        const session = await Session.create({})
        const project = (await (await app.request("/kernels")).json()) as { kernels: unknown[] }
        const scoped = (await (await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)).json()) as {
          kernels: unknown[]
        }

        expect(project.kernels).toEqual([])
        expect(scoped.kernels).toEqual([])
        expect(KernelRuntime.list()).toEqual([])
      },
    })
  })

  test("executes cells in a persistent session-owned Python kernel", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const first = await app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, id: "analysis.ipynb", language: "python", code: "value = 41" }),
        })
        expect(first.status).toBe(200)

        const second = await app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, id: "analysis.ipynb", language: "python", code: "value + 1" }),
        })
        const result = (await second.json()) as {
          ok: boolean
          provenance_id: string
          execution_count: number
          outputs: Array<{
            output_type: string
            data?: Record<string, string>
            execution_count?: number
            metadata?: object
          }>
        }

        expect(second.status).toBe(200)
        expect(result.ok).toBe(true)
        expect(result.provenance_id).toMatch(/^[a-f0-9]{16}$/)
        expect(result.execution_count).toBe(2)
        expect(result.outputs).toContainEqual({
          output_type: "execute_result",
          execution_count: 2,
          data: { "text/plain": "42" },
          metadata: {},
        })
        expect(await Provenance.get(result.provenance_id)).toMatchObject({
          kind: "run",
          tool: "python",
          sessionID: session.id,
          status: "ok",
          inputs: {
            path: "analysis.ipynb",
            language: "python",
            code: "value + 1",
          },
        })

        const status = await app.request(
          `/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`,
        )
        const state = (await status.json()) as {
          environment?: {
            cwd?: string
            atlas?: {
              access?: string
              credentials?: string
              sources?: string
            }
            sandbox?: {
              requested?: boolean
              enforced?: boolean
              backend?: string
              network?: string
              platform?: string
            }
          }
        }
        expect(state).toMatchObject({
          active: true,
          state: "idle",
          sessionID: session.id,
          name: "notebook:analysis.ipynb",
          language: "python",
          incarnation: 1,
          execution_count: 2,
          queue_depth: 0,
        })
        expect(state.environment).toMatchObject({
          cwd: await SessionFilesystem.workspace(session.id),
          atlas: {
            access: "host_broker",
            credentials: "withheld",
            sources: "source_ids_only",
          },
          sandbox: {
            requested: expect.any(Boolean),
            enforced: expect.any(Boolean),
            backend: expect.any(String),
            network: expect.stringMatching(/^(allow|deny)$/),
            platform: process.platform,
          },
        })
        const kernels = await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)
        const inventory = (await kernels.json()) as {
          kernels: Array<{
            active: boolean
            state: string
            sessionID: string
            name: string
            language: string
            execution_count: number
          }>
        }
        expect(inventory.kernels).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              active: true,
              state: "idle",
              sessionID: session.id,
              name: "notebook:analysis.ipynb",
              language: "python",
              execution_count: 2,
            }),
          ]),
        )

        const restart = await app.request("/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, id: "analysis.ipynb", language: "python" }),
        })
        expect(await restart.json()).toMatchObject({
          active: true,
          state: "idle",
          sessionID: session.id,
          name: "notebook:analysis.ipynb",
          language: "python",
          incarnation: 2,
          execution_count: 0,
          queue_depth: 0,
          process_id: expect.any(Number),
        })

        const reset = (await (
          await app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              id: "analysis.ipynb",
              language: "python",
              code: "globals().get('value', 'missing')",
            }),
          })
        ).json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }
        expect(reset.execution_count).toBe(1)
        expect(reset.outputs.some((item) => item.data?.["text/plain"] === "'missing'")).toBe(true)

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, id: "analysis.ipynb", language: "python" }),
        })
      },
    })
  }, 30_000)

  test("does not share notebook state between sessions that open the same path", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const first = await Session.create({})
        const second = await Session.create({})
        const execute = (sessionID: string, code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionID, id: "analysis.ipynb", language: "python", code }),
          })

        expect((await execute(first.id, "private_value = 73")).status).toBe(200)
        const isolated = await execute(second.id, "globals().get('private_value', 'missing')")
        const result = (await isolated.json()) as {
          execution_count: number
          outputs: Array<{
            output_type: string
            execution_count?: number
            data?: Record<string, string>
            metadata?: object
          }>
        }

        expect(result.execution_count).toBe(1)
        expect(result.outputs).toContainEqual({
          output_type: "execute_result",
          execution_count: 1,
          data: { "text/plain": "'missing'" },
          metadata: {},
        })

        await Promise.all(
          [first.id, second.id].map((sessionID) =>
            app.request("/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionID, id: "analysis.ipynb", language: "python" }),
            }),
          ),
        )
      },
    })
  }, 30_000)

  test("does not expose host credentials to notebook code", async () => {
    const key = `OPENSCIENCE_KERNEL_SECRET_${process.pid}`
    const previous = process.env[key]
    process.env[key] = "private-canary"
    try {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await trustProject()
          const app = NotebookRoutes()
          const session = await Session.create({})
          const body = {
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
          } as const
          const execution = await app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...body,
              code: `(__import__('os').environ.get('${key}', 'missing'), __import__('json').load(open(__import__('os').environ['ATLAS_CLI_CONFIG_PATH'])))`,
            }),
          })
          const result = (await execution.json()) as {
            outputs: Array<{ data?: Record<string, string> }>
          }
          expect(result.outputs.some((output) => output.data?.["text/plain"] === "('missing', {})")).toBe(true)

          await app.request("/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        },
      })
    } finally {
      if (previous === undefined) delete process.env[key]
      if (previous !== undefined) process.env[key] = previous
    }
  }, 30_000)

  test("cancels queued startup and replaces it with one fresh incarnation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        const status = () =>
          app.request(`/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`)
        const execution = app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, code: "startup_value = 9" }),
        })
        const waitForStarting = async (attempt = 0): Promise<void> => {
          const result = (await (await status()).json()) as { state?: string }
          if (result.state === "starting") return
          if (attempt >= 100) throw new Error("kernel did not start")
          await Bun.sleep(10)
          return waitForStarting(attempt + 1)
        }
        await waitForStarting()

        const restart = await app.request("/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        const cancelled = await execution

        expect(await restart.json()).toMatchObject({
          active: true,
          state: "idle",
          incarnation: 2,
          execution_count: 0,
          process_id: expect.any(Number),
        })
        expect(cancelled.status).toBe(409)
        expect(await cancelled.json()).toEqual({
          error: "kernel_startup_cancelled",
          message: "Kernel startup was cancelled before execution.",
        })
        expect(await (await status()).json()).toMatchObject({
          active: true,
          state: "idle",
          incarnation: 2,
        })
        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      },
    })
  }, 30_000)

  test("serializes concurrent cells sent to the same session kernel", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const workspace = await SessionFilesystem.workspace(session.id)
        const firstRelease = path.join(workspace, ".release-first-cell")
        const secondRelease = path.join(workspace, ".release-second-cell")
        const execute = (code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              id: "analysis.ipynb",
              language: "python",
              code,
            }),
          })
        type Status = {
          active?: boolean
          state?: string
          queue_depth?: number
          last_cell?: {
            source?: string
            code?: string
            status?: string
            execution_count?: number
          } | null
        }
        const status = async () =>
          (await (
            await app.request(`/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`)
          ).json()) as Status
        const statusDeadline = performance.now() + 20_000
        const waitForStatus = async (label: string, predicate: (value: Status) => boolean) => {
          let last: Status = {}
          while (performance.now() < statusDeadline) {
            last = await status()
            if (predicate(last)) return last
            await Bun.sleep(10)
          }
          throw new Error(`${label}; last status: ${JSON.stringify(last)}`)
        }
        const waitUntilExists = (file: string) =>
          `(lambda ready: ready or (_ for _ in ()).throw(TimeoutError('release sentinel timed out')))(next((True for _ in range(3000) if __import__('pathlib').Path(${JSON.stringify(file)}).exists() or (__import__('time').sleep(0.01), False)[1]), False))`
        const pending: Array<ReturnType<typeof execute>> = []

        try {
          const firstCode = `(${waitUntilExists(firstRelease)}, globals().__setitem__('queue_value', ['first']), 'first')[-1]`
          const first = execute(firstCode)
          pending.push(first)
          await waitForStatus(
            "first cell did not begin running",
            (value) =>
              value.active === true &&
              value.state === "running" &&
              value.queue_depth === 0 &&
              value.last_cell?.code === firstCode &&
              value.last_cell.execution_count === 1,
          )
          const secondCode = `(${waitUntilExists(secondRelease)}, queue_value.append('second'), queue_value)[-1]`
          const second = execute(secondCode)
          pending.push(second)
          const queued = await waitForStatus(
            "second cell did not enter the kernel queue",
            (value) =>
              value.state === "running" &&
              value.queue_depth === 1 &&
              value.last_cell?.code === firstCode &&
              value.last_cell.execution_count === 1,
          )
          expect(queued).toMatchObject({
            state: "running",
            queue_depth: 1,
            last_cell: {
              source: "analysis.ipynb",
              code: firstCode,
              status: "running",
              execution_count: 1,
            },
          })
          await fs.writeFile(firstRelease, "")
          const firstResponse = await first
          const secondRunning = await waitForStatus(
            "second cell did not begin after the first completed",
            (value) =>
              value.state === "running" &&
              value.queue_depth === 0 &&
              value.last_cell?.code === secondCode &&
              value.last_cell.execution_count === 2,
          )
          expect(secondRunning).toMatchObject({
            state: "running",
            queue_depth: 0,
            last_cell: {
              source: "analysis.ipynb",
              code: secondCode,
              status: "running",
              execution_count: 2,
            },
          })
          await fs.writeFile(secondRelease, "")
          const secondResponse = await second
          const firstResult = (await firstResponse.json()) as {
            execution_count: number
            outputs: Array<{ data?: Record<string, string> }>
          }
          const secondResult = (await secondResponse.json()) as {
            execution_count: number
            outputs: Array<{ data?: Record<string, string> }>
          }

          expect(firstResult.execution_count).toBe(1)
          expect(firstResult.outputs.some((output) => output.data?.["text/plain"] === "'first'")).toBe(true)
          expect(secondResult.execution_count).toBe(2)
          expect(secondResult.outputs.some((output) => output.data?.["text/plain"] === "['first', 'second']")).toBe(
            true,
          )
        } finally {
          await Promise.allSettled([fs.writeFile(firstRelease, ""), fs.writeFile(secondRelease, "")])
          await Promise.allSettled([
            app.request("/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionID: session.id,
                id: "analysis.ipynb",
                language: "python",
              }),
            }),
            ...pending,
          ])
        }
      },
    })
  }, 45_000)

  test("holds the queue slot of the booting cell before the kernel reports active", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const id = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "notebook:analysis.ipynb",
          language: "python" as const,
        }
        const cell = app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
            code: "(__import__('time').sleep(0.5), 'first')[-1]",
          }),
        })
        // Sample the value `/status` serves on every macrotask turn. Polling the
        // route instead would do enough I/O per attempt to step straight over the
        // window this pins, which is what let the defect stay invisible.
        const deadline = Date.now() + 20_000
        const ready = async () => {
          while (Date.now() < deadline) {
            const status = KernelRuntime.status(id)
            if (status.active) return status
            await Bun.sleep(0)
          }
          throw new Error("kernel did not start")
        }
        // A client that waits for the kernel and then sends its next cell must not
        // be able to overtake the cell that booted it, so the kernel may not turn
        // reachable until that cell already occupies the queue.
        expect((await ready()).state).toBe("running")
        const result = (await (await cell).json()) as { execution_count: number }
        expect(result.execution_count).toBe(1)

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, id: "analysis.ipynb", language: "python" }),
        })
      },
    })
  }, 30_000)

  test("reports each queued cell its own execution count", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const execute = (code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              id: "analysis.ipynb",
              language: "python",
              code,
            }),
          })

        // Every cell reports the position it actually ran at, straight out of the
        // kernel namespace, so the assertion never assumes which HTTP request
        // reached the queue first. A slow lead cell makes the rest pile up behind
        // it and drain back to back, which is when the counts got crossed: the
        // entry keeps a running total that each completion advances, and reading
        // that shared total back after a persist handed a cell whichever count
        // had landed last rather than its own.
        const position = "globals().setdefault('order', []).append(1), len(globals()['order'])"
        const lead = execute(`(__import__('time').sleep(0.5), ${position})[-1]`)
        const rest = Array.from({ length: 12 }, () => execute(`(${position})[-1]`))
        const counts = await Promise.all(
          [lead, ...rest].map(async (pending) => {
            const body = (await (await pending).json()) as {
              execution_count: number
              outputs: Array<{ data?: Record<string, string> }>
            }
            const ran = body.outputs.find((value) => value.data?.["text/plain"])?.data?.["text/plain"]
            return { ran: Number(ran), reported: body.execution_count }
          }),
        )
        // Each response carries the count of the cell it answers, and the kernel
        // ran all thirteen exactly once.
        for (const count of counts) expect(count.reported).toBe(count.ran)
        expect(counts.map((count) => count.ran).sort((a, b) => a - b)).toEqual(
          Array.from({ length: 13 }, (_, index) => index + 1),
        )

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, id: "analysis.ipynb", language: "python" }),
        })
      },
    })
  }, 30_000)

  test("boots one incarnation when a second cell arrives during startup", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const execute = (code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              id: "analysis.ipynb",
              language: "python",
              code,
            }),
          })

        // Both cells are in flight before the kernel process exists, so the second
        // has to find the startup already in flight and wait on it. Without that
        // record it opened a startup of its own and burned an extra incarnation.
        await Promise.all([execute("boot = 1"), execute("boot = 2")])
        const status = await app.request(
          `/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`,
        )
        expect(await status.json()).toMatchObject({
          active: true,
          state: "idle",
          incarnation: 1,
          execution_count: 2,
        })

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id, id: "analysis.ipynb", language: "python" }),
        })
      },
    })
  }, 30_000)

  test("releases every notebook kernel when its owning session is deleted", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const execute = (code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              id: "analysis.ipynb",
              language: "python",
              code,
            }),
          })

        expect((await execute("retired_value = 91")).status).toBe(200)
        await Session.remove(session.id)
        await Session.createNext({ id: session.id, directory: tmp.path })
        const fresh = await execute("globals().get('retired_value', 'missing')")
        const result = (await fresh.json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }

        expect(result.execution_count).toBe(1)
        expect(result.outputs.some((output) => output.data?.["text/plain"] === "'missing'")).toBe(true)

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
          }),
        })
      },
    })
  }, 30_000)

  test("does not retain a kernel whose session is deleted during startup", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        const status = () =>
          app.request(`/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`)
        const retired = app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, code: "retired_during_startup = 91" }),
        })
        const waitForStarting = async (attempt = 0): Promise<void> => {
          const result = (await (await status()).json()) as { state?: string }
          if (result.state === "starting") return
          if (attempt >= 100) throw new Error("kernel did not start")
          await Bun.sleep(10)
          return waitForStarting(attempt + 1)
        }
        await waitForStarting()

        await Session.remove(session.id)
        const cancelled = await retired
        expect(cancelled.status).toBe(409)
        expect(await cancelled.json()).toEqual({
          error: "kernel_startup_cancelled",
          message: "Kernel startup was cancelled before execution.",
        })
        await Session.createNext({ id: session.id, directory: tmp.path })
        const fresh = await app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            code: "globals().get('retired_during_startup', 'missing')",
          }),
        })
        const result = (await fresh.json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }

        expect(result.execution_count).toBe(1)
        expect(result.outputs.some((output) => output.data?.["text/plain"] === "'missing'")).toBe(true)

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      },
    })
  }, 30_000)

  test("interrupts a running cell without discarding Python state", async () => {
    await using _sandbox = await sandboxedExecution()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        const execute = (code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, code }),
          })
        const status = () =>
          app.request(`/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`)

        expect((await execute("retained_value = 41")).status).toBe(200)
        const running = execute("(__import__('time').sleep(5), retained_value)[-1]")
        const waitForRunning = async (attempt = 0): Promise<void> => {
          const response = (await (await status()).json()) as { state?: string }
          if (response.state === "running") return
          if (attempt >= 100) throw new Error("kernel did not start running")
          await Bun.sleep(10)
          return waitForRunning(attempt + 1)
        }
        await waitForRunning()

        const interrupted = await app.request("/interrupt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        expect(await interrupted.json()).toMatchObject({
          active: true,
          state: "idle",
          state_preserved: true,
          incarnation: 1,
        })
        expect((await running).status).toBe(200)

        const resumed = await execute("retained_value + 1")
        const result = (await resumed.json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }
        expect(result.execution_count).toBe(3)
        expect(result.outputs.some((output) => output.data?.["text/plain"] === "42")).toBe(true)

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      },
    })
  }, 30_000)

  test("controls a live kernel by id only for its owning session", async () => {
    await using _sandbox = await sandboxedExecution()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const other = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        const execute = (code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, code }),
          })
        expect((await execute("controlled_value = 41")).status).toBe(200)
        const kernels = (await (await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)).json()) as {
          kernels: Array<{ id: string; state: string; name: string; incarnation: number; process_id: number }>
        }
        const kernel = kernels.kernels.find((value) => value.name === "notebook:analysis.ipynb")
        expect(kernel).toBeDefined()
        if (!kernel) throw new Error("kernel was not listed")

        const running = execute("(__import__('time').sleep(5), controlled_value)[-1]")
        const waitForRunning = async (attempt = 0): Promise<void> => {
          const current = (await (
            await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)
          ).json()) as typeof kernels
          if (current.kernels.find((value) => value.id === kernel.id)?.state === "running") return
          if (attempt >= 100) throw new Error("kernel did not start running")
          await Bun.sleep(10)
          return waitForRunning(attempt + 1)
        }
        await waitForRunning()

        const denied = await app.request(`/kernels/${encodeURIComponent(kernel.id)}/interrupt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: other.id }),
        })
        expect(denied.status).toBe(404)

        const interrupted = await app.request(`/kernels/${encodeURIComponent(kernel.id)}/interrupt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(await interrupted.json()).toMatchObject({
          id: kernel.id,
          active: true,
          state: "idle",
          state_preserved: true,
        })
        await running

        const restarted = await app.request(`/kernels/${encodeURIComponent(kernel.id)}/restart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        const fresh = (await restarted.json()) as {
          id: string
          active: boolean
          state: string
          incarnation: number
          execution_count: number
          process_id: number
        }
        expect(fresh).toMatchObject({
          id: kernel.id,
          active: true,
          state: "idle",
          incarnation: 2,
          execution_count: 0,
        })
        expect(fresh.process_id).toBeGreaterThan(0)
        expect(fresh.process_id).not.toBe(kernel.process_id)

        await app.request(`/kernels/${encodeURIComponent(kernel.id)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
      },
    })
  }, 30_000)

  test("forgets only inactive records and leaves the named session kernel inventory truthful", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        expect(
          (
            await app.request("/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...body, code: "forget_value = 41" }),
            })
          ).status,
        ).toBe(200)
        const inventory = (await (
          await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)
        ).json()) as {
          kernels: Array<{ id: string; name: string; language: string }>
        }
        const kernel = inventory.kernels.find((value) => value.name === "notebook:analysis.ipynb")
        if (!kernel) throw new Error("notebook kernel was not listed")
        const url = `/kernels/${encodeURIComponent(kernel.id)}?sessionID=${encodeURIComponent(session.id)}`

        const active = await app.request(url, { method: "DELETE" })
        expect(active.status).toBe(409)
        expect(await active.json()).toEqual({
          error: "kernel_active",
          message: "Stop the kernel before forgetting its runtime record.",
        })

        await app.request(`/kernels/${encodeURIComponent(kernel.id)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect((await app.request(url, { method: "DELETE" })).status).toBe(204)

        const listed = (await (
          await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)
        ).json()) as typeof inventory
        expect(listed.kernels.some((value) => value.id === kernel.id)).toBe(false)
        expect(listed.kernels).toEqual([])
      },
    })
  }, 30_000)

  test("reconnects route reloads to the same live process and state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        const app = NotebookRoutes()
        expect(
          (
            await app.request("/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...body, code: "reload_value = 41" }),
            })
          ).status,
        ).toBe(200)
        const before = (await (
          await app.request(`/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`)
        ).json()) as {
          incarnation: number
          process_id: number
          process_started_at: number
          process_identity_verified: boolean | null
        }

        const reloaded = NotebookRoutes()
        const inventory = (await (
          await reloaded.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)
        ).json()) as {
          kernels: Array<{
            name: string
            incarnation: number
            process_id: number
            process_started_at: number
          }>
        }
        const live = inventory.kernels.find((kernel) => kernel.name === "notebook:analysis.ipynb")
        expect(live).toMatchObject(before)
        expect(before.process_id).toBeGreaterThan(0)
        expect(before.process_started_at).toBeGreaterThan(0)
        if (process.platform === "darwin" || process.platform === "linux") {
          expect(before.process_identity_verified).toBe(true)
        }

        const resumed = await reloaded.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, code: "reload_value + 1" }),
        })
        const result = (await resumed.json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }
        expect(result.execution_count).toBe(2)
        expect(result.outputs.some((output) => output.data?.["text/plain"] === "42")).toBe(true)

        await reloaded.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      },
    })
  }, 30_000)

  test("does not imply variables survived a backend instance restart", async () => {
    await using tmp = await tmpdir({ git: true })
    const sessionID = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const response = await NotebookRoutes().request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
            code: "backend_value = 73",
          }),
        })
        expect(response.status).toBe(200)
        await Instance.dispose()
        return session.id
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = NotebookRoutes()
        const status = await app.request(
          `/status?sessionID=${encodeURIComponent(sessionID)}&id=analysis.ipynb&language=python`,
        )
        expect(await status.json()).toMatchObject({
          active: false,
          state: "stopped",
          incarnation: 1,
          process_id: null,
        })

        const fresh = await app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID,
            id: "analysis.ipynb",
            language: "python",
            code: "globals().get('backend_value', 'missing')",
          }),
        })
        const result = (await fresh.json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }
        expect(result.execution_count).toBe(1)
        expect(result.outputs.some((output) => output.data?.["text/plain"] === "'missing'")).toBe(true)

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID, id: "analysis.ipynb", language: "python" }),
        })
      },
    })
  }, 30_000)

  test("reports an unexpected process exit as crashed and starts a clean incarnation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        const execute = (code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, code }),
          })

        expect((await execute("crash_value = 91")).status).toBe(200)
        await Promise.resolve(execute("__import__('os')._exit(17)")).catch(() => undefined)
        const crashed = await app.request(
          `/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`,
        )
        expect(await crashed.json()).toMatchObject({
          active: false,
          state: "crashed",
          incarnation: 1,
          execution_count: 1,
          process_id: null,
        })

        const fresh = await execute("globals().get('crash_value', 'missing')")
        const result = (await fresh.json()) as {
          execution_count: number
          outputs: Array<{ data?: Record<string, string> }>
        }
        expect(result.execution_count).toBe(1)
        expect(result.outputs.some((output) => output.data?.["text/plain"] === "'missing'")).toBe(true)
        expect(
          await (
            await app.request(`/status?sessionID=${encodeURIComponent(session.id)}&id=analysis.ipynb&language=python`)
          ).json(),
        ).toMatchObject({ active: true, state: "idle", incarnation: 2 })

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      },
    })
  }, 30_000)

  test("stop reaps the kernel process group and retains a truthful stopped record", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const
        const execution = await app.request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...body,
            code: "__import__('subprocess').Popen([__import__('sys').executable, '-c', 'import time; time.sleep(30)']).pid",
          }),
        })
        const result = (await execution.json()) as {
          outputs: Array<{ data?: Record<string, string> }>
        }
        const child = Number(result.outputs.find((output) => output.data?.["text/plain"])?.data?.["text/plain"])
        const inventory = (await (
          await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)
        ).json()) as {
          kernels: Array<{ id: string; name: string; process_id: number }>
        }
        const kernel = inventory.kernels.find((value) => value.name === "notebook:analysis.ipynb")
        if (!kernel) throw new Error("live notebook kernel was not listed")
        expect(alive(kernel.process_id)).toBe(true)
        if (Sandbox.backend() !== "bubblewrap") expect(alive(child)).toBe(true)

        const stopped = await app.request(`/kernels/${encodeURIComponent(kernel.id)}/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(await stopped.json()).toMatchObject({
          id: kernel.id,
          active: false,
          state: "stopped",
          incarnation: 1,
          execution_count: 0,
          process_id: null,
        })
        await waitForExit(kernel.process_id)
        // Bubblewrap returns the PID as seen inside its private namespace. It is
        // deliberately not addressable from the host; wrapper exit is the
        // observable guarantee that its PID-1 reaper has torn the sandbox down.
        if (Sandbox.backend() !== "bubblewrap") await waitForExit(child)

        const listed = (await (await app.request(`/kernels?sessionID=${encodeURIComponent(session.id)}`)).json()) as {
          kernels: Array<{ id: string; state: string }>
        }
        expect(listed.kernels).toContainEqual(expect.objectContaining({ id: kernel.id, state: "stopped" }))
      },
    })
  }, 30_000)

  test("keeps R state within one live session incarnation when R is available", async () => {
    if (!Bun.which("Rscript")) return
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const first = await Session.create({})
        const second = await Session.create({})
        const execute = (sessionID: string, code: string) =>
          app.request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionID, id: "analysis.ipynb", language: "r", code }),
          })

        expect((await execute(first.id, "private_value <- 41")).status).toBe(200)
        const resumed = (await (await execute(first.id, "private_value + 1")).json()) as {
          execution_count: number
          outputs: Array<{ text?: string }>
        }
        const isolated = (await (await execute(second.id, "exists('private_value')")).json()) as {
          execution_count: number
          outputs: Array<{ text?: string }>
        }
        expect(resumed.execution_count).toBe(2)
        expect(resumed.outputs.some((output) => output.text?.includes("42"))).toBe(true)
        expect(isolated.execution_count).toBe(1)
        expect(isolated.outputs.some((output) => output.text?.includes("FALSE"))).toBe(true)

        await Promise.all(
          [first.id, second.id].map((sessionID) =>
            app.request("/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionID, id: "analysis.ipynb", language: "r" }),
            }),
          ),
        )
      },
    })
  }, 30_000)

  test("validates notebook execution input", async () => {
    const response = await NotebookRoutes().request("/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "", language: "julia", code: "" }),
    })

    expect(response.status).toBe(400)
  })

  test("rejects an invalid interpreter environment instead of running the default interpreter", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const response = await NotebookRoutes().request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
            environment: "../nbody",
            code: "raise RuntimeError('must not execute')",
          }),
        })

        expect(response.status).toBe(400)
        const missing = await NotebookRoutes().request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
            environment: "nbody",
            code: "raise RuntimeError('must not execute')",
          }),
        })
        expect(missing.status).toBe(400)
        expect(await missing.text()).toContain("Python environment 'nbody' was not found")
        expect(KernelRuntime.list(session.id)).toEqual([])
      },
    })
  })

  test("addresses separate persistent Python processes and site-packages by environment", async () => {
    await using tmp = await tmpdir({ git: true })
    const python = await createPythonEnvironment(tmp.path, "python")
    const nbody = await createPythonEnvironment(tmp.path, "nbody")
    const marker = `openscience_env_marker_${crypto.randomUUID().replaceAll("-", "")}`
    const site = Bun.spawnSync([nbody, "-c", "import site; print(site.getsitepackages()[0])"])
    expect(site.success).toBe(true)
    await fs.writeFile(path.join(site.stdout.toString().trim(), `${marker}.py`), "VALUE = 99\n")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        const execute = async (environment: string, code: string, id = "analysis.ipynb") => {
          const response = await NotebookRoutes().request("/execute", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              id,
              language: "python",
              environment,
              code,
            }),
          })
          expect(response.status).toBe(200)
          return (await response.json()) as {
            ok: boolean
            outputs: Array<{ output_type: string; name?: string; text?: string; data?: Record<string, string> }>
          }
        }
        const status = async (environment: string) => {
          const query = new URLSearchParams({
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
            environment,
          })
          const response = await NotebookRoutes().request(`/status?${query}`)
          expect(response.status).toBe(200)
          return (await response.json()) as {
            process_id: number
            environment_name: string
            environment: { interpreter: { name: string; binary: string; version?: string } }
          }
        }

        const [plain, isolated] = await Promise.all([
          execute(
            "python",
            `import importlib.util\nx = 41\nprint(importlib.util.find_spec(${JSON.stringify(marker)}) is None)`,
          ),
          execute("nbody", `import ${marker}\nx = ${marker}.VALUE\nprint(x)`),
        ])
        expect(plain.ok).toBe(true)
        expect(plain.outputs.some((output) => output.text?.trim() === "True")).toBe(true)
        expect(isolated.ok).toBe(true)
        expect(isolated.outputs.some((output) => output.text?.trim() === "99")).toBe(true)

        const [plainState, isolatedState, plainStatus, isolatedStatus] = await Promise.all([
          execute("python", "x + 1", "other.ipynb"),
          execute("nbody", "x + 1", "other.ipynb"),
          status("python"),
          status("nbody"),
        ])
        expect(plainState.outputs.some((output) => output.data?.["text/plain"] === "42")).toBe(true)
        expect(isolatedState.outputs.some((output) => output.data?.["text/plain"] === "100")).toBe(true)
        expect(plainStatus.process_id).not.toBe(isolatedStatus.process_id)
        expect(plainStatus.environment_name).toBe("python")
        expect(isolatedStatus.environment_name).toBe("nbody")
        expect(plainStatus.environment.interpreter).toMatchObject({ name: "python", binary: python })
        expect(isolatedStatus.environment.interpreter).toMatchObject({ name: "nbody", binary: nbody })
        expect(plainStatus.environment.interpreter.version).toMatch(/^Python /)
        expect(isolatedStatus.environment.interpreter.version).toMatch(/^Python /)

        const restarted = await NotebookRoutes().request("/restart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID: session.id,
            id: "analysis.ipynb",
            language: "python",
            environment: "nbody",
          }),
        })
        expect(restarted.status).toBe(200)
        const fresh = (await restarted.json()) as {
          process_id: number
          incarnation: number
          environment: { interpreter: { name: string; binary: string } }
        }
        expect(fresh.process_id).not.toBe(isolatedStatus.process_id)
        expect(fresh.incarnation).toBe(2)
        expect(fresh.environment.interpreter).toMatchObject({ name: "nbody", binary: nbody })
        const reset = await execute("nbody", '"x" in globals()', "after-restart.ipynb")
        expect(reset.outputs.some((output) => output.data?.["text/plain"] === "False")).toBe(true)

        await Promise.all(
          ["python", "nbody"].map((environment) =>
            NotebookRoutes().request("/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                sessionID: session.id,
                id: "analysis.ipynb",
                language: "python",
                environment,
              }),
            }),
          ),
        )
      },
    })
  }, 120_000)

  test("rejects kernel operations for a session outside the active project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await NotebookRoutes().request("/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionID: Identifier.ascending("session"),
            id: "analysis.ipynb",
            language: "python",
            code: "40 + 2",
          }),
        })

        expect(response.status).toBe(404)
        expect(await response.json()).toEqual({
          error: "session_not_found",
          message: "The session does not exist in this project.",
        })
      },
    })
  })

  test("reports machine capacity without a session and reports a true zero for kernel share", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const response = await NotebookRoutes().request("/compute")

        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          memory: { total: number; available: number; kernels?: number }
          cpu: { cores: number; busy?: number; kernels?: number }
          kernels: { live: number; running: number }
        }

        expect(body.memory.total).toBeGreaterThan(0)
        expect(body.memory.available).toBeGreaterThan(0)
        expect(body.memory.available).toBeLessThanOrEqual(body.memory.total)
        expect(body.cpu.cores).toBeGreaterThanOrEqual(1)
        expect(body.kernels).toEqual({ live: 0, running: 0 })
        // No live kernels exist, so the kernel-attributed share is knowably
        // zero — a real measurement, not an unsampled figure to omit.
        expect(body.memory.kernels).toBe(0)
        expect(body.cpu.kernels).toBe(0)
      },
    })
  })

  test("measures each named client's own window rather than letting the first starve the rest", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = NotebookRoutes()
        const busy = (body: unknown) => (body as { cpu: { busy?: number } }).cpu.busy
        // Two browser tabs with the Compute pane open, each polling every 2.5s
        // and offset by 150ms. Sharing one window on the server, whichever tab
        // lands first each cycle advances it and the other measures only that
        // 150ms gap — refused by the one-second floor, every cycle, forever.
        const poll = async (client: string, offset: number) => {
          await Bun.sleep(offset)
          const seen: Array<number | undefined> = []
          for (let round = 0; round < 3; round += 1) {
            seen.push(busy(await (await app.request(`/compute?client=${client}`)).json()))
            await Bun.sleep(2_500)
          }
          return seen
        }
        const [first, second] = await Promise.all([poll("tab-a", 0), poll("tab-b", 150)])

        for (const seen of [first, second]) {
          expect(seen.length).toBe(3)
          for (const value of seen) expect(typeof value).toBe("number")
        }
      },
    })
  }, 30_000)

  test("omits a live kernel's figure on its first compute poll instead of fabricating zero", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = {
          sessionID: session.id,
          id: "analysis.ipynb",
          language: "python",
        } as const

        expect(
          (
            await app.request("/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...body, code: "warm = 1" }),
            })
          ).status,
        ).toBe(200)

        // The kernel is live, but this is the very first sample the "compute"
        // scope has ever taken for its pid: cpu_percent needs a delta against a
        // prior baseline, so it has none yet. That is case 2 from the fix — a
        // live kernel whose figure is genuinely unmeasurable right now — and it
        // must stay omitted, never reported as a fabricated 0.
        const compute = await app.request("/compute")
        const result = (await compute.json()) as {
          cpu: { kernels?: number }
          kernels: { live: number; running: number }
        }

        expect(result.kernels.live).toBeGreaterThan(0)
        expect("kernels" in result.cpu).toBe(false)

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      },
    })
  }, 30_000)

  test("gives each kernels-panel client its own sampling window instead of one shared scope", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const app = NotebookRoutes()
        const session = await Session.create({})
        const body = { sessionID: session.id, id: "analysis.ipynb", language: "python" } as const

        expect(
          (
            await app.request("/execute", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...body, code: "warm = 1" }),
            })
          ).status,
        ).toBe(200)

        KernelMetrics.reset()
        // Two panels — two tabs on the same session — poll this route. Each
        // measures across the window since ITS OWN previous poll, so each must
        // get its own baseline. Sharing one scope means whichever polls first
        // advances it and the other's window collapses to the stagger between
        // them, falls under the one-second floor, and reads Unavailable forever.
        await app.request(`/kernels?sessionID=${session.id}&client=tab-a`)
        await app.request(`/kernels?sessionID=${session.id}&client=tab-b`)

        const keys = KernelMetrics.tracked()
        const a = keys.filter((key) => key.startsWith("kernels:tab-a:"))
        const b = keys.filter((key) => key.startsWith("kernels:tab-b:"))

        // The same live pid, tracked once per client: two independent windows.
        expect(a.length).toBeGreaterThan(0)
        expect(b.length).toBeGreaterThan(0)
        expect(a[0]?.split(":").at(-1)).toBe(b[0]?.split(":").at(-1))

        await app.request("/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      },
    })
  }, 30_000)
})
