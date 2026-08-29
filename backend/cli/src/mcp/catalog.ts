import crypto from "node:crypto"
import z from "zod"

const Setup = z
  .object({
    type: z.literal("remote"),
    name: z.string(),
    url: z.string().url(),
    oauth: z.enum(["auto", "client"]),
    scope: z.string().optional(),
    confidential_client: z.boolean().optional(),
  })
  .strict()

export const ConnectorCatalogEntry = z
  .object({
    schema_version: z.literal(1),
    id: z.enum(["github", "benchling", "box", "dropbox", "s3"]),
    name: z.string(),
    provider: z.string(),
    status: z.enum(["official_setup", "manual_review", "unavailable"]),
    summary: z.string(),
    source_url: z.string().url(),
    reviewed_at: z.string().date(),
    read_operations: z.array(z.string()),
    upstream_write_operations: z.array(z.string()),
    writes_enabled_by_catalog: z.literal(false),
    safety: z.string(),
    requirements: z.array(z.string()),
    setup: Setup.optional(),
  })
  .strict()
export type ConnectorCatalogEntry = z.infer<typeof ConnectorCatalogEntry>

function revision(value: ConnectorCatalogEntry) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

const entries = ConnectorCatalogEntry.array().parse([
  {
    schema_version: 1,
    id: "github",
    name: "GitHub",
    provider: "GitHub",
    status: "official_setup",
    summary: "GitHub's official hosted MCP server for repositories, issues, pull requests, releases, and code search.",
    source_url:
      "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server",
    reviewed_at: "2026-08-28",
    read_operations: [
      "Repository and code search",
      "Issues and pull-request inspection",
      "Repository and release inspection",
    ],
    upstream_write_operations: ["Issue and pull-request changes", "Repository and workflow mutations"],
    writes_enabled_by_catalog: false,
    safety:
      "The reviewed setup saves disabled. After connecting, inspect the discovered tool list and OAuth scopes before approving any invocation. OpenScience does not label the upstream server read-only; every invocation still crosses the MCP permission boundary.",
    requirements: [
      "A GitHub account",
      "Organization approval where required",
      "Explicit review of requested OAuth scopes",
    ],
    setup: { type: "remote", name: "github", url: "https://api.githubcopilot.com/mcp/", oauth: "auto" },
  },
  {
    schema_version: 1,
    id: "benchling",
    name: "Benchling",
    provider: "Benchling",
    status: "manual_review",
    summary:
      "Benchling's official tenant-specific remote MCP server provides governed, user-authorized access to Benchling scientific data.",
    source_url:
      "https://help.benchling.com/hc/en-us/articles/40342713479437-Configure-Benchling-s-MCP-Server-for-other-MCP-clients",
    reviewed_at: "2026-08-28",
    read_operations: [
      "Natural-language queries over tenant scientific data",
      "Structured summaries, tables, comparisons, and source links",
    ],
    upstream_write_operations: [],
    writes_enabled_by_catalog: false,
    safety:
      "The endpoint is tenant-specific and uses delegated OAuth 2.1 with dynamic client registration. This catalog does not claim ELN write-back and does not guess or store your tenant URL.",
    requirements: [
      "Benchling Enterprise with Benchling Chat and MCP enabled by a tenant administrator",
      "The exact https://<tenant>.mcp.benchling.com/mcp endpoint",
      "V3 APIs enabled and user access reviewed",
    ],
  },
  {
    schema_version: 1,
    id: "box",
    name: "Box",
    provider: "Box",
    status: "official_setup",
    summary: "Box's official hosted MCP endpoint for Box content and Box AI features.",
    source_url: "https://developer.box.com/guides/box-mcp/setup",
    reviewed_at: "2026-08-28",
    read_operations: ["File content and metadata", "Folder and hub inspection", "Search and Box AI requests"],
    upstream_write_operations: ["File and metadata changes", "Hub and Doc Gen changes"],
    writes_enabled_by_catalog: false,
    safety:
      "The reviewed setup saves disabled. Create a dedicated Box integration, then inspect its discovered tools and scopes before approving any invocation. Box's server includes write tools; OpenScience does not call them trusted.",
    requirements: [
      "A Box enterprise account with MCP enabled",
      "A dedicated client ID and secret",
      "Reviewed Box content scopes",
    ],
    setup: {
      type: "remote",
      name: "box",
      url: "https://mcp.box.com",
      oauth: "client",
      confidential_client: true,
    },
  },
  {
    schema_version: 1,
    id: "dropbox",
    name: "Dropbox",
    provider: "Dropbox",
    status: "manual_review",
    summary:
      "Dropbox publishes a source repository for its Dash search MCP server, but no reviewed hosted endpoint is bundled.",
    source_url: "https://github.com/dropbox/mcp-server-dash",
    reviewed_at: "2026-08-28",
    read_operations: ["Dash search", "File metadata and content reads requested by the upstream server"],
    upstream_write_operations: [],
    writes_enabled_by_catalog: false,
    safety:
      "OpenScience will not clone or execute a moving Git branch. Pin and review a commit, install it outside the app, then add its exact local command manually with read-only Dropbox scopes.",
    requirements: [
      "A pinned reviewed upstream commit",
      "Python 3.10+ and uv",
      "A Dropbox app with metadata/content read scopes",
    ],
  },
  {
    schema_version: 1,
    id: "s3",
    name: "Amazon S3",
    provider: "AWS",
    status: "official_setup",
    summary: "S3 access through AWS's official managed MCP server and the user's existing IAM identity.",
    source_url: "https://docs.aws.amazon.com/agent-toolkit/latest/userguide/mcp-server.html",
    reviewed_at: "2026-08-28",
    read_operations: ["S3 object and bucket reads permitted by IAM", "AWS documentation and API discovery"],
    upstream_write_operations: ["AWS API calls, including S3 mutations when IAM permits them"],
    writes_enabled_by_catalog: false,
    safety:
      "The reviewed setup saves disabled. The AWS MCP endpoint is broader than S3; use a dedicated least-privilege IAM identity, connect, and inspect tools before approving any invocation. CloudTrail remains the authoritative external audit log.",
    requirements: [
      "An AWS account",
      "OAuth access to AWS MCP Server",
      "A least-privilege IAM policy limited to intended S3 resources",
    ],
    setup: {
      type: "remote",
      name: "aws-s3",
      url: "https://aws-mcp.us-east-1.api.aws/mcp?oauth=initialize",
      oauth: "auto",
    },
  },
])

export namespace ConnectorCatalog {
  export const VERSION = 1
  export function list() {
    return entries.map((value) => ({ ...value, revision: revision(value) }))
  }
  export function get(id: ConnectorCatalogEntry["id"]) {
    const value = entries.find((entry) => entry.id === id)
    return value ? { ...value, revision: revision(value) } : undefined
  }
}
