import { expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { SubagentInput } from "../../src/session/subagent-input"

test("prompt admission counts actual tool schemas and excludes executable tool objects", async () => {
  const small = await SubagentInput.prompt({ system: [], messages: [], tools: {} })
  const large = await SubagentInput.prompt({
    system: [],
    messages: [],
    tools: {
      probe: tool({
        description: "Read a figure",
        inputSchema: jsonSchema({
          type: "object",
          properties: {
            note: { type: "string", description: "Scientific instructions. ".repeat(1000) },
          },
        }),
        execute: async () => "output that is not input".repeat(100000),
      }),
    },
  })
  expect(large - small).toBeGreaterThan(7000)
  expect(large - small).toBeLessThan(9000)
})

test("SDK image buffers fit the same prompt allowance as inline image URLs", async () => {
  const buffered = await SubagentInput.prompt({
    system: ["Describe this plot"],
    tools: {},
    messages: [
      { role: "user", content: [{ type: "image", image: new Uint8Array(1024 * 1024), mediaType: "image/png" }] },
    ],
  })
  const inline = await SubagentInput.prompt({
    system: ["Describe this plot"],
    tools: {},
    messages: [
      {
        role: "user",
        content: [{ type: "image", image: `data:image/png;base64,${"A".repeat(1400000)}`, mediaType: "image/png" }],
      },
    ],
  })
  expect(buffered).toBe(inline)
  expect(buffered).toBeGreaterThan(2000)
  expect(buffered).toBeLessThan(12000)
})

test("multilingual text keeps a larger reserve than equivalent ASCII character counts", () => {
  const ascii = SubagentInput.estimate({ messages: [{ role: "user", content: "a".repeat(10000) }] })
  const cjk = SubagentInput.estimate({ messages: [{ role: "user", content: "界".repeat(10000) }] })
  expect(cjk).toBeGreaterThan(12000)
  expect(cjk).toBeGreaterThan(ascii * 3)
})

test("image-shaped tool arguments and schema defaults remain ordinary model text", () => {
  const image = { type: "image", data: "A".repeat(100000) }
  const call = SubagentInput.estimate({
    messages: [{ role: "assistant", content: [{ type: "tool-call", toolName: "probe", input: image }] }],
  })
  const schema = SubagentInput.estimate({ tools: [{ name: "probe", parameters: { default: image } }] })
  expect(call).toBeGreaterThan(30000)
  expect(schema).toBeGreaterThan(30000)
})

test("JSON tool results remain text while real media tool results retain image estimates", async () => {
  const image = { type: "image", data: "A".repeat(100000) }
  const sdk = SubagentInput.estimate({
    messages: [{ role: "tool", content: [{ type: "tool-result", output: { type: "json", value: image } }] }],
  })
  const google = SubagentInput.estimate({
    contents: [{ parts: [{ functionResponse: { name: "probe", response: { content: image } } }] }],
  })
  const bedrock = SubagentInput.estimate({ messages: [{ content: [{ toolResult: { content: [{ json: image }] } }] }] })
  const media = SubagentInput.estimate({
    messages: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            output: {
              type: "content",
              value: [{ type: "image-data", data: "A".repeat(100000), mediaType: "image/png" }],
            },
          },
        ],
      },
    ],
  })
  expect(sdk).toBeGreaterThan(30000)
  expect(google).toBeGreaterThan(30000)
  expect(bedrock).toBeGreaterThan(30000)
  expect(media).toBeLessThan(12000)
})
