import { expect, test } from "bun:test"
import { spawn } from "bun-pty"
import { terminalArgs, terminalEnv } from "../../src/pty/environment"
import { tmpdir } from "../fixture/fixture"

const shell = process.platform === "darwin" ? "/bin/zsh" : Bun.which("bash")

test.skipIf(!shell || process.platform === "win32")(
  "terminal discovers a command from the user's shell profile",
  async () => {
    await using directory = await tmpdir()
    const script = `${directory.path}/profile-bin/research-command`
    await Bun.write(script, "#!/bin/sh\nprintf 'PROFILE_COMMAND_%s\\n' READY\n")
    await Bun.$`chmod +x ${script}`.quiet()
    const profile = `export PATH="${directory.path}/profile-bin:$PATH"\n`
    await Bun.write(`${directory.path}/.zprofile`, profile)
    await Bun.write(`${directory.path}/.bash_profile`, profile)
    const terminal = spawn(shell!, terminalArgs(shell!), {
      name: "xterm-256color",
      cwd: directory.path,
      env: terminalEnv(
        { HOME: directory.path, ZDOTDIR: directory.path, PATH: "/usr/bin:/bin" },
        "project_fixture",
        "ses_fixture",
        shell!,
      ),
    })
    const output: string[] = []
    terminal.onData((data) => output.push(data))
    const exited = new Promise<void>((resolve) => terminal.onExit(() => resolve()))
    try {
      terminal.write("research-command\rexit\r")
      await exited
      expect(output.join("")).toContain("PROFILE_COMMAND_READY")
    } finally {
      terminal.kill()
    }
  },
)
