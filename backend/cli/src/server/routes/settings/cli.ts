import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { CliShim } from "../../../installation/cli-shim"

const Failure = z.object({ error: z.string() })

/**
 * The desktop app's command-line tool: the link in `~/.openscience/bin` and
 * the PATH line beside it. `options` let a test point the routes at a
 * temporary home and a fixture bundle; the server mounts the defaults.
 */
export function cliSettingsApp(options: CliShim.Options = {}) {
  return new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Command-line tool status",
        description:
          "Whether ~/.openscience/bin/openscience exists, what it points at, and whether the directory is on PATH.",
        operationId: "settings.cli.status",
        responses: {
          200: {
            description: "Command-line tool status",
            content: { "application/json": { schema: resolver(CliShim.Status) } },
          },
        },
      }),
      async (c) => c.json(await CliShim.status(options)),
    )
    .post(
      "/install",
      describeRoute({
        summary: "Install or repair the command-line tool",
        description:
          "Link ~/.openscience/bin/openscience to the desktop app's own copy and add the directory to the shell PATH the way the standalone installer does.",
        operationId: "settings.cli.install",
        responses: {
          200: {
            description: "Command-line tool status after the install",
            content: { "application/json": { schema: resolver(CliShim.Status) } },
          },
          409: {
            description: "This copy of OpenScience cannot own the command-line tool",
            content: { "application/json": { schema: resolver(Failure) } },
          },
        },
      }),
      async (c) => {
        const outcome = await CliShim.install(options).then(
          (value) => ({ value }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        )
        if ("error" in outcome) return c.json(Failure.parse({ error: outcome.error }), 409)
        return c.json(outcome.value)
      },
    )
}

export const CliSettingsRoutes = lazy(() => cliSettingsApp())
