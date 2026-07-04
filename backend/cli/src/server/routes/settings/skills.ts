import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Install } from "../../../skill/install/install"
import { Skill } from "../../../skill/skill"
import { errors } from "../../error"
import { lazy } from "../../../util/lazy"

// Settings → Skills panel backend.
//
// Listing, enable/disable, and local authoring are handled by existing
// endpoints (`GET/PUT/DELETE /skill`, plus the global `permission.skill`
// config for enable/disable). The one capability with no existing HTTP
// surface is installing a third-party skill from a public git URL, which
// runs the full local-first fetch + multi-layer security review pipeline
// (`Skill.Install.add`). This route exposes exactly that.
export const SettingsSkillsRoutes = lazy(() =>
  new Hono().post(
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
        skipClassifier: z.boolean().optional().describe("Bypass the server-side Layer-3 classifier review"),
      }),
    ),
    async (c) => {
      const { url, skipClassifier } = c.req.valid("json")
      const result = await Install.add(url, { confirm: false, skipClassifier })
      await Skill.invalidate()
      return c.json({
        installed: result.installed,
        rejected: result.rejected.map((r) => ({ name: r.name, reason: r.reason })),
        warnings: result.warnings.map((w) => ({ name: w.name, pattern: w.pattern })),
      })
    },
  ),
)
