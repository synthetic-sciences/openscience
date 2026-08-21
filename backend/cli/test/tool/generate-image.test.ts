import { describe, expect, test } from "bun:test"
import { extractGeneratedImage, extractGeneratedImageURL } from "../../src/tool/generate-image"

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
})
