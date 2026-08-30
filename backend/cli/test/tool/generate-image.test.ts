import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { SessionFilesystem } from "../../src/session/filesystem"
import {
  GenerateImageTool,
  extractGeneratedImage,
  extractGeneratedImageURL,
  generatedImageAttachments,
  readBoundedImageResponse,
} from "../../src/tool/generate-image"
import type { Tool } from "../../src/tool/tool"
import { executionSession, tmpdir } from "../fixture/fixture"

describe("generate_image response parsing", () => {
  test("executes the native BYOK image route and writes its result into the session workspace", async () => {
    const requests: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = []
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          url: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: (await request.json()) as Record<string, unknown>,
        })
        return Response.json({ data: [{ b64_json: image.toString("base64"), media_type: "image/png" }] })
      },
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          provider: {
            openrouter: {
              options: {
                apiKey: "sk-local-image-route",
                baseURL: `http://127.0.0.1:${server.port}/v1`,
              },
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => Provider.invalidate(),
        fn: async () => {
          const session = await executionSession()
          const workspace = await SessionFilesystem.workspace(session.id)
          const asks: Parameters<Tool.Context["ask"]>[0][] = []
          const tool = await GenerateImageTool.init()
          const input = tool.parameters.parse({
            prompt: "A precise monochrome benchmark schematic",
            output_path: "figures/benchmark.png",
            input_path: "/dev/null",
            model: "meta-llama/llama-3.3-70b-instruct",
            aspect_ratio: "16:9",
          })
          expect(input).not.toHaveProperty("model")
          const result = await tool.execute(input, {
            sessionID: session.id,
            messageID: "msg_generate_image",
            callID: "call_generate_image",
            agent: "research",
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            async ask(input) {
              asks.push(input)
            },
          })

          expect(requests).toHaveLength(1)
          expect(requests[0]).toMatchObject({
            url: "/v1/images",
            authorization: "Bearer sk-local-image-route",
            body: {
              model: "google/gemini-3-pro-image",
              prompt: "A precise monochrome benchmark schematic",
              n: 1,
              output_format: "png",
              aspect_ratio: "16:9",
            },
          })
          expect(asks.map((request) => request.permission)).toEqual(["generate_image", "edit"])
          expect(await Bun.file(path.join(workspace, "figures", "benchmark.png")).arrayBuffer()).toEqual(
            image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
          )
          expect(result).toMatchObject({
            title: "figures/benchmark.png",
            metadata: { route: "openrouter", mime: "image/png", size: image.byteLength, attachment: "inline" },
          })
          expect(result.attachments).toHaveLength(1)

          const directoryPlaceholder = await tool.execute(
            {
              prompt: "A second precise monochrome benchmark schematic",
              output_path: "figures/benchmark-directory-placeholder.png",
              input_path: ".",
            },
            {
              sessionID: session.id,
              messageID: "msg_generate_image_directory_placeholder",
              callID: "call_generate_image_directory_placeholder",
              agent: "research",
              abort: new AbortController().signal,
              messages: [],
              metadata() {},
              async ask(input) {
                asks.push(input)
              },
            },
          )
          expect(requests).toHaveLength(2)
          expect(requests[1]?.body).not.toHaveProperty("input_references")
          expect(directoryPlaceholder.metadata).toMatchObject({ mime: "image/png", route: "openrouter" })

          await Bun.write(path.join(workspace, "input.png"), image)
          await tool.execute(
            {
              prompt: "Preserve the source and improve its contrast",
              output_path: "figures/benchmark-edited.png",
              input_path: "input.png",
            },
            {
              sessionID: session.id,
              messageID: "msg_generate_image_edit",
              callID: "call_generate_image_edit",
              agent: "research",
              abort: new AbortController().signal,
              messages: [],
              metadata() {},
              async ask(input) {
                asks.push(input)
              },
            },
          )
          expect(requests).toHaveLength(3)
          expect(requests[2]?.body).toMatchObject({
            input_references: [
              { type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } },
            ],
          })
        },
      })
    } finally {
      server.stop(true)
    }
  })

  test("prefers a connected Gemini key and pins the stable image-only model", async () => {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    )
    const requests: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          url: new URL(request.url).pathname,
          key: request.headers.get("x-goog-api-key"),
          body: (await request.json()) as Record<string, unknown>,
        })
        return Response.json({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: "image/png", data: image.toString("base64") } }] } },
          ],
        })
      },
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          provider: {
            google: {
              options: {
                apiKey: "gemini-local-image-route",
                baseURL: `http://127.0.0.1:${server.port}/v1beta`,
              },
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => Provider.invalidate(),
        fn: async () => {
          const session = await executionSession()
          const tool = await GenerateImageTool.init()
          const result = await tool.execute(
            { prompt: "A precise benchmark diagram", output_path: "gemini.png" },
            {
              sessionID: session.id,
              messageID: "msg_gemini_image",
              callID: "call_gemini_image",
              agent: "research",
              abort: new AbortController().signal,
              messages: [],
              metadata() {},
              async ask() {},
            },
          )
          expect(requests).toHaveLength(1)
          expect(requests[0]).toMatchObject({
            url: "/v1beta/models/gemini-3-pro-image:generateContent",
            key: "gemini-local-image-route",
            body: {
              contents: [{ role: "user", parts: [{ text: "A precise benchmark diagram" }] }],
              generationConfig: { responseModalities: ["IMAGE"] },
            },
          })
          expect(result.metadata).toMatchObject({
            model: "google/gemini-3-pro-image",
            route: "gemini",
          })

          await tool.execute(
            { prompt: "A wide benchmark diagram", output_path: "gemini-wide.png", aspect_ratio: "16:9" },
            {
              sessionID: session.id,
              messageID: "msg_gemini_wide_image",
              callID: "call_gemini_wide_image",
              agent: "research",
              abort: new AbortController().signal,
              messages: [],
              metadata() {},
              async ask() {},
            },
          )
          expect(requests[1]?.body).toMatchObject({
            generationConfig: {
              responseModalities: ["IMAGE"],
              responseFormat: { image: { aspectRatio: "ASPECT_RATIO_SIXTEEN_BY_NINE" } },
            },
          })
        },
      })
    } finally {
      server.stop(true)
    }
  })

  test("rejects unsupported external image paths before requesting filesystem approval", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => Provider.invalidate(),
      fn: async () => {
        const session = await executionSession()
        const tool = await GenerateImageTool.init()
        const asks: Parameters<Tool.Context["ask"]>[0][] = []
        const ctx: Tool.Context = {
          sessionID: session.id,
          messageID: "msg_invalid_image_paths",
          callID: "call_invalid_image_paths",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask(input) {
            asks.push(input)
          },
        }

        await expect(tool.execute({ prompt: "figure", output_path: "/tmp/not-an-image.txt" }, ctx)).rejects.toThrow(
          "output_path must end in",
        )
        await expect(
          tool.execute(
            {
              prompt: "figure",
              output_path: "figure.png",
              input_path: "/tmp/not-an-image",
            },
            ctx,
          ),
        ).rejects.toThrow("input_path must be an existing")
        expect(asks).toHaveLength(0)
      },
    })
  })

  test("rejects a retired product token before contacting an image host", async () => {
    const requests = { value: 0 }
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests.value++
        return Response.json({ data: [] })
      },
    })
    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          provider: {
            openrouter: {
              options: {
                apiKey: "thk_managed-image-route",
                baseURL: `http://127.0.0.1:${server.port}/v1`,
              },
            },
          },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => Provider.invalidate(),
        fn: async () => {
          const session = await executionSession()
          const tool = await GenerateImageTool.init()
          await expect(
            tool.execute(
              {
                prompt: "A benchmark schematic",
                output_path: "figure.png",
              },
              {
                sessionID: session.id,
                messageID: "msg_managed_image",
                callID: "call_managed_image",
                agent: "research",
                abort: new AbortController().signal,
                messages: [],
                metadata() {},
                async ask() {},
              },
            ),
          ).rejects.toThrow("Connect your Gemini or OpenRouter account")
          expect(requests.value).toBe(0)
        },
      })
    } finally {
      server.stop(true)
    }
  })

  test("rejects GIF output before constructing an unsupported OpenRouter request", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      init: async () => Provider.invalidate(),
      fn: async () => {
        const session = await executionSession()
        const tool = await GenerateImageTool.init()
        await expect(
          tool.execute(
            {
              prompt: "A benchmark schematic",
              output_path: "figure.gif",
            },
            {
              sessionID: session.id,
              messageID: "msg_gif_image",
              callID: "call_gif_image",
              agent: "research",
              abort: new AbortController().signal,
              messages: [],
              metadata() {},
              async ask() {},
            },
          ),
        ).rejects.toThrow("output_path must end in .png, .jpg, .jpeg, or .webp")
      },
    })
  })

  test("extracts the dedicated OpenRouter Image API response", () => {
    const bytes = Buffer.from("dedicated-image-bytes")
    const image = extractGeneratedImage({
      data: [{ b64_json: bytes.toString("base64"), media_type: "image/png" }],
    })

    expect(image.mime).toBe("image/png")
    expect(image.bytes).toEqual(bytes)
  })

  test("extracts the OpenRouter images response used by Nano Banana", () => {
    const bytes = Buffer.from("image-bytes")
    const image = extractGeneratedImage({
      choices: [
        {
          message: {
            images: [{ image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` } }],
          },
        },
      ],
    })

    expect(image.mime).toBe("image/png")
    expect(image.bytes).toEqual(bytes)
  })

  test("extracts image parts from multimodal content", () => {
    const bytes = Buffer.from("webp-bytes")
    const image = extractGeneratedImage({
      choices: [
        {
          message: {
            content: [{ type: "image", image_url: `data:image/webp;base64,${bytes.toString("base64")}` }],
          },
        },
      ],
    })

    expect(image.mime).toBe("image/webp")
    expect(image.bytes).toEqual(bytes)
  })

  test("extracts a downloadable image URL from the OpenRouter server tool response", () => {
    expect(
      extractGeneratedImageURL({
        choices: [
          {
            message: {
              content: [{ type: "text", text: '{"status":"ok","imageUrl":"https://images.example/test.png"}' }],
            },
          },
        ],
      }),
    ).toBe("https://images.example/test.png")
  })

  test("rejects a response with no generated image", () => {
    expect(() =>
      extractGeneratedImage({ choices: [{ message: { content: [{ type: "text", text: "no image" }] } }] }),
    ).toThrow("without returning image bytes")
  })

  test("streams successful response bodies within an explicit byte ceiling", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("first"))
          controller.enqueue(Buffer.from("second"))
          controller.close()
        },
      }),
    )

    expect((await readBoundedImageResponse(response, 11)).toString()).toBe("firstsecond")
  })

  test("cancels a streamed response as soon as its real body exceeds the ceiling", async () => {
    const cancelled = { value: false }
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("1234"))
          controller.enqueue(Buffer.from("5678"))
        },
        cancel() {
          cancelled.value = true
        },
      }),
      { headers: { "content-length": "4" } },
    )

    await expect(readBoundedImageResponse(response, 6)).rejects.toThrow("6-byte safety limit")
    expect(cancelled.value).toBe(true)
  })

  test("rejects an oversized declared response before accumulating its body", async () => {
    const cancelled = { value: false }
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("small"))
        },
        cancel() {
          cancelled.value = true
        },
      }),
      { headers: { "content-length": "100" } },
    )

    await expect(readBoundedImageResponse(response, 10)).rejects.toThrow("10-byte safety limit")
    expect(cancelled.value).toBe(true)
  })

  test("keeps large generated images artifact-only instead of embedding a huge data URL", () => {
    const attachments = generatedImageAttachments({
      bytes: Buffer.alloc(8 * 1024 * 1024 + 1),
      mime: "image/png",
      filepath: "/workspace/large.png",
      sessionID: "ses_test",
      messageID: "msg_test",
    })

    expect(attachments).toEqual([])
  })

  test("retains an inline attachment for a small generated image", () => {
    const attachments = generatedImageAttachments({
      bytes: Buffer.from("small image"),
      mime: "image/png",
      filepath: "/workspace/small.png",
      sessionID: "ses_test",
      messageID: "msg_test",
    })

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.filename).toBe("small.png")
    expect(attachments[0]?.url).toBe(`data:image/png;base64,${Buffer.from("small image").toString("base64")}`)
  })
})
