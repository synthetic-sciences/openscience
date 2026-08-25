import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import z from "zod"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { ProjectTrust } from "../../project/trust"
import { ExecutionAuthority } from "../../project/execution"
import { ProjectAccess } from "../../project/access"

async function current(projectID: string) {
  const selected = await Project.resolve(projectID)
  if (selected.project.id === Instance.project.id) return
  throw new Project.MismatchError({
    projectID,
    directory: Instance.directory,
  })
}

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenScience.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = await Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenScience is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .get(
      "/:projectID/trust",
      describeRoute({
        summary: "Inspect project trust",
        description:
          "Inspect whether project-local code may execute. New projects are trusted by default; an explicit revocation or canonical-root mismatch blocks project code.",
        operationId: "project.trust.get",
        responses: {
          200: {
            description: "Project trust state and remediation",
            content: {
              "application/json": {
                schema: resolver(ProjectTrust.Status),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        await current(projectID)
        return c.json(await ProjectTrust.status(Instance.project))
      },
    )
    .put(
      "/:projectID/trust",
      describeRoute({
        summary: "Update project trust",
        description:
          "Trust project-local code by submitting the canonical root returned by the status endpoint, or revoke that permission immediately.",
        operationId: "project.trust.update",
        responses: {
          200: {
            description: "Updated project trust state",
            content: {
              "application/json": {
                schema: resolver(ProjectTrust.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator("json", ProjectTrust.Update),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        await current(projectID)
        const status = await ProjectTrust.update(Instance.project, c.req.valid("json"))
        await Instance.dispose()
        return c.json(status)
      },
    )
    .get(
      "/:projectID/access",
      describeRoute({
        summary: "Inspect project action access",
        description:
          "Return the atomic project-scoped Ask, Approve, or Full access mode and its effective sandbox policy.",
        operationId: "project.access.get",
        responses: {
          200: {
            description: "Project action access",
            content: {
              "application/json": {
                schema: resolver(ProjectAccess.Status),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        await current(projectID)
        return c.json(await ProjectAccess.status(Instance.project))
      },
    )
    .put(
      "/:projectID/access",
      describeRoute({
        summary: "Update project action access",
        description:
          "Atomically update this project's action approval and containment mode without changing any other project.",
        operationId: "project.access.update",
        responses: {
          200: {
            description: "Updated project action access",
            content: {
              "application/json": {
                schema: resolver(ProjectAccess.Status),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator("json", ProjectAccess.Update),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        await current(projectID)
        const status = await ProjectAccess.update(Instance.project, c.req.valid("json"))
        await Instance.dispose()
        return c.json(status)
      },
    )
    .get(
      "/:projectID/execution",
      describeRoute({
        summary: "Inspect session execution authority",
        description:
          "Return the trust, filesystem-grant, and sandbox revisions that would govern a session process without starting one.",
        operationId: "project.execution",
        responses: {
          200: {
            description: "Effective process authority",
            content: {
              "application/json": {
                schema: resolver(ExecutionAuthority.Decision),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator(
        "query",
        z.object({
          sessionID: z.string().startsWith("ses_"),
          capability: ExecutionAuthority.Capability,
        }),
      ),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const query = c.req.valid("query")
        await current(projectID)
        return c.json(
          await ExecutionAuthority.decide({
            projectID,
            sessionID: query.sessionID,
            capability: query.capability,
          }),
        )
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: z.string() })),
      validator("json", Project.update.schema.omit({ projectID: true })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const body = c.req.valid("json")
        const project = await Project.update({ ...body, projectID })
        return c.json(project)
      },
    ),
)
