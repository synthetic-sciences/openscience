import type { ArgumentsCamelCase, CommandModule } from "yargs"
import { DataRootBarrier } from "../../global/data-root-barrier"

type WithDoubleDash<T> = T & { "--"?: string[] }

let dataRootOperation: DataRootBarrier.Operation | undefined

// Only these commands intentionally keep serving after parse returns. Every
// other parsed command (including aliases and shell completion) gets one
// physical data-root marker for its complete middleware/handler lifetime.
// A negative list avoids silently dropping protection when a command adds an
// alias or a new short-lived top-level entry.
const longLivedCommands = new Set(["web", "serve"])

export async function runDataRootMiddleware<T>(
  command: string | undefined,
  filepath: string,
  action: () => T | Promise<T>,
  timeoutMs = 120_000,
): Promise<T> {
  if (!command || longLivedCommands.has(command)) return await action()
  let operation = dataRootOperation
  if (!operation) {
    operation = await DataRootBarrier.enter(filepath, timeoutMs)
    dataRootOperation = operation
  }
  return await operation.during(async () => await action())
}

export async function runInDataRootScope<T>(action: () => T | Promise<T>): Promise<T> {
  const operation = dataRootOperation
  if (!operation) return await action()
  return await operation.during(async () => await action())
}

export async function disposeDataRootOperation() {
  const operation = dataRootOperation
  dataRootOperation = undefined
  await operation?.[Symbol.asyncDispose]()
}

export function cmd<T, U>(input: CommandModule<T, WithDoubleDash<U>>) {
  const handler = input.handler
  if (!handler) return input
  return {
    ...input,
    handler: (args: ArgumentsCamelCase<WithDoubleDash<U>>) => runInDataRootScope(() => handler(args)),
  } satisfies CommandModule<T, WithDoubleDash<U>>
}
