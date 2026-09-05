import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { PermissionNext } from "@/permission/next"
import { errors } from "../error"
import { lazy } from "@synsci/util/lazy"

export const PermissionRoutes = lazy(() =>
  new Hono()
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Respond to permission request",
        description: "Approve or deny a permission request from the AI assistant.",
        operationId: "permission.reply",
        responses: {
          200: {
            description: "Permission processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: z.string(),
        }),
      ),
      validator("json", z.object({ reply: PermissionNext.Reply, message: z.string().optional() })),
      async (c) => {
        const params = c.req.valid("param")
        const json = c.req.valid("json")
        await PermissionNext.reply({
          requestID: params.requestID,
          reply: json.reply,
          message: json.message,
        })
        return c.json(true)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List pending permissions",
        description: "Get all pending permission requests across all sessions.",
        operationId: "permission.list",
        responses: {
          200: {
            description: "List of pending permissions",
            content: {
              "application/json": {
                schema: resolver(PermissionNext.Request.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const permissions = await PermissionNext.list()
        return c.json(permissions)
      },
    )
    .get(
      "/standing",
      describeRoute({
        summary: "List standing approvals",
        description: "Standing permission approvals for this project plus the machine-wide ones.",
        operationId: "permission.standing.list",
        responses: {
          200: {
            description: "Standing approvals",
            content: {
              "application/json": {
                schema: resolver(PermissionNext.Standing.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await PermissionNext.standing())
      },
    )
    .delete(
      "/standing/:id",
      describeRoute({
        summary: "Revoke standing approval",
        description: "Remove one standing approval so the action prompts again.",
        operationId: "permission.standing.revoke",
        responses: {
          200: {
            description: "Whether an approval was removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        return c.json(await PermissionNext.revoke({ id: c.req.valid("param").id }))
      },
    ),
)
