import { externalRunnerEnvironment, forwardedPlaywrightArgs, playwrightCommand } from "./e2e-mode"

const rawArgs = process.argv.slice(2)
const packaged = rawArgs[0] === "--packaged"
const extraArgs = forwardedPlaywrightArgs(packaged ? rawArgs.slice(1) : rawArgs)

let env: Record<string, string>
try {
  env = externalRunnerEnvironment(process.env, packaged)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

const runner = Bun.spawn(playwrightCommand(extraArgs), {
  cwd: process.cwd(),
  env,
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await runner.exited)
