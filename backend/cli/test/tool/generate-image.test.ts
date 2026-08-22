import { describe, expect, test } from "bun:test"
import {
  extractGeneratedImage,
  extractGeneratedImageURL,
  generatedImageAttachments,
  readBoundedImageResponse,
} from "../../src/tool/generate-image"

describe("generate_image response parsing", () => {
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
