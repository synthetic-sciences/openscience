import { Hono, type Context } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "../../project/instance"
import "../../tool/notebook"
import "../../tool/rkernel"
import type { ExecuteResult, KernelOutput } from "../../science/kernel/types"
import { KernelRuntime, KernelStartupCancelled, KernelStatus, type KernelIdentity } from "../../science/kernel/registry"
import { KernelMetrics } from "../../science/kernel/metrics"
import { KernelHost } from "../../science/kernel/host"
import { SessionFilesystem } from "../../session/filesystem"
import { Identifier } from "../../id/id"
import { Session } from "../../session"
import { lazy } from "../../util/lazy"
import { Storage } from "../../storage/storage"
import { CommandRuntime, CommandStatus } from "../../science/command/registry"

const Language = z.enum(["python", "r"])
const Key = z.object({
  sessionID: Identifier.schema("session"),
  id: z.string().trim().min(1).max(1024),
  language: Language,
})
const List = z.object({
  sessionID: Identifier.schema("session").optional(),
})
const Owner = z.object({
  sessionID: Identifier.schema("session"),
})
const ControlStatus = KernelStatus.extend({
  state_preserved: z.boolean().optional(),
})
const KernelParam = z.object({
  kernelID: z.string().regex(/^kernel-[a-z0-9]+$/),
})
const CommandParam = z.object({
  commandID: z.string().regex(/^command-[a-f0-9-]+$/),
})
const Execute = Key.extend({
  code: z.string().max(2_000_000),
  timeout: z.number().int().min(5_000).max(600_000).optional(),
})

type Language = z.infer<typeof Language>

const identity = (input: { sessionID: string; id: string; language: Language }): KernelIdentity => ({
  projectID: Instance.project.id,
  sessionID: input.sessionID,
  name: `notebook:${input.id}`,
  language: input.language,
})

const owner = async (c: Context, sessionID: string) =>
  Session.get(sessionID)
    .then((session) => {
      if (session.projectID === Instance.project.id) return
      return c.json({ error: "session_not_found", message: "The session does not exist in this project." }, 404)
    })
    .catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) {
        return c.json({ error: "session_not_found", message: "The session does not exist in this project." }, 404)
      }
      if (Session.DirectoryMismatchError.isInstance(error)) return c.json(error.toObject(), 409)
      throw error
    })

function output(value: KernelOutput, execution: number | null) {
  if (value.type === "stream") {
    return {
      output_type: "stream",
      name: value.name ?? "stdout",
      text: value.data?.["text/plain"] ?? "",
    }
  }
  if (value.type === "error") {
    return {
      output_type: "error",
      ename: value.error?.name ?? "Error",
      evalue: value.error?.message ?? "Kernel execution failed",
      traceback: value.error?.traceback ?? [],
    }
  }
  return {
    output_type: value.type === "result" ? "execute_result" : "display_data",
    data: value.data ?? {},
    metadata: {},
    ...(value.type === "result" ? { execution_count: execution } : {}),
  }
}

function response(result: ExecuteResult) {
  const execution = result.executionCount ?? null
  return {
    ok: result.ok,
    execution_count: execution,
    outputs: result.outputs.map((value) => output(value, execution)),
  }
}

export const NotebookRoutes = lazy(() =>
  new Hono()
    .get(
      "/compute",
      describeRoute({
        summary: "Report live local compute capacity",
        operationId: "notebook.compute",
        responses: { 200: { description: "Machine capacity and the share live kernels and commands hold" } },
      }),
      async (c) => {
        // Both samplers measure across the window since THIS caller's previous
        // poll, so the caller has to name itself. Several surfaces poll this one
        // route independently — two browser tabs on their own 2.5s offsets are
        // the ordinary case — and a window shared between them is truncated to
        // the gap between their polls, which the one-second floor then refuses
        // for whichever of them polled second, every cycle, forever. A client
        // that sends no identity shares the default window, which is the
        // behaviour before this parameter existed.
        const caller = c.req.query("client")?.slice(0, 128) || "anonymous"
        const host = await KernelHost.snapshot(caller)
        const live = KernelRuntime.list().filter((kernel) => kernel.active)
        const commands = CommandRuntime.list(Instance.project.id)
        const samples = await KernelMetrics.sampleAll(`compute:${caller}`, [
          ...live.flatMap((kernel) => (kernel.process_id === null ? [] : [kernel.process_id])),
          ...commands.map((command) => command.process_id),
        ])
        const usage = [...samples.values()]
        const kernelUsage = live.flatMap((kernel) => {
          const value = kernel.process_id === null ? undefined : samples.get(kernel.process_id)
          return value ? [value] : []
        })
        const cpu = usage.filter((sample) => sample.cpu_percent !== undefined)
        const memory = usage.filter((sample) => sample.memory_bytes !== undefined)
        const kernelCpu = kernelUsage.filter((sample) => sample.cpu_percent !== undefined)
        const kernelMemory = kernelUsage.filter((sample) => sample.memory_bytes !== undefined)
        return c.json({
          memory: {
            total: host.memory.total,
            available: host.memory.available,
            ...(live.length === 0 && commands.length === 0
              ? { compute: 0 }
              : memory.length
                ? { compute: memory.reduce((sum, item) => sum + (item.memory_bytes ?? 0), 0) }
                : {}),
            ...(live.length === 0
              ? { kernels: 0 }
              : kernelMemory.length
                ? { kernels: kernelMemory.reduce((sum, item) => sum + (item.memory_bytes ?? 0), 0) }
                : {}),
          },
          cpu: {
            cores: host.cpu.cores,
            ...(host.cpu.busy === undefined ? {} : { busy: host.cpu.busy }),
            ...(live.length === 0 && commands.length === 0
              ? { compute: 0 }
              : cpu.length
                ? { compute: cpu.reduce((sum, item) => sum + (item.cpu_percent ?? 0), 0) / 100 }
                : {}),
            ...(live.length === 0
              ? { kernels: 0 }
              : kernelCpu.length
                ? { kernels: kernelCpu.reduce((sum, item) => sum + (item.cpu_percent ?? 0), 0) / 100 }
                : {}),
          },
          kernels: {
            live: live.length,
            running: live.filter((kernel) => kernel.state === "running").length,
          },
          commands: {
            live: commands.length,
            running: commands.length,
          },
        })
      },
    )
    .get(
      "/commands",
      describeRoute({
        summary: "List live project shell commands",
        operationId: "notebook.commands",
        responses: {
          200: {
            description: "Live shell commands and process resource usage",
            content: { "application/json": { schema: resolver(z.object({ commands: CommandStatus.array() })) } },
          },
        },
      }),
      validator("query", List),
      async (c) => {
        const query = c.req.valid("query")
        if (query.sessionID) {
          const denied = await owner(c, query.sessionID)
          if (denied) return denied
        }
        const commands = CommandRuntime.list(Instance.project.id, query.sessionID)
        const caller = c.req.query("client")?.slice(0, 128) || "anonymous"
        const samples = await KernelMetrics.sampleAll(
          `commands:${caller}`,
          commands.map((command) => command.process_id),
        )
        return c.json({
          commands: commands.map((command) => {
            const resources = samples.get(command.process_id)
            return resources && Object.keys(resources).length ? { ...command, resources } : command
          }),
        })
      },
    )
    .post(
      "/commands/:commandID/stop",
      describeRoute({
        summary: "Stop a live shell command",
        operationId: "notebook.command.stop",
        responses: { 200: { description: "Command stopped" }, 404: { description: "Command not found" } },
      }),
      validator("param", CommandParam),
      validator("json", Owner),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        const stopped = await CommandRuntime.stop(c.req.valid("param").commandID, Instance.project.id, body.sessionID)
        if (!stopped) {
          return c.json({ error: "command_not_found", message: "The command is no longer running." }, 404)
        }
        return c.json({ stopped: true })
      },
    )
    .get(
      "/kernels",
      describeRoute({
        summary: "List session kernel records",
        operationId: "notebook.kernels",
        responses: {
          200: {
            description: "Project kernel records and live process state",
            content: { "application/json": { schema: resolver(z.object({ kernels: KernelStatus.array() })) } },
          },
        },
      }),
      validator("query", List),
      async (c) => {
        const query = c.req.valid("query")
        if (query.sessionID) {
          const denied = await owner(c, query.sessionID)
          if (denied) return denied
        }
        await KernelRuntime.restoreSession(Instance.project.id, query.sessionID)
        const owners = new Set<string>()
        if (query.sessionID) {
          owners.add(query.sessionID)
        }
        if (!query.sessionID) {
          for await (const session of Session.list()) {
            owners.add(session.id)
          }
        }
        const live = KernelRuntime.list(query.sessionID).filter((kernel) => owners.has(kernel.sessionID))
        // Scoped per caller for the same reason /compute is: the CPU figure is a
        // delta across the window since THIS caller's previous poll, so two
        // panels sharing one scope truncate each other's window to the stagger
        // between them, fall under the one-second floor, and both read
        // Unavailable forever. `client` is deliberately read off the raw query
        // rather than the validated one — it identifies a poller, it is not part
        // of the route's contract, and an absent or forged value can only cost
        // its own sender a window.
        const caller = c.req.query("client")?.slice(0, 128) || "anonymous"
        const samples = await KernelMetrics.sampleAll(
          `kernels:${caller}`,
          live.flatMap((kernel) => (kernel.active && kernel.process_id !== null ? [kernel.process_id] : [])),
        )
        const kernels = live.map((kernel) => {
          const resources = kernel.process_id === null ? undefined : samples.get(kernel.process_id)
          return resources && Object.keys(resources).length ? { ...kernel, resources } : kernel
        })
        return c.json({ kernels })
      },
    )
    .post(
      "/kernels/:kernelID/restart",
      describeRoute({
        summary: "Restart a kernel in a fresh runtime",
        operationId: "notebook.kernel.restart",
        responses: {
          200: {
            description: "Fresh live kernel state",
            content: { "application/json": { schema: resolver(KernelStatus) } },
          },
        },
      }),
      validator("param", KernelParam),
      validator("json", Owner),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, body.sessionID)
        const input = KernelRuntime.owned(c.req.valid("param").kernelID, Instance.project.id, body.sessionID)
        if (!input) {
          return c.json({ error: "kernel_not_found", message: "The kernel does not exist in this session." }, 404)
        }
        return c.json(await KernelRuntime.restart(input, { cwd: await SessionFilesystem.workspace(body.sessionID) }))
      },
    )
    .post(
      "/kernels/:kernelID/stop",
      describeRoute({
        summary: "Stop a kernel process",
        operationId: "notebook.kernel.stop",
        responses: {
          200: {
            description: "Stopped kernel state",
            content: { "application/json": { schema: resolver(KernelStatus) } },
          },
        },
      }),
      validator("param", KernelParam),
      validator("json", Owner),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, body.sessionID)
        const input = KernelRuntime.owned(c.req.valid("param").kernelID, Instance.project.id, body.sessionID)
        if (!input) {
          return c.json({ error: "kernel_not_found", message: "The kernel does not exist in this session." }, 404)
        }
        await KernelRuntime.release(input)
        return c.json(KernelRuntime.status(input))
      },
    )
    .post(
      "/kernels/:kernelID/interrupt",
      describeRoute({
        summary: "Interrupt a live kernel",
        operationId: "notebook.kernel.interrupt",
        responses: {
          200: {
            description: "Kernel state",
            content: { "application/json": { schema: resolver(ControlStatus) } },
          },
        },
      }),
      validator("param", KernelParam),
      validator("json", Owner),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, body.sessionID)
        const input = KernelRuntime.owned(c.req.valid("param").kernelID, Instance.project.id, body.sessionID)
        if (!input) {
          return c.json({ error: "kernel_not_found", message: "The kernel does not exist in this session." }, 404)
        }
        return c.json(await KernelRuntime.interrupt(input))
      },
    )
    .delete(
      "/kernels/:kernelID",
      describeRoute({
        summary: "Forget an inactive kernel record",
        operationId: "notebook.kernel.delete",
        responses: { 204: { description: "Kernel record forgotten" } },
      }),
      validator("param", KernelParam),
      validator("query", Owner),
      async (c) => {
        const query = c.req.valid("query")
        const denied = await owner(c, query.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, query.sessionID)
        const input = KernelRuntime.owned(c.req.valid("param").kernelID, Instance.project.id, query.sessionID)
        if (!input) {
          return c.json({ error: "kernel_not_found", message: "The kernel does not exist in this session." }, 404)
        }
        const status = KernelRuntime.status(input)
        if (status.active || status.state === "starting") {
          return c.json(
            { error: "kernel_active", message: "Stop the kernel before forgetting its runtime record." },
            409,
          )
        }
        await KernelRuntime.forget(input)
        return c.body(null, 204)
      },
    )
    .post(
      "/execute",
      describeRoute({
        summary: "Execute a notebook cell",
        description: "Execute code in a persistent project-scoped Python or R kernel.",
        operationId: "notebook.execute",
        responses: { 200: { description: "Jupyter-compatible cell outputs" } },
      }),
      validator("json", Execute),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        const result = await KernelRuntime.execute(
          identity(body),
          body.code,
          { timeout: body.timeout, origin: { source: body.id } },
          { cwd: await SessionFilesystem.workspace(body.sessionID) },
        ).catch((error) => {
          if (error instanceof KernelStartupCancelled) return error
          throw error
        })
        if (result instanceof KernelStartupCancelled) {
          return c.json({ error: "kernel_startup_cancelled", message: result.message }, 409)
        }
        return c.json({ ...response(result), provenance_id: result.provenanceID })
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Get notebook kernel status",
        operationId: "notebook.status",
        responses: {
          200: {
            description: "Kernel state",
            content: { "application/json": { schema: resolver(KernelStatus) } },
          },
        },
      }),
      validator("query", Key),
      async (c) => {
        const query = c.req.valid("query")
        const denied = await owner(c, query.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, query.sessionID)
        return c.json(KernelRuntime.status(identity(query)))
      },
    )
    .post(
      "/restart",
      describeRoute({
        summary: "Restart a notebook kernel",
        operationId: "notebook.restart",
        responses: {
          200: {
            description: "Fresh live kernel state",
            content: { "application/json": { schema: resolver(KernelStatus) } },
          },
        },
      }),
      validator("json", Key),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, body.sessionID)
        return c.json(
          await KernelRuntime.restart(identity(body), { cwd: await SessionFilesystem.workspace(body.sessionID) }),
        )
      },
    )
    .post(
      "/stop",
      describeRoute({
        summary: "Stop a notebook kernel",
        operationId: "notebook.stop",
        responses: {
          200: {
            description: "Stopped kernel state",
            content: { "application/json": { schema: resolver(KernelStatus) } },
          },
        },
      }),
      validator("json", Key),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, body.sessionID)
        await KernelRuntime.release(identity(body))
        return c.json(KernelRuntime.status(identity(body)))
      },
    )
    .post(
      "/interrupt",
      describeRoute({
        summary: "Interrupt a notebook kernel",
        description: "Stop the running cell while preserving kernel state when the runtime supports interruption.",
        operationId: "notebook.interrupt",
        responses: {
          200: {
            description: "Kernel state",
            content: { "application/json": { schema: resolver(ControlStatus) } },
          },
        },
      }),
      validator("json", Key),
      async (c) => {
        const body = c.req.valid("json")
        const denied = await owner(c, body.sessionID)
        if (denied) return denied
        await KernelRuntime.restoreSession(Instance.project.id, body.sessionID)
        return c.json(await KernelRuntime.interrupt(identity(body)))
      },
    ),
)
