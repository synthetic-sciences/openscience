import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { upgradeWebSocket } from "hono/bun"
import z from "zod"
import { Pty } from "@/pty"
import { Storage } from "../../storage/storage"
import { errors } from "../error"
import { lazy } from "@synsci/util/lazy"
import { getCookie, setCookie } from "hono/cookie"
import type { Context } from "hono"
import { TerminalKey } from "@/pty/key"

/** Whether this request carries the person's terminal key (see TerminalKey). */
export async function terminalKey(c: Context) {
  const port = new URL(c.req.url).port
  return TerminalKey.valid(getCookie(c, TerminalKey.cookieName(port)))
}

// The WebSocket event factory is synchronous; the key is checked just before.
const keyed = new WeakMap<Request, boolean>()

export const PtyRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List PTY sessions",
        description: "Get a list of all active pseudo-terminal (PTY) sessions managed by OpenScience.",
        operationId: "pty.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Pty.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Pty.list())
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create PTY session",
        description: "Create a new pseudo-terminal (PTY) session for running shell commands and processes.",
        operationId: "pty.create",
        responses: {
          200: {
            description: "Created session",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Pty.CreateInput),
      async (c) => {
        const info = await Pty.create(c.req.valid("json"), { key: await terminalKey(c) })
        return c.json(info)
      },
    )
    .post(
      "/key",
      describeRoute({
        summary: "Exchange a terminal launch code",
        description:
          "Trade the one-time code a launcher put in the workspace URL for the HttpOnly cookie that lets this browser open the person's own shell.",
        operationId: "pty.key.exchange",
        responses: {
          200: {
            description: "Whether the code was accepted",
            content: { "application/json": { schema: resolver(z.boolean()) } },
          },
        },
      }),
      validator("json", z.object({ code: z.string().min(32).max(128) })),
      async (c) => {
        const key = await TerminalKey.exchange(c.req.valid("json").code)
        if (!key) return c.json(false)
        setCookie(c, TerminalKey.cookieName(new URL(c.req.url).port), key, {
          httpOnly: true,
          sameSite: "Strict",
          path: "/",
          maxAge: TerminalKey.KEY_TTL / 1000,
        })
        return c.json(true)
      },
    )
    .delete(
      "/key",
      describeRoute({
        summary: "Forget terminal keys",
        description:
          "Revoke every browser's terminal key. New terminals stay sandboxed until a launcher opens the workspace again.",
        operationId: "pty.key.forget",
        responses: {
          200: { description: "Keys forgotten", content: { "application/json": { schema: resolver(z.boolean()) } } },
        },
      }),
      async (c) => {
        await TerminalKey.forget()
        return c.json(true)
      },
    )
    .get(
      "/:ptyID",
      describeRoute({
        summary: "Get PTY session",
        description: "Retrieve detailed information about a specific pseudo-terminal (PTY) session.",
        operationId: "pty.get",
        responses: {
          200: {
            description: "Session info",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      async (c) => {
        const info = Pty.get(c.req.valid("param").ptyID)
        if (!info) {
          throw new Storage.NotFoundError({ message: "Session not found" })
        }
        return c.json(info)
      },
    )
    .put(
      "/:ptyID",
      describeRoute({
        summary: "Update PTY session",
        description: "Update properties of an existing pseudo-terminal (PTY) session.",
        operationId: "pty.update",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      validator("json", Pty.UpdateInput),
      async (c) => {
        const info = await Pty.update(c.req.valid("param").ptyID, c.req.valid("json"))
        return c.json(info)
      },
    )
    .delete(
      "/:ptyID",
      describeRoute({
        summary: "Remove PTY session",
        description: "Remove and terminate a specific pseudo-terminal (PTY) session.",
        operationId: "pty.remove",
        responses: {
          200: {
            description: "Session removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      async (c) => {
        await Pty.remove(c.req.valid("param").ptyID)
        return c.json(true)
      },
    )
    .get(
      "/:ptyID/connect",
      describeRoute({
        summary: "Connect to PTY session",
        description: "Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time.",
        operationId: "pty.connect",
        responses: {
          200: {
            description: "Connected session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: z.string() })),
      async (c, next) => {
        keyed.set(c.req.raw, await terminalKey(c))
        await next()
      },
      upgradeWebSocket((c) => {
        const id = c.req.param("ptyID")
        let handler: ReturnType<typeof Pty.connect>
        if (!id || !Pty.get(id)) throw new Error("Session not found")
        const key = keyed.get(c.req.raw) === true
        return {
          onOpen(_event, ws) {
            handler = Pty.connect(id, ws, { key })
          },
          onMessage(event) {
            handler?.onMessage(String(event.data))
          },
          onClose() {
            handler?.onClose()
          },
        }
      }),
    ),
)
