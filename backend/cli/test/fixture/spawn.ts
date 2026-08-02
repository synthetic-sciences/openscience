/**
 * Spawn a child that stays inside the suite's sandbox.
 *
 * `Bun.spawn` inherits the environment the test runner was launched with, not
 * the one preload.ts assembles at import time — so a child booting the CLI
 * resolved XDG paths against the developer's real home and wrote projects,
 * sessions and auth into it. Always hand children the live `process.env`.
 */
export function spawn<
  const In extends Bun.SpawnOptions.Writable = "ignore",
  const Out extends Bun.SpawnOptions.Readable = "pipe",
  const Err extends Bun.SpawnOptions.Readable = "inherit",
>(
  command: string[],
  options: Omit<Bun.SpawnOptions.OptionsObject<In, Out, Err>, "env"> & {
    env?: Record<string, string | undefined>
  } = {},
) {
  return Bun.spawn<In, Out, Err>(command, {
    ...options,
    env: { ...process.env, ...options.env },
  } as Bun.SpawnOptions.OptionsObject<In, Out, Err>)
}
