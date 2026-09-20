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
            description:
              "This copy of OpenScience may not own the command-line tool; the reason is the one the status reports",
            content: { "application/json": { schema: resolver(Failure) } },
          },
          500: {
            description: "The system refused a write; the message says what could not be done",
            content: { "application/json": { schema: resolver(Failure) } },
          },
        },
      }),
      async (c) => {
        const outcome = await CliShim.install(options).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        if (!("error" in outcome)) return c.json(outcome.value)
        // The module's own refusal is the person's to resolve (a foreign
        // install in the slot, a copy that is not a lasting bundle); a write
        // the system refused is a failure of ours to report as one.
        if (outcome.error instanceof CliShim.RefusedError) {
          return c.json(Failure.parse({ error: outcome.error.message }), 409)
        }
        const reason = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        return c.json(Failure.parse({ error: reason }), 500)
      },
    )
}

export const CliSettingsRoutes = lazy(() => cliSettingsApp())
