import type { Prompt } from "@/context/prompt"

/**
 * A failed request may restore the message it tried to send only while the
 * composer is still in the exact cleared state left by that submission.
 * Anything typed or attached afterward belongs to the next draft and wins.
 */
export function canRestoreFailedSubmission(current: Prompt, mode: "normal" | "shell") {
  const part = current[0]
  return mode === "normal" && current.length === 1 && part?.type === "text" && part.content === ""
}
