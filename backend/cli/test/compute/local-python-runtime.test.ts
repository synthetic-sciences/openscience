import { expect, spyOn, test } from "bun:test"
import * as nativeFS from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { ComputeJobs } from "../../src/compute/jobs"
import { Instance } from "../../src/project/instance"
import { SessionFilesystem } from "../../src/session/filesystem"
import { KernelEnvironmentMutation } from "../../src/science/kernel/environment-mutation"
import { Config } from "../../src/config/config"
import { BashTool } from "../../src/tool/bash"
import { Sandbox } from "../../src/sandbox/sandbox"
import { Shell } from "../../src/shell/shell"
import { executionSession, tmpdir } from "../fixture/fixture"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

test.skipIf(process.platform === "win32")(
  "a local compute job uses the canonical Python and package overlay after login-shell initialization",
  async () => {
    await using tmp = await tmpdir()
    await using ambient = await tmpdir()
    // A real project interpreter path must win over the host PATH, including
    // shells whose login startup resets PATH. No installation is required.
    const binary = Bun.which("python3") ?? Bun.which("python")
    if (!binary) throw new Error("Local runtime fixture needs Python")
    const bin = path.join(tmp.path, ".venv", "bin")
    await fs.mkdir(bin, { recursive: true })
    await fs.symlink(binary, path.join(bin, "python"))
    await fs.symlink(binary, path.join(bin, "python3"))
    const previous = { PYTHONPATH: process.env.PYTHONPATH, MODAL_TOKEN_ID: process.env.MODAL_TOKEN_ID }
    process.env.PYTHONPATH = ambient.path
    process.env.MODAL_TOKEN_ID = "ak-isolated-local-compute-test"
    try {
      await Bun.write(path.join(ambient.path, "unapproved_import.py"), "value = 'unapproved'\n")
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await executionSession()
          const workspace = await SessionFilesystem.workspace(session.id)
          const runtime = await KernelEnvironmentMutation.pythonSubprocessRuntime()
          const name = `approved_${crypto.randomUUID().replaceAll("-", "")}`
          const module = path.join(runtime.env.PYTHONPATH, `${name}.py`)
          await Bun.write(module, "value = 'canonical-package'\n")
          const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
          try {
            const code = `import ${name}, sys, os, importlib.util, json; assert importlib.util.find_spec("unapproved_import") is None; assert os.getenv("MODAL_TOKEN_ID") is None; open("receipt.json", "w").write(json.dumps({"binary": os.path.realpath(sys.executable), "value": ${name}.value}))`
            const job = await ComputeJobs.start(
              {
                name: "Canonical runtime check",
                command: `python3 -c ${quote(code)}`,
                target: { kind: "local" },
                sessionID: session.id,
              },
              options,
            )
            try {
              const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
              expect(result.status).toBe("succeeded")
              expect(result.reproducibility?.execution_environment).toMatchObject({
                target: "local",
                cwd: workspace,
                profile: "python",
                python: { role: "selected_default", executable: runtime.binary },
              })
              expect(await Bun.file(path.join(workspace, "receipt.json")).json()).toEqual({
                binary: await fs.realpath(runtime.binary!),
                value: "canonical-package",
              })
            } finally {
              const current = await ComputeJobs.get(job.id, options)
              if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
            }
          } finally {
            await fs.rm(module, { force: true })
          }
        },
      })
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  },
)

// Use two real installed interpreters. A symlink to the same Python verifies
// path selection but cannot catch a host-version receipt attached to a job
// launched with another interpreter. No interpreter is installed by the test.
function version(binary: string | null) {
  if (!binary) return
  const result = Bun.spawnSync([binary, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) return
  return result.stdout
    .toString()
    .trim()
    .match(/^Python (\d+\.\d+\.\d+\S*)$/)?.[1]
}

const host = Bun.which("python3") ?? Bun.which("python")
const hostVersion = version(host)
const alternate = ["python3.11", "python3.12", "python3.13", "python3.14"]
  .map((name) => Bun.which(name))
  .filter((binary): binary is string => !!binary)
  .map((binary) => ({ binary, version: version(binary) }))
  .find((item) => item.version && hostVersion && item.version !== hostVersion)

test.skipIf(process.platform === "win32" || !alternate)(
  "records the actual selected Python version when it differs from host python3",
  async () => {
    if (!alternate) throw new Error("This fixture requires two different installed Python versions")
    await using tmp = await tmpdir()
    const bin = path.join(tmp.path, ".venv", "bin")
    await fs.mkdir(bin, { recursive: true })
    await fs.symlink(alternate.binary, path.join(bin, "python"))
    // No python3 exists in this selected prefix. Merely prepending its
    // directory would still dispatch the unrelated host python3.
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const workspace = await SessionFilesystem.workspace(session.id)
        const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
        const job = await ComputeJobs.start(
          {
            name: "Selected interpreter identity",
            command: `printf '/fixture startup diagnostic\\n' >&2; python3 -c ${quote('import sys, json; json.dump({"version":sys.version.split()[0],"executable":sys.executable},open("runtime-version.json","w"))')}`,
            target: { kind: "local" },
            sessionID: session.id,
          },
          options,
        )
        try {
          const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
          const log = await ComputeJobs.log(job.id, options)
          expect(result.status, log).toBe("succeeded")
          expect(log).toContain("/fixture startup diagnostic")
          const receipt = Bun.file(path.join(workspace, "runtime-version.json"))
          expect(await receipt.exists(), log).toBe(true)
          const actual = await receipt.json()
          expect(actual.version).toBe(alternate.version)
          expect(actual.version).not.toBe(hostVersion)
          expect(result.reproducibility?.python).toBe(`Python ${actual.version}`)
          expect(result.reproducibility?.capture_scope).toBe("execution_host")
          expect(result.reproducibility?.execution_environment).toEqual({
            target: "local",
            cwd: workspace,
            profile: "python",
            python: { role: "selected_default", executable: path.join(bin, "python"), version: actual.version },
          })
          expect(await fs.realpath(actual.executable)).toBe(await fs.realpath(alternate.binary))
        } finally {
          const current = await ComputeJobs.get(job.id, options)
          if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
        }
      },
    })
  },
)

test.skipIf(process.platform !== "win32")(
  "Windows login shell retains the selected native Python path",
  async () => {
    if (!host) throw new Error("Local runtime fixture needs Python")
    await using tmp = await tmpdir()
    const prefix = path.join(tmp.path, ".venv")
    // No pip or package installation: this creates only a disposable interpreter
    // launcher pointing to the already installed native Python runtime.
    const prepared = Bun.spawnSync([host, "-m", "venv", "--without-pip", prefix])
    expect(prepared.exitCode, prepared.stderr.toString()).toBe(0)
    const previous = await Config.trustedSandbox()
    await Config.setSandbox({ enabled: false })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await executionSession()
          const workspace = await SessionFilesystem.workspace(session.id)
          const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
          const job = await ComputeJobs.start(
            {
              name: "Windows selected interpreter",
              command: [
                "printf '/fixture startup diagnostic\\n' >&2",
                'printf %s "$?" > builtin-before.exit',
                "printf 'builtin before stdout\\n'",
                `python -c ${quote('import sys,json; json.dump({"executable":sys.executable,"version":sys.version.split()[0]},open("runtime-windows.json","w")); print("runtime stdout sentinel",flush=True); print("runtime stderr sentinel",file=sys.stderr,flush=True)')}`,
                "code=$?",
                "printf 'builtin middle stdout\\n'; printf 'builtin middle stderr\\n' >&2",
                `python -c ${quote('import sys; print("second native stdout",flush=True); print("second native stderr",file=sys.stderr,flush=True)')}`,
                "printf 'builtin after stdout\\n'; printf 'builtin after stderr\\n' >&2",
                'exit "$code"',
              ].join("; "),
              target: { kind: "local" },
              sessionID: session.id,
            },
            options,
          )
          try {
            // The first Windows job may compile its native ownership helpers;
            // keep the receipt assertions while allowing that cold startup.
            const result = await ComputeJobs.wait(job.id, { ...options, timeout: 15_000 }).catch(async (error) => {
              throw new Error(`Windows runtime fixture did not settle: ${await ComputeJobs.log(job.id, options)}`, {
                cause: error,
              })
            })
            const log = await ComputeJobs.log(job.id, options)
            expect(result.status, log).toBe("succeeded")
            const receipt = Bun.file(path.join(workspace, "runtime-windows.json"))
            expect(
              await receipt.exists(),
              JSON.stringify({
                shell: Shell.posix(),
                terminalShell: Shell.acceptable(),
                git: Bun.which("git"),
                job: result.status,
                log,
              }),
            ).toBe(true)
            const actual = await receipt.json()
            expect(await Bun.file(path.join(workspace, "builtin-before.exit")).text()).toBe("0")
            expect(await fs.realpath(actual.executable)).toBe(
              await fs.realpath(path.join(prefix, "Scripts", "python.exe")),
            )
            expect(result.reproducibility?.execution_environment?.python).toEqual({
              role: "selected_default",
              executable: path.join(prefix, "Scripts", "python.exe"),
              version: actual.version,
            })
            const logFile = path.join(options.root, "jobs", `${job.id}.log`)
            const diagnostic = JSON.stringify({
              shell: Shell.posix(),
              logFile,
              bytes: await fs.stat(logFile).then((stat) => stat.size),
              direct: await fs.readFile(logFile, "utf8"),
              events: await ComputeJobs.events(job.id, options),
            })
            expect(log, diagnostic).toContain("/fixture startup diagnostic")
            expect(log, diagnostic).toContain("runtime stdout sentinel")
            expect(log, diagnostic).toContain("runtime stderr sentinel")
            for (const marker of [
              "builtin before stdout",
              "builtin middle stdout",
              "builtin middle stderr",
              "second native stdout",
              "second native stderr",
              "builtin after stdout",
              "builtin after stderr",
            ]) {
              expect(log, diagnostic).toContain(marker)
            }
          } finally {
            const current = await ComputeJobs.get(job.id, options)
            if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
          }
        },
      })
    } finally {
      await Config.setSandbox(previous)
    }
  },
  30_000,
)

for (const mode of ["cancel", "background", "write-error"] as const) {
  test.skipIf(process.platform !== "win32")(`Windows compute output closes after ${mode}`, async () => {
    if (!host) throw new Error("Local runtime fixture needs Python")
    await using tmp = await tmpdir()
    const previous = await Config.trustedSandbox()
    await Config.setSandbox({ enabled: false })
    const active = ComputeJobs.activeCount()
    const create = nativeFS.createWriteStream
    const writeError =
      mode === "write-error"
        ? spyOn(nativeFS, "createWriteStream").mockImplementation((file, options) => {
            if (typeof file !== "string" || !file.startsWith(tmp.path) || !file.endsWith(".log")) {
              return create(file, options)
            }
            // A real read-only descriptor forces the parent append writer's
            // asynchronous I/O error. The stream is its sole owner and closes
            // it; the child's output pipe is still valid.
            nativeFS.writeFileSync(file, "", { mode: 0o600 })
            return create(file, {
              ...(typeof options === "object" ? options : {}),
              fd: nativeFS.openSync(file, "r"),
            })
          })
        : undefined
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await executionSession()
          const workspace = await SessionFilesystem.workspace(session.id)
          const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
          const code =
            mode === "background"
              ? 'import sys,subprocess; subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)"]); print("primary finished",flush=True)'
              : 'import sys,time; print("native ready stdout",flush=True); print("native ready stderr",file=sys.stderr,flush=True); time.sleep(30)'
          const job = await ComputeJobs.start(
            {
              name: `Windows output ${mode}`,
              command: `python -c ${quote(code)}`,
              target: { kind: "local" },
              sessionID: session.id,
            },
            options,
          )
          try {
            if (mode === "cancel") {
              for (let attempt = 0; attempt < 250; attempt++) {
                if ((await ComputeJobs.log(job.id, options)).includes("native ready stderr")) break
                await Bun.sleep(20)
              }
              expect(await ComputeJobs.log(job.id, options)).toContain("native ready stderr")
              await ComputeJobs.cancel(job.id, options)
            }
            const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
            expect(result.status, JSON.stringify(result)).toBe(
              mode === "cancel" ? "cancelled" : mode === "write-error" ? "failed" : "succeeded",
            )
            expect(result.lifecycle?.resource, JSON.stringify(result)).toBe("closed")
            if (mode === "write-error") {
              expect(result.error).toContain("Could not capture compute job log")
            } else {
              const log = await ComputeJobs.log(job.id, options)
              expect(log).toContain(mode === "background" ? "primary finished" : "native ready stdout")
              if (mode === "cancel") expect(log).toContain("native ready stderr")
            }
          } finally {
            const current = await ComputeJobs.get(job.id, options)
            if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
            for (let attempt = 0; attempt < 250 && ComputeJobs.activeCount() > active; attempt++) {
              await Bun.sleep(20)
            }
            expect(ComputeJobs.activeCount()).toBe(active)
          }
        },
      })
    } finally {
      writeError?.mockRestore()
      await Config.setSandbox(previous)
    }
  })
}

for (const enabled of [false, true]) {
  test.skipIf(process.platform === "win32" || (enabled && !Sandbox.available()))(
    `Bash and compute preserve a real venv prefix (${enabled ? "sandboxed" : "unsandboxed"})`,
    async () => {
      if (!host) throw new Error("Local runtime fixture needs Python")
      await using tmp = await tmpdir()
      const prefix = path.join(tmp.path, ".venv")
      const prepared = Bun.spawnSync([host, "-m", "venv", "--without-pip", prefix])
      expect(prepared.exitCode, prepared.stderr.toString()).toBe(0)
      // Linux venvs can make python a relative symlink to python3. Preserve
      // that selected entrypoint before removing only the optional alias.
      const selected = path.join(prefix, "bin", "python")
      const target = await fs.realpath(selected)
      await fs.rm(selected)
      await fs.symlink(target, selected)
      await fs.rm(path.join(prefix, "bin", "python3"), { force: true })
      const direct = Bun.spawnSync([selected, "-c", "import sys; print(sys.prefix)"])
      expect(direct.exitCode, direct.stderr.toString()).toBe(0)
      expect(direct.stdout.toString().trim()).toBe(prefix)
      const previous = await Config.trustedSandbox()
      await Config.setSandbox({ enabled, onUnavailable: "error" })
      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const session = await executionSession()
            const workspace = await SessionFilesystem.workspace(session.id)
            const options = { root: path.join(tmp.path, ".jobs"), projectDirectory: tmp.path, workspace }
            const command = (file: string) =>
              `printf '/fixture startup diagnostic\\n' >&2; python3 -c ${quote(`import sys,json; json.dump({"prefix":sys.prefix,"executable":sys.executable},open(${JSON.stringify(file)},"w"))`)}`
            const shell = await (
              await BashTool.init()
            ).execute(
              { command: command("bash-venv.json"), description: "Check selected venv" },
              {
                sessionID: session.id,
                messageID: "msg_venv",
                callID: "call_venv",
                agent: "research",
                abort: AbortSignal.any([]),
                messages: [],
                metadata() {},
                async ask() {},
              },
            )
            expect(shell.metadata.exit, shell.output).toBe(0)
            expect(shell.output).toContain("/fixture startup diagnostic")
            const shellReceipt = Bun.file(path.join(workspace, "bash-venv.json"))
            expect(await shellReceipt.exists(), shell.output).toBe(true)
            expect(await shellReceipt.json(), shell.output).toEqual({ prefix, executable: selected })
            const job = await ComputeJobs.start(
              {
                name: "Selected venv prefix",
                command: command("compute-venv.json"),
                target: { kind: "local" },
                sessionID: session.id,
              },
              options,
            )
            try {
              const result = await ComputeJobs.wait(job.id, { ...options, timeout: 5_000 })
              const log = await ComputeJobs.log(job.id, options)
              expect(result.status, log).toBe("succeeded")
              expect(log).toContain("/fixture startup diagnostic")
              const receipt = Bun.file(path.join(workspace, "compute-venv.json"))
              expect(await receipt.exists(), log).toBe(true)
              expect(await receipt.json(), log).toEqual({ prefix, executable: selected })
              expect(result.reproducibility?.execution_environment?.python?.executable).toBe(
                path.join(prefix, "bin", "python"),
              )
            } finally {
              const current = await ComputeJobs.get(job.id, options)
              if (current && ["pending", "running"].includes(current.status)) await ComputeJobs.cancel(job.id, options)
            }
          },
        })
      } finally {
        await Config.setSandbox(previous)
      }
    },
  )
}
