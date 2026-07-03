import type { BunPlugin } from "bun"
import crypto from "crypto"

/** Generate a random 256-bit AES key split into 4 XOR fragments.
 *  k1 XOR k2 XOR k3 XOR k4 = original key */
export function generateKeyFragments(): string[] {
  const key = crypto.randomBytes(32)
  const masks = [crypto.randomBytes(32), crypto.randomBytes(32), crypto.randomBytes(32)]
  const k4 = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) {
    k4[i] = key[i] ^ masks[0][i] ^ masks[1][i] ^ masks[2][i]
  }
  return [...masks.map((m) => m.toString("base64")), k4.toString("base64")]
}

function reassembleKey(fragments: string[]): Buffer {
  const bufs = fragments.map((f) => Buffer.from(f, "base64"))
  const key = Buffer.alloc(32)
  for (const frag of bufs) {
    for (let i = 0; i < 32; i++) key[i] ^= frag[i]
  }
  return key
}

export function createEncryptPromptsPlugin(keyFragments: string[]): {
  plugin: BunPlugin
  defines: Record<string, string>
} {
  const key = reassembleKey(keyFragments)

  return {
    plugin: {
      name: "encrypt-prompts",
      setup(build) {
        build.onLoad({ filter: /\.txt$/ }, async (args) => {
          const plaintext = await Bun.file(args.path).text()
          const iv = crypto.randomBytes(12)
          const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
          let encrypted = cipher.update(plaintext, "utf8", "base64")
          encrypted += cipher.final("base64")
          const tag = cipher.getAuthTag().toString("base64")

          return {
            contents: [
              `import { _d } from "@/util/prompt-decrypt";`,
              `export default _d("${encrypted}", "${iv.toString("base64")}", "${tag}");`,
            ].join("\n"),
            loader: "js",
          }
        })
      },
    },
    defines: {
      OPENSCIENCE_K1: `"${keyFragments[0]}"`,
      OPENSCIENCE_K2: `"${keyFragments[1]}"`,
      OPENSCIENCE_K3: `"${keyFragments[2]}"`,
      OPENSCIENCE_K4: `"${keyFragments[3]}"`,
    },
  }
}
