import { describe, test, expect } from "bun:test"
import type { Message, Part, Todo } from "@synsci/sdk/v2"
import { latestTodos } from "./todos"

const todo = (content: string, status: string) => ({ content, status, priority: "medium", id: content })
const msg = (id: string, role: string) => ({ id, role })
const toolPart = (id: string, tool: string, todos: Todo[], key: "metadata" | "input" = "metadata") => ({
  id,
  type: "tool",
  tool,
  state: { [key]: { todos } },
})

describe("latestTodos", () => {
  test("returns the newest todowrite's list with counts and active item", () => {
    const messages = [msg("m1", "assistant"), msg("m2", "assistant")]
    const parts = {
      m1: [toolPart("p1", "todowrite", [todo("a", "completed"), todo("b", "pending")])],
      m2: [toolPart("p2", "todowrite", [todo("a", "completed"), todo("b", "in_progress"), todo("c", "pending")])],
    }
    const out = latestTodos(messages as unknown as Message[], parts as unknown as Record<string, Part[] | undefined>)!
    expect(out.total).toBe(3)
    expect(out.completed).toBe(1)
    expect(out.active?.content).toBe("b") // in_progress wins
    expect(out.items.map((t) => t.content)).toEqual(["a", "b", "c"])
  })

  test("falls back to state.input.todos when metadata is absent", () => {
    const parts = { m1: [toolPart("p1", "todowrite", [todo("x", "pending")], "input")] }
    const out = latestTodos(
      [msg("m1", "assistant")] as unknown as Message[],
      parts as unknown as Record<string, Part[] | undefined>,
    )!
    expect(out.total).toBe(1)
    expect(out.active?.content).toBe("x")
  })

  test("active is the first incomplete item when nothing is in_progress", () => {
    const parts = {
      m1: [toolPart("p1", "todowrite", [todo("a", "completed"), todo("b", "pending"), todo("c", "pending")])],
    }
    const out = latestTodos(
      [msg("m1", "assistant")] as unknown as Message[],
      parts as unknown as Record<string, Part[] | undefined>,
    )!
    expect(out.active?.content).toBe("b")
  })

  test("returns null when every item is completed or cancelled", () => {
    const parts = { m1: [toolPart("p1", "todowrite", [todo("a", "completed"), todo("b", "cancelled")])] }
    expect(
      latestTodos(
        [msg("m1", "assistant")] as unknown as Message[],
        parts as unknown as Record<string, Part[] | undefined>,
      ),
    ).toBeNull()
  })

  test("returns null when there is no todowrite part or the list is empty", () => {
    expect(
      latestTodos(
        [msg("m1", "assistant")] as unknown as Message[],
        { m1: [toolPart("p1", "bash", [])] } as unknown as Record<string, Part[] | undefined>,
      ),
    ).toBeNull()
    expect(
      latestTodos(
        [msg("m1", "assistant")] as unknown as Message[],
        { m1: [toolPart("p1", "todowrite", [])] } as unknown as Record<string, Part[] | undefined>,
      ),
    ).toBeNull()
    expect(latestTodos([] as unknown as Message[], {} as unknown as Record<string, Part[] | undefined>)).toBeNull()
  })

  test("ignores non-assistant messages and picks the latest across messages", () => {
    const messages = [msg("m1", "assistant"), msg("u1", "user")]
    const parts = {
      m1: [toolPart("p1", "todowrite", [todo("old", "pending")])],
      u1: [toolPart("p9", "todowrite", [todo("new", "pending")])],
    }
    const out = latestTodos(messages as unknown as Message[], parts as unknown as Record<string, Part[] | undefined>)!
    expect(out.items.map((t) => t.content)).toEqual(["old"]) // u1 is a user message, skipped
  })
})
