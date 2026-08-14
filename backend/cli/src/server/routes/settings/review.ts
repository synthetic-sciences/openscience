import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { ReviewSettings } from "@/settings/review"
import { lazy } from "../../../util/lazy"

export const ReviewSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get reviewer preferences",
        operationId: "settings.review.get",
        responses: {
          200: {
            description: "Reviewer preferences",
            content: { "application/json": { schema: resolver(ReviewSettings.State) } },
          },
        },
      }),
      async (c) => c.json(await ReviewSettings.get()),
    )
    .put(
      "/",
      describeRoute({
        summary: "Update reviewer preferences",
        operationId: "settings.review.set",
        responses: {
          200: {
            description: "Updated preferences",
            content: { "application/json": { schema: resolver(ReviewSettings.State) } },
          },
        },
      }),
      validator("json", ReviewSettings.State),
      async (c) => c.json(await ReviewSettings.set(c.req.valid("json"))),
    ),
)
