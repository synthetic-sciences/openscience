import { expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { LSPServer, selectClangdReleaseAsset } from "../../src/lsp/server"

const official = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "22.1.6",
  assets: [
    {
      name: "clangd-linux-22.1.6.zip",
      browser_download_url: "https://github.com/clangd/clangd/releases/download/22.1.6/clangd-linux-22.1.6.zip",
    },
  ],
  ...overrides,
})

test("clangd release selection accepts only canonical official assets", () => {
  expect(LSPServer.Clangd.readable).toEqual([path.join(Global.Path.bin, "clangd-current")])
  expect(selectClangdReleaseAsset(official(), "linux")).toEqual({
    tag: "22.1.6",
    name: "clangd-linux-22.1.6.zip",
    downloadURL: "https://github.com/clangd/clangd/releases/download/22.1.6/clangd-linux-22.1.6.zip",
    format: "zip",
  })

  expect(selectClangdReleaseAsset(official({ tag_name: "../../bin/sh" }), "linux")).toBeUndefined()
  expect(
    selectClangdReleaseAsset(
      official({
        assets: [
          {
            name: "clangd-linux-22.1.6.zip",
            browser_download_url: "https://attacker.test/clangd-linux-22.1.6.zip",
          },
        ],
      }),
      "linux",
    ),
  ).toBeUndefined()
  expect(
    selectClangdReleaseAsset(
      official({
        assets: [
          {
            name: "clangd-indexing-tools-linux-22.1.6.zip",
            browser_download_url:
              "https://github.com/clangd/clangd/releases/download/22.1.6/clangd-indexing-tools-linux-22.1.6.zip",
          },
        ],
      }),
      "linux",
    ),
  ).toBeUndefined()
})
