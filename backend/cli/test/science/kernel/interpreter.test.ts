import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  KernelEnvironmentName,
  KernelEnvironmentUnavailable,
  normalizeKernelEnvironmentName,
  pythonEnvironment,
} from "../../../src/science/kernel/interpreter"
import { tmpdir } from "../../fixture/fixture"
import { Instance } from "../../../src/project/instance"
import { ProjectTrust } from "../../../src/project/trust"
import { Session } from "../../../src/session"
import { PythonTool } from "../../../src/tool/notebook"
import { ExecutionAuthority } from "../../../src/project/execution"
import { KernelRuntime, type KernelIdentity } from "../../../src/science/kernel/registry"
import { AuthorityProcessLedger } from "../../../src/project/authority-process"
import { Sandbox } from "../../../src/sandbox/sandbox"
import { Global } from "../../../src/global"
import { Config } from "../../../src/config/config"
import "../../../src/tool/rkernel"

async function containedExecution() {
  const previous = (await Config.trustedSandbox()).enabled
  await Config.setSandbox({ enabled: true })
  return {
    async [Symbol.asyncDispose]() {
      await Config.setSandbox({ enabled: previous })
    },
  }
}

test("Python environment names cannot escape the project virtual-environment directory", () => {
  expect(() => KernelEnvironmentName.parse("../nbody")).toThrow("path separators")
  expect(() => KernelEnvironmentName.parse("nbody/main")).toThrow("path separators")
  expect(KernelEnvironmentName.parse("nbody-3.12")).toBe("nbody-3.12")
  expect(normalizeKernelEnvironmentName("default")).toBe("python")
  expect(normalizeKernelEnvironmentName("DEFAULT")).toBe("python")
})

test("the default Python environment falls back to the host but a missing named environment fails closed", async () => {
  await using tmp = await tmpdir()
  expect(await pythonEnvironment(tmp.path)).toEqual({ environmentName: "python" })
  expect(await pythonEnvironment(tmp.path, "default")).toEqual({ environmentName: "python" })
  await expect(pythonEnvironment(tmp.path, "nbody")).rejects.toBeInstanceOf(KernelEnvironmentUnavailable)
})

test("a named Python environment resolves only its fixed project-local interpreter path", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, ".venv", "nbody")
  const bin = process.platform === "win32" ? path.join(root, "Scripts") : path.join(root, "bin")
  const binary = path.join(bin, process.platform === "win32" ? "python.exe" : "python")
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(binary, process.platform === "win32" ? "test" : "#!/bin/sh\nexit 0\n")
  if (process.platform !== "win32") await fs.chmod(binary, 0o755)

  const result = await pythonEnvironment(tmp.path, "nbody")
  expect(result.binary).toBe(binary)
  expect(result.environmentName).toBe("nbody")
  expect(result.env?.VIRTUAL_ENV).toBe(root)
  expect(result.env?.PATH?.split(path.delimiter)[0]).toBe(bin)
})

test("project .venv discovery is side-effect free before sandboxed execution", async () => {
  await using _sandbox = await containedExecution()
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const root = path.join(dir, ".venv")
      const bin = process.platform === "win32" ? path.join(root, "Scripts") : path.join(root, "bin")
      const binary = path.join(bin, process.platform === "win32" ? "python.exe" : "python")
      const marker = path.join(dir, "malicious-venv-executed")
      await fs.mkdir(bin, { recursive: true })
      await fs.writeFile(
        binary,
        process.platform === "win32"
          ? "malicious project executable"
          : `#!/bin/sh\nprintf pwned > ${JSON.stringify(marker)}\nexit 0\n`,
      )
      if (process.platform !== "win32") await fs.chmod(binary, 0o755)
      return { marker }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      expect(await pythonEnvironment(tmp.path)).toMatchObject({ binary: expect.stringContaining(".venv") })
      expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)

      const session = await Session.create({})
      const tool = await PythonTool.init()
      const run = tool.execute(
        { code: "print('should not run')", timeout: 5_000 },
        {
          sessionID: session.id,
          messageID: "message_untrusted_venv",
          callID: "call_untrusted_venv",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )

      const error = await run.then(
        () => undefined,
        (cause) => cause,
      )
      expect(error).toBeInstanceOf(Error)
      if (Sandbox.describe().available) {
        expect(error).not.toBeInstanceOf(ExecutionAuthority.DeniedError)
        // Explicit execution may modify the granted project workspace; the
        // authority-policy regression separately proves it cannot reach HOME.
        expect(await Bun.file(tmp.extra.marker).text()).toBe("pwned")
      } else {
        expect(error).toBeInstanceOf(ExecutionAuthority.DeniedError)
        expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)
      }
    },
  })
})

test.skipIf(process.platform === "win32")(
  "an R override is discovered without execution and reports its version only after durable READY",
  async () => {
    await using _sandbox = await containedExecution()
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const marker = path.join(dir, "r-version-preflight-executed")
        const binary = path.join(dir, "project-Rscript")
        await fs.writeFile(
          binary,
          `#!/bin/sh
if [ "\${1-}" = "--version" ]; then
  printf executed > ${JSON.stringify(marker)}
  printf 'R version 0.0 preflight\\n'
  exit 0
fi
printf '__OPENSCIENCE_KERNEL_READY__R version 9.9.0 governed\\n'
while IFS= read -r line; do
  if [ "$line" = "__OPENSCIENCE_CODE_END__" ]; then
    printf '__OPENSCIENCE_R_RESULT_START__\\nOK:1\\nIMG:\\n__OPENSCIENCE_R_OUT__\\n42\\n__OPENSCIENCE_R_MSG__\\n\\n__OPENSCIENCE_R_END__\\n'
  fi
done
`,
        )
        await fs.chmod(binary, 0o755)
        return { binary, marker }
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const session = await Session.create({})
        const identity: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "r-discovery-boundary",
          language: "r",
        }
        try {
          const result = await KernelRuntime.execute(identity, "1 + 1", undefined, {
            binary: tmp.extra.binary,
            environmentName: "project-r",
          })
          expect(result.ok).toBe(true)
          expect(result.stdout.trim()).toBe("42")
          expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)
          expect(KernelRuntime.status(identity).environment?.interpreter).toMatchObject({
            name: "project-r",
            binary: tmp.extra.binary,
            version: "R version 9.9.0 governed",
          })

          const ledger = await Bun.file(AuthorityProcessLedger.pathForTests()).json()
          expect(
            (ledger as Array<{ kind?: string; project_id?: string; session_id?: string }>).some(
              (entry) =>
                entry.kind === "kernel" && entry.project_id === Instance.project.id && entry.session_id === session.id,
            ),
          ).toBe(true)
        } finally {
          await KernelRuntime.release(identity)
        }
        expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)
      },
    })
  },
  30_000,
)

test.skipIf(process.platform === "win32")(
  "spontaneous built-in launcher exits complete durable ownership without accumulation",
  async () => {
    if (!Bun.which("python3")) return
    await using _sandbox = await containedExecution()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        const session = await Session.create({})
        const identity: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "python-spontaneous-exit",
          language: "python",
        }
        const cleared = async (
          target: { pid: number; token?: string; ownershipID?: string },
          attempt = 0,
        ): Promise<boolean> => {
          const ledger = (await Bun.file(AuthorityProcessLedger.pathForTests())
            .json()
            .catch(() => [])) as Array<{
            id?: string
          }>
          const files = await fs.readdir(path.join(Global.Path.config, "data-root-operations")).catch(() => [])
          const markers = await Promise.all(
            files.map((name) => Bun.file(path.join(Global.Path.config, "data-root-operations", name)).json()),
          )
          const owned = ledger.some((entry) => entry.id === target.ownershipID)
          const marked = markers.some((marker) => marker.pid === target.pid && marker.identity === target.token)
          if (!owned && !marked) return true
          if (attempt >= 500) return false
          await Bun.sleep(10)
          return cleared(target, attempt + 1)
        }

        try {
          const ownership = new Set<string>()
          for (let cycle = 0; cycle < 3; cycle++) {
            const kernel = await KernelRuntime.get(identity)
            const processIdentity = kernel.process
            expect(processIdentity?.ownershipID).toStartWith("kernel-")
            expect(ownership.has(processIdentity!.ownershipID!)).toBe(false)
            ownership.add(processIdentity!.ownershipID!)
            await expect(KernelRuntime.execute(identity, "import os\nos._exit(0)")).rejects.toBeInstanceOf(Error)
            expect(await cleared(processIdentity!)).toBe(true)
          }
          expect(ownership.size).toBe(3)
        } finally {
          await KernelRuntime.release(identity)
        }
      },
    })
  },
  30_000,
)
