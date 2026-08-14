import path from "node:path"
import { Global } from "@/global"

/** One process-stable identity for the managed truncated-output enclave. */
export namespace ToolOutputPath {
  export const root = path.join(Global.Path.data, "tool-output")
  export const glob = path.join(root, "*")
}
