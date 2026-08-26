export const STRESS_CATEGORIES = [
  "chat",
  "non_research",
  "indexing",
  "skills",
  "delegation",
  "malformed_tools",
  "retries",
  "compaction",
  "budgets",
  "artifacts",
  "permissions",
  "provider_failures",
] as const

export type StressCategory = (typeof STRESS_CATEGORIES)[number]

export type StressStimulus =
  | { kind: "reply"; text: string }
  | { kind: "tool"; name: string; input: unknown; repeat?: number }
  | { kind: "error"; status: number; body: string; retryAfterMs?: number }
  | { kind: "disconnect"; afterChunks: number }
  | { kind: "inspect"; target: "tools" | "system" | "messages" }

export type StressScenario = {
  id: string
  category: StressCategory
  title: string
  prompt: string
  turns?: readonly string[]
  config?: Readonly<Record<string, unknown>>
  stimulus: StressStimulus
  expect: {
    terminal: "completed" | "failed" | "blocked" | "pending"
    tools?: number
    retries?: number
    children?: number
    artifacts?: "none" | "requested_only"
    contains?: readonly string[]
    excludes?: readonly string[]
  }
}

export const RAW_TOOL_ERRORS = [
  "expected string, received undefined",
  "Please rewrite the input so it satisfies the expected schema",
  "tool was called with invalid arguments",
] as const

const clean = (input: Omit<StressScenario, "expect"> & { expect: StressScenario["expect"] }): StressScenario => ({
  ...input,
  expect: {
    ...input.expect,
    excludes: [...RAW_TOOL_ERRORS, ...(input.expect.excludes ?? [])],
  },
})

/**
 * Deterministic local campaign contract. Each entry represents one fresh
 * OpenScience session. A fake provider can execute `stimulus` without network
 * access or paid inference; the runner owns setup implied by `config` and
 * verifies only the observable `expect` fields.
 */
export const STRESS_MATRIX: readonly StressScenario[] = [
  clean({
    id: "chat.exact-reply",
    category: "chat",
    title: "Exact ordinary reply",
    prompt: "Reply with exactly MATRIX_CHAT_OK.",
    stimulus: { kind: "reply", text: "MATRIX_CHAT_OK" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", contains: ["MATRIX_CHAT_OK"] },
  }),
  clean({
    id: "chat.follow-up-context",
    category: "chat",
    title: "Two-turn context",
    prompt: "Remember the codeword juniper and acknowledge it.",
    turns: ["What codeword did I give you?"],
    stimulus: { kind: "reply", text: "juniper" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", contains: ["juniper"] },
  }),
  clean({
    id: "chat.unicode",
    category: "chat",
    title: "Unicode survives transport",
    prompt: "Return exactly: μ₀ = 3.2 µm — ΔG.",
    stimulus: { kind: "reply", text: "μ₀ = 3.2 µm — ΔG" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", contains: ["μ₀", "ΔG"] },
  }),
  clean({
    id: "chat.concurrent-isolation",
    category: "chat",
    title: "Concurrent session isolation",
    prompt: "Reply with only MATRIX_ISOLATED_A.",
    stimulus: { kind: "reply", text: "MATRIX_ISOLATED_A" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", excludes: ["MATRIX_ISOLATED_B"] },
  }),
  clean({
    id: "non_research.explain",
    category: "non_research",
    title: "Explanation needs no contract",
    prompt: "In two sentences, explain why binary search is logarithmic.",
    stimulus: { kind: "reply", text: "Each comparison halves the remaining search interval." },
    expect: { terminal: "completed", tools: 0, artifacts: "none", excludes: ["Research contract"] },
  }),
  clean({
    id: "non_research.rewrite",
    category: "non_research",
    title: "Text rewrite stays in chat",
    prompt: "Rewrite 'we did a thing' as one professional sentence.",
    stimulus: { kind: "reply", text: "We completed the requested work." },
    expect: { terminal: "completed", tools: 0, artifacts: "none" },
  }),
  clean({
    id: "non_research.local-read",
    category: "non_research",
    title: "Bounded local read",
    prompt: "Read README.md and state its first heading.",
    stimulus: { kind: "tool", name: "read", input: { filePath: "README.md", limit: 20 } },
    expect: { terminal: "completed", tools: 1, artifacts: "none" },
  }),
  clean({
    id: "non_research.local-edit",
    category: "non_research",
    title: "Bounded local edit",
    prompt: "Append one MATRIX_EDIT line to scratch-note.txt and stop.",
    stimulus: {
      kind: "tool",
      name: "edit",
      input: {
        filePath: "scratch-note.txt",
        oldString: "fixture-owned note\n",
        newString: "fixture-owned note\nMATRIX_EDIT\n",
      },
    },
    expect: { terminal: "completed", tools: 2, artifacts: "none", contains: ["MATRIX_EDIT"] },
  }),
  clean({
    id: "indexing.empty-list",
    category: "indexing",
    title: "Empty library is a clean state",
    prompt: "List my indexed Atlas sources.",
    stimulus: { kind: "tool", name: "atlas", input: { operation: "library_list" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none", excludes: ["missing inputs"] },
  }),
  clean({
    id: "indexing.remote-repository",
    category: "indexing",
    title: "Remote repository subscription",
    prompt: "Index the fixture repository URL, then show its source id.",
    stimulus: {
      kind: "tool",
      name: "atlas",
      input: { operation: "library_subscribe", url: "https://github.com/example/fixture", source_type: "repository" },
    },
    expect: { terminal: "completed", tools: 1, artifacts: "none", contains: ["source"] },
  }),
  clean({
    id: "indexing.remote-paper",
    category: "indexing",
    title: "Remote paper indexing",
    prompt: "Index the fixture paper URL privately and report its source id.",
    stimulus: {
      kind: "tool",
      name: "atlas",
      input: { operation: "library_add", source_type: "research_paper", url: "https://example.test/paper" },
    },
    expect: { terminal: "completed", tools: 1, artifacts: "none", contains: ["source"] },
  }),
  clean({
    id: "indexing.local-private",
    category: "indexing",
    title: "Local folder stays private",
    prompt: "Use Atlas to index the attached fixture folder as a private local source.",
    config: { permissionReply: "once" },
    stimulus: {
      kind: "tool",
      name: "atlas",
      input: { operation: "library_add_local", folder: "fixture-repository" },
    },
    expect: { terminal: "completed", tools: 1, artifacts: "none", contains: ["local_folder"] },
  }),
  clean({
    id: "indexing.local-sync",
    category: "indexing",
    title: "Local source refresh",
    prompt: "Refresh the existing fixture local source after its README changes.",
    stimulus: {
      kind: "tool",
      name: "atlas",
      input: { operation: "library_sync_local", source_id: "src_fixture", folder: "fixture-repository" },
    },
    expect: { terminal: "completed", tools: 1, artifacts: "none", contains: ["src_fixture"] },
  }),
  clean({
    id: "indexing.secret-filter",
    category: "indexing",
    title: "Local collector omits unsafe files",
    prompt: "Index the fixture folder; do not upload secrets, symlinks, or binary blobs.",
    stimulus: {
      kind: "tool",
      name: "atlas",
      input: { operation: "library_add_local", folder: "fixture-with-unsafe-files" },
    },
    expect: { terminal: "completed", tools: 1, artifacts: "none", contains: ["omitted"] },
  }),
  clean({
    id: "skills.prefix",
    category: "skills",
    title: "Prefix slash skill",
    prompt: "/fixture-skill run the bounded check.",
    stimulus: { kind: "tool", name: "skill", input: { name: "fixture-skill" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none" },
  }),
  clean({
    id: "skills.inline",
    category: "skills",
    title: "Inline slash skill",
    prompt: "Please use /fixture-skill before answering.",
    stimulus: { kind: "tool", name: "skill", input: { name: "fixture-skill" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none" },
  }),
  clean({
    id: "skills.punctuated",
    category: "skills",
    title: "Punctuated slash skill",
    prompt: "Run the check (/fixture-skill), then answer.",
    stimulus: { kind: "tool", name: "skill", input: { name: "fixture-skill" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none" },
  }),
  clean({
    id: "skills.direct-inline",
    category: "skills",
    title: "Slash skill overrides direct-answer narrowing",
    prompt: "What is the bounded fixture result? /fixture-skill",
    stimulus: { kind: "tool", name: "skill", input: { name: "fixture-skill" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none" },
  }),
  clean({
    id: "skills.unknown",
    category: "skills",
    title: "Unknown slash token is harmless",
    prompt: "Use /not-installed if it exists; otherwise say unavailable.",
    stimulus: { kind: "inspect", target: "system" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", excludes: ['skill({name:"not-installed"})'] },
  }),
  clean({
    id: "skills.disabled",
    category: "skills",
    title: "Disabled skill is absent",
    prompt: "Use /fixture-disabled if available.",
    config: { disabledSkills: ["fixture-disabled"] },
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", excludes: ["fixture-disabled"] },
  }),
  clean({
    id: "delegation.auto-on",
    category: "delegation",
    title: "Automatic delegation enabled",
    prompt: "Delegate one bounded independent check, then synthesize it.",
    config: { delegation: true },
    stimulus: {
      kind: "tool",
      name: "task",
      input: { subagent_type: "explore", description: "inspect fixture", prompt: "Inspect the fixture." },
    },
    expect: { terminal: "completed", tools: 1, children: 1, artifacts: "none" },
  }),
  clean({
    id: "delegation.auto-off",
    category: "delegation",
    title: "Automatic delegation disabled",
    prompt: "Answer directly without delegation.",
    config: { delegation: false },
    stimulus: { kind: "inspect", target: "tools" },
    expect: { terminal: "completed", tools: 0, children: 0, artifacts: "none", excludes: ["task"] },
  }),
  clean({
    id: "delegation.explicit-attachment",
    category: "delegation",
    title: "Explicit agent remains authoritative",
    prompt: "Ask the explicitly attached execution agent to inspect this sentence.",
    config: { delegation: false, explicitAgent: "execute" },
    stimulus: {
      kind: "tool",
      name: "task",
      input: { subagent_type: "execute", description: "inspect fixture", prompt: "Inspect the fixture." },
    },
    expect: { terminal: "completed", tools: 1, children: 1, artifacts: "none" },
  }),
  clean({
    id: "delegation.specialist",
    category: "delegation",
    title: "Domain specialist maps to execute",
    prompt: "Have the biology specialist inspect the fixture assay.",
    config: { delegation: true },
    stimulus: {
      kind: "tool",
      name: "task",
      input: {
        subagent_type: "execute",
        specialist: "biology",
        description: "inspect fixture assay",
        prompt: "Inspect the fixture assay using the matching biology skill.",
      },
    },
    expect: { terminal: "completed", tools: 1, children: 1, artifacts: "none" },
  }),
  clean({
    id: "delegation.child-failure",
    category: "delegation",
    title: "Child failure does not erase parent result",
    prompt: "Delegate one check; if it fails, report the bounded limitation.",
    stimulus: {
      kind: "tool",
      name: "task",
      input: { subagent_type: "explore", description: "fixture failure", prompt: "Run the bounded failure fixture." },
    },
    expect: { terminal: "completed", tools: 1, children: 1, artifacts: "none", contains: ["limitation"] },
  }),
  clean({
    id: "delegation.child-grants",
    category: "delegation",
    title: "Child receives only delegated grants",
    prompt: "Delegate a read of only the fixture handoff file.",
    stimulus: {
      kind: "tool",
      name: "task",
      input: {
        subagent_type: "explore",
        description: "read handoff fixture",
        prompt: "Read only the handoff fixture.",
      },
    },
    expect: { terminal: "completed", tools: 1, children: 1, artifacts: "none", excludes: ["sibling secret"] },
  }),
  clean({
    id: "malformed_tools.empty-bash",
    category: "malformed_tools",
    title: "Empty bash input recovers once",
    prompt: "Exercise the interrupted bash-call fixture.",
    stimulus: { kind: "tool", name: "bash", input: {} },
    expect: {
      terminal: "completed",
      tools: 1,
      retries: 0,
      artifacts: "none",
      contains: ["Recovered incomplete bash call"],
    },
  }),
  clean({
    id: "malformed_tools.alias-bash",
    category: "malformed_tools",
    title: "Bash aliases canonicalize",
    prompt: "Run the harmless fixture command once.",
    stimulus: { kind: "tool", name: "bash", input: { cmd: "pwd" } },
    expect: { terminal: "completed", tools: 1, retries: 0, artifacts: "none" },
  }),
  clean({
    id: "malformed_tools.truncated-json",
    category: "malformed_tools",
    title: "Truncated arguments become one bounded recovery",
    prompt: "Exercise the truncated tool-argument fixture.",
    stimulus: { kind: "tool", name: "read", input: '{"filePath":' },
    expect: { terminal: "completed", tools: 1, retries: 0, artifacts: "none", contains: ["incomplete"] },
  }),
  clean({
    id: "malformed_tools.unknown-tool",
    category: "malformed_tools",
    title: "Unknown tool cannot execute and recovers safely",
    prompt: "Exercise the unknown tool fixture.",
    stimulus: { kind: "tool", name: "not_a_real_tool", input: {} },
    expect: { terminal: "completed", tools: 1, retries: 0, artifacts: "none", contains: ["unavailable"] },
  }),
  clean({
    id: "malformed_tools.repeat-breaker",
    category: "malformed_tools",
    title: "Repeated invalid call trips breaker",
    prompt: "Exercise the repeated malformed bash fixture.",
    stimulus: { kind: "tool", name: "bash", input: {}, repeat: 4 },
    expect: { terminal: "failed", tools: 2, retries: 0, artifacts: "none", contains: ["repeated"] },
  }),
  clean({
    id: "retries.rate-limit",
    category: "retries",
    title: "429 retries once",
    prompt: "Return MATRIX_AFTER_429 after the transient fixture clears.",
    stimulus: { kind: "error", status: 429, body: "rate_limit_exceeded", retryAfterMs: 1 },
    expect: { terminal: "completed", tools: 0, retries: 1, artifacts: "none", contains: ["MATRIX_AFTER_429"] },
  }),
  clean({
    id: "retries.server-overload",
    category: "retries",
    title: "503 retries once",
    prompt: "Return MATRIX_AFTER_503 after the transient fixture clears.",
    stimulus: { kind: "error", status: 503, body: "service_unavailable", retryAfterMs: 1 },
    expect: { terminal: "completed", tools: 0, retries: 1, artifacts: "none", contains: ["MATRIX_AFTER_503"] },
  }),
  clean({
    id: "retries.deterministic-400",
    category: "retries",
    title: "Bad request does not retry",
    prompt: "Exercise the invalid request fixture.",
    stimulus: { kind: "error", status: 400, body: "invalid_value" },
    expect: { terminal: "failed", tools: 0, retries: 0, artifacts: "none" },
  }),
  clean({
    id: "compaction.openrouter-502",
    category: "compaction",
    title: "OpenRouter-wrapped context overflow compacts",
    prompt: "Exercise the provider-unavailable context wording fixture.",
    stimulus: { kind: "error", status: 502, body: "provider_unavailable: exceeds the context window" },
    expect: { terminal: "completed", tools: 0, retries: 0, artifacts: "none" },
  }),
  clean({
    id: "retries.stream-disconnect",
    category: "retries",
    title: "Stream disconnect retries cleanly",
    prompt: "Return MATRIX_AFTER_DISCONNECT after reconnecting.",
    stimulus: { kind: "disconnect", afterChunks: 1 },
    expect: { terminal: "completed", tools: 0, retries: 1, artifacts: "none", contains: ["MATRIX_AFTER_DISCONNECT"] },
  }),
  clean({
    id: "compaction.proactive",
    category: "compaction",
    title: "Threshold starts one compaction",
    prompt: "Continue the long fixture transcript and preserve codeword MATRIX_COMPACT_CODEWORD.",
    turns: ["Return the preserved codeword and stop."],
    config: { context: 64_000, threshold: 0.75 },
    stimulus: { kind: "inspect", target: "messages" },
    expect: {
      terminal: "completed",
      tools: 0,
      retries: 0,
      artifacts: "none",
      contains: ["MATRIX_COMPACT_CODEWORD"],
    },
  }),
  clean({
    id: "compaction.reactive-overflow",
    category: "compaction",
    title: "Overflow compacts then retries",
    prompt: "Continue after one deterministic context overflow.",
    stimulus: { kind: "error", status: 400, body: "context_length_exceeded" },
    expect: { terminal: "completed", tools: 0, retries: 0, artifacts: "none", contains: ["continued"] },
  }),
  clean({
    id: "compaction.handoff-objective",
    category: "compaction",
    title: "Handoff keeps the user objective",
    prompt: "Keep objective MATRIX_OBJECTIVE and do not add new work.",
    turns: ["Continue the same objective."],
    config: { context: 64_000, threshold: 0.75 },
    stimulus: { kind: "inspect", target: "messages" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", contains: ["MATRIX_OBJECTIVE"] },
  }),
  clean({
    id: "compaction.ineffective-breaker",
    category: "compaction",
    title: "Ineffective compaction stops looping",
    prompt: "Exercise three ineffective compactions and stop.",
    config: { ineffectiveCompactions: 3 },
    stimulus: { kind: "inspect", target: "messages" },
    expect: { terminal: "failed", tools: 0, retries: 3, artifacts: "none", contains: ["context"] },
  }),
  clean({
    id: "compaction.tool-pruning",
    category: "compaction",
    title: "Old large outputs are pruned",
    prompt: "Use the current fixture result without reshipping the old large output.",
    config: { oldToolOutputBytes: 120_000 },
    stimulus: { kind: "inspect", target: "messages" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", excludes: ["OLD_OUTPUT_SENTINEL"] },
  }),
  clean({
    id: "budgets.ordinary-ungated",
    category: "budgets",
    title: "Ordinary chat ignores research budget",
    prompt: "Reply with MATRIX_UNGATED.",
    config: { researchContract: false },
    stimulus: { kind: "reply", text: "MATRIX_UNGATED" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", contains: ["MATRIX_UNGATED"] },
  }),
  clean({
    id: "budgets.soft-finalization",
    category: "budgets",
    title: "Legacy contract adds no hidden finalization calls",
    prompt: "Use the remaining bounded call to summarize current verified work.",
    turns: ["Now return the bounded final summary."],
    config: { researchContract: true, modelCalls: 3 },
    stimulus: { kind: "reply", text: "Bounded finalization." },
    expect: { terminal: "completed", tools: 0, artifacts: "none", contains: ["finalization"] },
  }),
  clean({
    id: "budgets.hard-block",
    category: "budgets",
    title: "Minimal Research ignores the legacy hard boundary",
    prompt: "Attempt one call after the bounded epoch is exhausted.",
    config: { researchContract: true, modelCalls: 1, exhausted: true },
    stimulus: { kind: "inspect", target: "messages" },
    expect: { terminal: "completed", tools: 0, retries: 0, artifacts: "none", contains: ["budget"] },
  }),
  clean({
    id: "budgets.explicit-resume",
    category: "budgets",
    title: "Continue remains an ordinary conversational turn",
    prompt: "continue",
    config: { researchContract: true, exhausted: true, epoch: 1 },
    stimulus: { kind: "reply", text: "MATRIX_EPOCH_2" },
    expect: { terminal: "completed", tools: 0, retries: 0, artifacts: "none", contains: ["MATRIX_EPOCH_2"] },
  }),
  clean({
    id: "artifacts.optional-chat",
    category: "artifacts",
    title: "Ordinary answer creates no Result",
    prompt: "Answer 2 + 2 in chat. Do not create a file.",
    stimulus: { kind: "reply", text: "4" },
    expect: { terminal: "completed", tools: 0, artifacts: "none", contains: ["4"] },
  }),
  clean({
    id: "artifacts.requested-only",
    category: "artifacts",
    title: "Only requested Result is saved",
    prompt: "Create exactly one fixture result.csv and save it as the Result.",
    stimulus: { kind: "tool", name: "artifact", input: { action: "save_file", path: "result.csv" } },
    expect: { terminal: "completed", tools: 1, artifacts: "requested_only", excludes: ["report.md"] },
  }),
  clean({
    id: "artifacts.no-invented-report",
    category: "artifacts",
    title: "Research does not invent a report",
    prompt: "Check the fixture value and reply in chat; no report was requested.",
    config: { researchContract: true, template: "minimal" },
    stimulus: { kind: "reply", text: "Fixture value verified." },
    expect: { terminal: "completed", tools: 0, artifacts: "none", excludes: ["repository_paper_understanding.md"] },
  }),
  clean({
    id: "permissions.allow-once",
    category: "permissions",
    title: "Allow once completes one read",
    prompt: "Read the fixture file once.",
    config: { read: "ask", permissionReply: "once" },
    stimulus: { kind: "tool", name: "read", input: { filePath: "fixture.txt" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none" },
  }),
  clean({
    id: "permissions.deny",
    category: "permissions",
    title: "Deny stops the read cleanly",
    prompt: "Try to read the fixture file once.",
    config: { read: "ask", permissionReply: "reject" },
    stimulus: { kind: "tool", name: "read", input: { filePath: "fixture.txt" } },
    expect: { terminal: "failed", tools: 1, retries: 0, artifacts: "none", contains: ["rejected"] },
  }),
  clean({
    id: "permissions.full-project",
    category: "permissions",
    title: "Full access edits the connected project",
    prompt: "Write MATRIX_WRITE to the fixture project scratch file.",
    config: { fullAccess: true },
    stimulus: { kind: "tool", name: "write", input: { filePath: "scratch.txt", content: "MATRIX_WRITE" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none", contains: ["MATRIX_WRITE"] },
  }),
  clean({
    id: "permissions.external-ask",
    category: "permissions",
    title: "External directory requires an explicit grant",
    prompt: "Read the separately connected fixture folder.",
    config: { externalDirectory: "ask", permissionReply: "once" },
    stimulus: { kind: "tool", name: "read", input: { filePath: "connected-fixture/file.txt" } },
    expect: { terminal: "completed", tools: 1, artifacts: "none", excludes: ["SessionFilesystemDeniedError"] },
  }),
  clean({
    id: "provider_failures.insufficient-balance",
    category: "provider_failures",
    title: "Insufficient balance is actionable",
    prompt: "Exercise the managed-credit insufficient-balance fixture.",
    stimulus: { kind: "error", status: 402, body: "insufficient_balance" },
    expect: { terminal: "blocked", tools: 0, retries: 0, artifacts: "none", contains: ["balance"] },
  }),
  clean({
    id: "provider_failures.unauthorized",
    category: "provider_failures",
    title: "Bad credential is not retried",
    prompt: "Exercise the unauthorized provider fixture.",
    stimulus: { kind: "error", status: 401, body: "invalid_api_key" },
    expect: { terminal: "blocked", tools: 0, retries: 0, artifacts: "none", contains: ["connect"] },
  }),
  clean({
    id: "provider_failures.policy",
    category: "provider_failures",
    title: "Provider policy is explicit",
    prompt: "Exercise the provider policy fixture.",
    stimulus: { kind: "error", status: 403, body: "bio_policy" },
    expect: { terminal: "blocked", tools: 0, retries: 0, artifacts: "none", contains: ["policy"] },
  }),
  clean({
    id: "provider_failures.region",
    category: "provider_failures",
    title: "Region restriction is explained",
    prompt: "Exercise the region-restricted model fixture.",
    stimulus: { kind: "error", status: 403, body: "only available in the United States" },
    expect: { terminal: "blocked", tools: 0, retries: 0, artifacts: "none", contains: ["United States"] },
  }),
  clean({
    id: "provider_failures.model-missing",
    category: "provider_failures",
    title: "Missing model fails once",
    prompt: "Exercise the missing-model fixture.",
    stimulus: { kind: "error", status: 404, body: "model_not_found" },
    expect: { terminal: "blocked", tools: 0, retries: 0, artifacts: "none", contains: ["model"] },
  }),
]

export function validateStressMatrix(items: readonly StressScenario[] = STRESS_MATRIX) {
  const ids = items.map((item) => item.id)
  const categories = new Map<StressCategory, number>(STRESS_CATEGORIES.map((category) => [category, 0]))
  for (const item of items) categories.set(item.category, (categories.get(item.category) ?? 0) + 1)
  return {
    count: items.length,
    unique: new Set(ids).size === ids.length,
    missing: STRESS_CATEGORIES.filter((category) => !categories.get(category)),
    categories: Object.fromEntries(categories),
    invalid: items.flatMap((item) => {
      const errors = [
        ...(item.id.startsWith(`${item.category}.`) ? [] : ["id/category mismatch"]),
        ...(item.prompt.trim() ? [] : ["empty prompt"]),
        ...(item.expect.excludes?.every((text) => text.trim()) ? [] : ["empty exclusion"]),
        ...(RAW_TOOL_ERRORS.every((text) => item.expect.excludes?.includes(text)) ? [] : ["raw error oracle missing"]),
      ]
      return errors.length ? [{ id: item.id, errors }] : []
    }),
  }
}
