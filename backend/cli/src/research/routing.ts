export namespace ResearchRouting {
  export type Route = "managed" | "firecrawl_byok" | "community"

  export type Access = {
    mode: "byok" | "managed"
    aceEnabled: boolean
    managedUnlocked: boolean
    firecrawl: boolean
  }

  /** Follow the same explicit access choice as model inference. The server's
   * managedUnlocked decision already covers funded Wallets and Ace reload;
   * aceEnabled is retained only for compatibility with older callers. */
  export function select(input: Access): Route {
    if (input.mode === "managed") {
      if (input.managedUnlocked) return "managed"
      return "community"
    }
    if (input.firecrawl) return "firecrawl_byok"
    return "community"
  }
}
