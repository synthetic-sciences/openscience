export namespace ResearchRouting {
  export type Route = "managed" | "firecrawl_byok" | "community"

  export type Access = {
    aceEnabled: boolean
    managedUnlocked: boolean
    firecrawl: boolean
  }

  /** Ace is the managed-spend boundary. A signed-in account alone is not
   * authorization to spend through the hosted search gateway. */
  export function select(input: Access): Route {
    if (input.aceEnabled && input.managedUnlocked) return "managed"
    if (input.firecrawl) return "firecrawl_byok"
    return "community"
  }
}
