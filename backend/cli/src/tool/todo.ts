import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    await Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })
    // The list the model sent is already in its context as the call's input;
    // echoing it back doubled every plan update. The confirmation carries the
    // state that changes: the counts and what is in progress.
    const done = params.todos.filter((x) => x.status === "completed").length
    const pending = params.todos.filter((x) => x.status === "pending").length
    const cancelled = params.todos.filter((x) => x.status === "cancelled").length
    const active = params.todos.filter((x) => x.status === "in_progress").map((x) => x.content)
    return {
      title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
      output: [
        `Updated: ${done}/${params.todos.length} done, ${pending} pending${cancelled ? `, ${cancelled} cancelled` : ""}.`,
        ...(active.length ? [`In progress: ${active.join("; ")}`] : []),
      ].join("\n"),
      metadata: {
        todos: params.todos,
      },
    }
  },
})

export const TodoReadTool = Tool.define("todoread", {
  description: "Use this tool to read your todo list",
  parameters: z.object({}),
  async execute(_params, ctx) {
    await ctx.ask({
      permission: "todoread",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const todos = await Todo.get(ctx.sessionID)
    return {
      title: `${todos.filter((x) => x.status !== "completed").length} todos`,
      metadata: {
        todos,
      },
      output: JSON.stringify(todos, null, 2),
    }
  },
})
