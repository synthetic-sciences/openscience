import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Install } from "../../../skill/install/install"
import { Skill } from "../../../skill/skill"
import { errors } from "../../error"
import { lazy } from "@synsci/util/lazy"

// Settings → Skills panel backend.
//
// Listing, enable/disable, and local authoring are handled by existing
// endpoints (`GET/PUT/DELETE /skill`, plus the global `permission.skill`
// config for enable/disable). The one capability with no existing HTTP
// surface is installing a third-party skill from a public git URL, which
// runs the full local-first fetch + multi-layer security review pipeline
// (`Skill.Install.add`). This route exposes exactly that.
export const SettingsSkillsRoutes = lazy(() =>
  new Hono()
    // ---- custom skill roots -------------------------------------------
    .get(
      "/paths",
      describeRoute({
        summary: "List skill roots",
        description:
          "Every directory currently contributing skills, with its origin (builtin / user / custom) and skill count. `custom` covers roots declared in `skills.paths` and roots registered at runtime.",
        operationId: "settings.skills.paths.list",
        responses: { 200: { description: "Skill roots", content: { "application/json": { schema: resolver(z.object({ paths: z.array(z.any()) })) } } } },
      }),
      async (c) => c.json({ paths: await Skill.roots() }),
    )
    .post(
      "/paths",
      describeRoute({
        summary: "Register a skill directory",
        description:
          "Add a local directory as a skill root. The directory is scanned immediately; no restart is needed. With persist=true the path is also written to skills.paths so it survives a restart. A missing directory is rejected with 400.",
        operationId: "settings.skills.paths.add",
        responses: { 201: { description: "Registered" }, ...errors(400) },
      }),
      validator(
        "json",
        z.object({
          path: z.string().min(1).describe("Directory containing one or more <name>/SKILL.md skills"),
          persist: z.boolean().optional().describe("Also write the path to skills.paths"),
        }),
      ),
      async (c) => {
        const { path, persist } = c.req.valid("json")
        try {
          return c.json(await Skill.addPath(path, persist ?? false), 201)
        } catch (e) {
          if (e instanceof Skill.InvalidRootError) return c.json({ error: e.data }, 400)
          throw e
        }
      },
    )
    .delete(
      "/paths",
      describeRoute({
        summary: "Unregister a skill directory",
        description: "Remove a runtime-registered skill root, and with persist=true also drop it from skills.paths.",
        operationId: "settings.skills.paths.remove",
        responses: { 200: { description: "Removed" } },
      }),
      validator("query", z.object({ path: z.string().min(1), persist: z.coerce.boolean().optional() })),
      async (c) => {
        const { path, persist } = c.req.valid("query")
        await Skill.removePath(path, persist ?? false)
        return c.json({ ok: true })
      },
    )
    .post(
      "/reload",
      describeRoute({
        summary: "Rescan skill directories",
        description: "Invalidate the skill cache so directories changed out-of-band are picked up without a restart.",
        operationId: "settings.skills.reload",
        responses: { 200: { description: "Rescanned", content: { "application/json": { schema: resolver(z.object({ skills: z.number() })) } } } },
      }),
      async (c) => {
        await Skill.invalidate()
        return c.json({ skills: (await Skill.all()).length })
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
  ),
)
