import crypto from "crypto"

/**
 * AES-256-GCM envelope for a single secret value, keyed explicitly rather than
 * from ambient state.
 *
 * The credential store seals every field value individually under the
 * machine-local `credentials.key`. That key never leaves the machine, which is
 * the point — but it also means a store copied between two data roots is
 * unreadable in its new home unless something can hold both keys at once. The
 * data-directory import is exactly that something, and it lives below `Global`
 * in the module graph, so the crypto cannot come from the settings route that
 * owns the store. Hence a leaf that takes the key as an argument: the route
 * passes its machine key, the import passes one key to open and another to
 * seal.
 *
 * Wire format is `iv(12) | tag(16) | ciphertext`, base64. Changing it silently
 * strands every credential already on disk.
 */
export namespace SecretBox {
  export function seal(key: Buffer, plain: string): string {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")
  }

  /** Throws on a wrong key or a tampered payload — callers treat that as
   *  "unreadable field, leave it alone". */
  export function open(key: Buffer, payload: string): string {
    const buf = Buffer.from(payload, "base64")
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12))
    decipher.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8")
  }
}
