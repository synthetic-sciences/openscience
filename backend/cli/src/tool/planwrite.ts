import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./planwrite.txt"
import { Todo } from "../session/todo"

export const PlanWriteTool = Tool.define("planwrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated plan steps"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "planwrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })
    return {
      title: `${params.todos.filter((x) => x.status !== "completed").length} steps`,
      output: JSON.stringify(params.todos, null, 2),
      metadata: {
        todos: params.todos,
      },
    }
  },
})
