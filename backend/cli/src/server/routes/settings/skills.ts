import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Install } from "../../../skill/install/install"
import { Skill } from "../../../skill/skill"
import { errors } from "../../error"
import { lazy } from "@synsci/util/lazy"

function rootError(error: unknown) {
  if (!(error instanceof Skill.RootError)) throw error
  const status = error.data.code === "duplicate" ? 409 : error.data.code === "unknown" ? 404 : 400
  return { status, body: { error: error.data.message, code: error.data.code, path: error.data.path } }
}

// Settings → Skills panel backend.
//
// Listing, enable/disable, and local authoring are handled by existing
// endpoints (`GET/PUT/DELETE /skill`, plus the global `permission.skill`
// config for enable/disable). This file adds installing a third-party skill
// from a public git URL (`Skill.Install.add`, the reviewed pipeline) and the
// skill roots: which directories feed the catalog, registering a local
// directory without a restart, and re-scanning after an out-of-band change.
export const SettingsSkillsRoutes = lazy(() => {
  // Built inside the factory: the Skill namespace is part of an import cycle
  // and is not initialized when this module first evaluates.
  const RootsResponse = z
    .object({
      roots: Skill.Root.array(),
      shadowed: Skill.Shadowed.array(),
      revision: z.number().int(),
    })
    .meta({ ref: "SkillRoots" })

  const Persist = z
    .enum(["global", "project"])
    .optional()
    .describe("Write the path to skills.paths in the global or the project config so it survives a restart.")

  return new Hono()
    .get(
      "/paths",
      describeRoute({
        summary: "List skill roots",
        description:
          "Every directory contributing skills, with its kind (bundled, project, user, installed, config, runtime), the skills it won, and the same-named skills it lost to another root. The revision changes whenever the catalog is rebuilt.",
        operationId: "settings.skills.roots",
        responses: {
          200: { description: "Skill roots", content: { "application/json": { schema: resolver(RootsResponse) } } },
        },
      }),
      async (c) => c.json(await Skill.roots()),
    )
    .post(
      "/paths",
      describeRoute({
        summary: "Register a skill directory",
        description:
          "Add a local directory as a skill root for this project. It is scanned recursively at once; no restart is needed. A missing or empty directory is rejected (400), and a root that is already active is rejected (409) instead of loading every skill twice.",
        operationId: "settings.skills.addRoot",
        responses: {
          201: {
            description: "The registered root",
            content: { "application/json": { schema: resolver(Skill.Root) } },
          },
          ...errors(400, 409),
        },
      }),
      validator(
        "json",
        z.object({
          path: z
            .string()
            .trim()
            .min(1)
            .describe("Absolute path, or relative to the project directory; ~ is expanded."),
          persist: Persist,
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const result = await Skill.addRoot(body.path, { persist: body.persist }).catch(rootError)
        if ("status" in result) return c.json(result.body, result.status as 400 | 409)
        return c.json(result, 201)
      },
    )
    .delete(
      "/paths",
      describeRoute({
        summary: "Unregister a skill directory",
        description:
          "Remove a root registered at runtime, and with persist also drop it from skills.paths in that config. Only that root's skills leave the catalog.",
        operationId: "settings.skills.removeRoot",
        responses: {
          200: {
            description: "Roots after the removal",
            content: { "application/json": { schema: resolver(RootsResponse) } },
          },
          ...errors(404),
        },
      }),
      validator("query", z.object({ path: z.string().trim().min(1), persist: Persist })),
      async (c) => {
        const query = c.req.valid("query")
        const failure = await Skill.removeRoot(query.path, { persist: query.persist })
          .then(() => undefined)
          .catch(rootError)
        if (failure) return c.json(failure.body, failure.status as 404 | 400)
        return c.json(await Skill.roots())
      },
    )
    .post(
      "/reload",
      describeRoute({
        summary: "Rescan skill directories",
        description: "Rebuild the catalog so files changed outside the app are picked up without a restart.",
        operationId: "settings.skills.reload",
        responses: {
          200: {
            description: "Catalog size after the rescan",
            content: {
              "application/json": {
                schema: resolver(z.object({ skills: z.number().int(), revision: z.number().int() })),
              },
            },
          },
        },
      }),
      async (c) => {
        await Skill.invalidate()
        const [all, info] = await Promise.all([Skill.all(), Skill.roots()])
        return c.json({ skills: all.length, revision: info.revision })
      },
    )
    .post(
      "/install",
      describeRoute({
        summary: "Install skill from git",
        description:
          "Install skill(s) from a public git repository URL. Runs the local-first fetch and multi-layer security review, writes surviving skills to the installed-skills store, then invalidates the skill cache.",
        operationId: "settings.skills.install",
        responses: {
          200: {
            description: "Install result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    installed: z.array(z.object({ namespace: z.string(), name: z.string(), verdict: z.string() })),
                    rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
                    warnings: z.array(z.object({ name: z.string(), pattern: z.string() })),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          url: z.string().min(1).describe("Public git repository URL containing one or more SKILL.md skills"),
        }),
      ),
      async (c) => {
        const { url } = c.req.valid("json")
        const result = await Install.add(url, { confirm: false })
        await Skill.invalidate()
        return c.json({
          installed: result.installed,
          rejected: result.rejected.map((r) => ({ name: r.name, reason: r.reason })),
          warnings: result.warnings.map((w) => ({ name: w.name, pattern: w.pattern })),
        })
      },
    )
})
