import { expect, spyOn, test } from "bun:test"
import { createServer, request, type IncomingMessage } from "node:http"
import path from "node:path"
import { Readable } from "node:stream"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Network } from "../../src/settings/network"
import { GenerateImageTool } from "../../src/tool/generate-image"
import { executionSession, tmpdir } from "../fixture/fixture"

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
)

test.each([
  ["HTTP errors cancel the response", 404, "text/plain", false, "The generated image could not be downloaded (404)."],
  [
    "unsupported formats cancel the response",
    200,
    "text/plain",
    false,
    "The generated image URL returned an unsupported format (text/plain).",
  ],
  ["successful image downloads preserve their bytes", 200, "image/png", false, undefined],
  [
    "HTTP errors survive cancellation failures",
    404,
    "text/plain",
    true,
    "The generated image could not be downloaded (404).",
  ],
  [
    "format errors survive cancellation failures",
    200,
    "text/plain",
    true,
    "The generated image URL returned an unsupported format (text/plain).",
  ],
] as const)("%s", async (_name, status, mime, rejects, error) => {
  const state = { incoming: undefined as IncomingMessage | undefined, calls: 0, cancellations: 0 }
  const controller = new AbortController()
  const source = createServer((_request, response) => {
    response.writeHead(status, { "content-type": mime })
    if (!error) {
      response.end(pixel)
      return
    }
    response.write("pending")
    const timer = setInterval(() => response.write("more"), 20)
    response.once("close", () => {
      clearInterval(timer)
    })
  })
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve))
  const address = source.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture port")
  const gateway = Bun.serve({
    port: 0,
    fetch() {
      state.calls++
      return Response.json({
        choices: [
          { message: { content: [{ type: "text", text: '{"imageUrl":"https://images.example/fixture.png"}' }] } },
        ],
      })
    },
  })
  const fetch = Network.fetch
  // Keep the actual policy and HTTP-stream bridge; only DNS and the socket destination are fixtures.
  const network = spyOn(Network, "fetch").mockImplementation((raw, init, policy) =>
    fetch(raw, init, {
      ...policy,
      resolveAddresses: async () => ["93.184.216.34"],
      transport: async (_target, options) =>
        new Promise<Response>((resolve, reject) => {
          const pending = request(
            `http://127.0.0.1:${address.port}/image`,
            { signal: options.signal ?? undefined },
            (incoming) => {
              state.incoming = incoming
              const response = new Response(Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>, {
                status: incoming.statusCode,
                headers: { "content-type": mime },
              })
              if (rejects) {
                spyOn(response.body!, "cancel").mockImplementation(async () => {
                  state.cancellations++
                  throw new Error("Fixture cancellation failed")
                })
              }
              resolve(response)
            },
          )
          pending.once("error", reject)
          pending.end()
        }),
    }),
  )
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        provider: {
          openai: { options: { apiKey: "sk-local-image-fixture", baseURL: `${gateway.url.origin}/v1` } },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => Provider.invalidate(),
      fn: async () => {
        const session = await executionSession()
        const tool = await GenerateImageTool.init()
        const pending = tool.execute(
          { prompt: "A local fixture", output_path: "fixture.png" },
          {
            sessionID: session.id,
            messageID: "msg_download_fixture",
            callID: "call_download_fixture",
            agent: "research",
            abort: controller.signal,
            messages: [],
            metadata() {},
            async ask() {},
          },
        )
        if (error) await expect(pending).rejects.toThrow(error)
        if (!error) await pending
        expect(state.calls).toBe(1)
        expect(state.incoming).toBeDefined()
        const output = Bun.file(path.join(await SessionFilesystem.workspace(session.id), "fixture.png"))
        if (error && !rejects) expect(state.incoming?.destroyed).toBe(true)
        if (rejects) expect(state.cancellations).toBe(1)
        if (error) expect(await output.exists()).toBe(false)
        if (!error) expect(Buffer.from(await output.arrayBuffer())).toEqual(pixel)
      },
    })
  } finally {
    controller.abort()
    network.mockRestore()
    gateway.stop(true)
    source.closeAllConnections()
    await new Promise<void>((resolve) => source.close(() => resolve()))
  }
})
