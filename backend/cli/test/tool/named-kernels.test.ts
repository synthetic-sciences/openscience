import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import { NotebookTool } from "../../src/tool/notebook"
import { RKernelTool } from "../../src/tool/rkernel"
import { executionSession, tmpdir } from "../fixture/fixture"

const context = (sessionID: string, callID: string) => ({
  sessionID,
  messageID: "message_named_kernels",
  callID,
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
})

test("kernel tools advertise and validate isolated managed names", async () => {
  const python = await NotebookTool.init()
  const r = await RKernelTool.init()

  expect(python.description).toContain("distinct `kernel` names")
  expect(python.description).toContain("Never use shell subprocesses")
  expect(python.description).toContain("`action: stop`")
  expect(r.description).toContain("distinct `kernel` names")
  expect(python.parameters.parse({ code: "1 + 1", kernel: "descriptive-eda" }).kernel).toBe("descriptive-eda")
  expect(r.parameters.parse({ code: "1 + 1", kernel: "stratified_rates" }).kernel).toBe("stratified_rates")
  expect(() => python.parameters.parse({ code: "1 + 1", kernel: "invalid name" })).toThrow()
})

test("four named notebook calls own four live managed kernels", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await NotebookTool.init()
      const names = ["descriptive-eda", "survival-rates", "inference", "model-benchmark"]
      const identities: KernelIdentity[] = names.map((name) => ({
        projectID: Instance.project.id,
        sessionID: session.id,
        name,
        language: "python",
      }))

      try {
        const results = await Promise.all(
          names.map((name, index) =>
            tool.execute(
              {
                action: "execute",
                code: `import time\ntime.sleep(0.15)\nprint(${JSON.stringify(name)})`,
                kernel: name,
                timeout: 30_000,
              },
              context(session.id, `call_named_kernel_${index}`),
            ),
          ),
        )

        expect(results.map((result) => result.output.trim())).toEqual(names)
        expect(
          KernelRuntime.list(session.id)
            .filter((kernel) => kernel.active)
            .map((kernel) => kernel.name)
            .sort(),
        ).toEqual(names.toSorted())
        const stopped = await Promise.all(
          names.map((name, index) =>
            tool.execute({ action: "stop", kernel: name, timeout: 30_000 }, context(session.id, `call_stop_${index}`)),
          ),
        )
        expect(stopped.every((result) => result.metadata.stopped === true)).toBe(true)
        expect(KernelRuntime.list(session.id).some((kernel) => kernel.active)).toBe(false)
      } finally {
        await Promise.all(identities.map((identity) => KernelRuntime.release(identity)))
      }
    },
  })
}, 60_000)
