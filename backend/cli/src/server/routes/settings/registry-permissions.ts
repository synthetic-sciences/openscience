import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../../global"
import { errors } from "../../error"
import { lazy } from "../../../util/lazy"

// ── Registry write-permission store ─────────────────────────────────────────
//
// The Permissions panel governs whether the agent may perform registry-write
// actions (create/update an agent, publish/edit/attach/detach a skill,
// attach/detach a connector) and at what scope. Each action is granted at
// "global" scope (persists across every session) or "session" scope (this
// session only), or "revoked" (blocked). Persisted to a real JSON store under
// ~/.openscience/ so the grant survives restarts and is readable by the agent loop.

export namespace RegistryPermissions {
  const filepath = path.join(Global.Path.config, "settings-registry-permissions.json")

  export const Scope = z.enum(["global", "session", "revoked"])
  export type Scope = z.infer<typeof Scope>

  export const Info = z.object({
    grants: z.record(z.string(), Scope).default({}),
  })
  export type Info = z.infer<typeof Info>

  async function read(): Promise<Info> {
    const parsed = await Bun.file(filepath)
      .json()
      .catch(() => null)
    if (!parsed) return { grants: {} }
    return Info.parse(parsed)
  }

  async function write(next: Info) {
    await fs.mkdir(Global.Path.config, { recursive: true })
    await Bun.write(filepath, JSON.stringify(next, null, 2))
  }

  export async function get(): Promise<Info> {
    return read()
  }

  export async function set(action: string, scope: Scope): Promise<Info> {
    const info = await read()
    info.grants[action] = scope
    await write(info)
    return info
  }

  export async function revokeAll(actions: string[]): Promise<Info> {
    const info = await read()
    for (const action of actions) info.grants[action] = "revoked"
    await write(info)
    return info
  }
}

export const RegistryPermissionsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get registry write permissions",
        operationId: "settings.permissions.get",
        responses: {
          200: {
            description: "Registry write permissions",
            content: { "application/json": { schema: resolver(RegistryPermissions.Info) } },
          },
        },
      }),
      async (c) => c.json(await RegistryPermissions.get()),
    )
    .put(
      "/:action",
      describeRoute({
        summary: "Set a registry write permission scope",
        operationId: "settings.permissions.set",
        responses: {
          200: {
            description: "Updated",
            content: { "application/json": { schema: resolver(RegistryPermissions.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ action: z.string() })),
      validator("json", z.object({ scope: RegistryPermissions.Scope })),
      async (c) => c.json(await RegistryPermissions.set(c.req.valid("param").action, c.req.valid("json").scope)),
    )
    .post(
      "/revoke-all",
      describeRoute({
        summary: "Revoke all registry write permissions",
        operationId: "settings.permissions.revokeAll",
        responses: {
          200: {
            description: "Updated",
            content: { "application/json": { schema: resolver(RegistryPermissions.Info) } },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ actions: z.string().array() })),
      async (c) => c.json(await RegistryPermissions.revokeAll(c.req.valid("json").actions)),
    ),
)
