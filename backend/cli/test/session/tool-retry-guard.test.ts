import { expect, test } from "bun:test"
import { ToolRetryGuard } from "../../src/session/tool-retry-guard"
import type { Tool } from "../../src/tool/tool"

function history(input: {
  tool: "python" | "r"
  args: Record<string, unknown>
  error: string
  metadata?: Record<string, unknown>
  withHealthProbe?: boolean
}): Tool.Context["messages"] {
  const timeout = {
    id: "part_timeout",
    sessionID: "session_retry_guard",
    messageID: "message_timeout",
    type: "tool" as const,
    tool: input.tool,
    callID: "call_timeout",
    state: {
      status: "error" as const,
      input: input.args,
      error: input.error,
      metadata: input.metadata,
      time: { start: 1, end: 2 },
    },
  }
  const health = {
    id: "part_health",
    sessionID: "session_retry_guard",
    messageID: "message_health",
    type: "tool" as const,
    tool: input.tool,
    callID: "call_health",
    state: {
      status: "completed" as const,
      input: { code: input.tool === "python" ? "print(1)" : "cat(1)", timeout: 5_000 },
      output: "1",
      title: "Runtime health",
      metadata: { ok: true },
      time: { start: 3, end: 4 },
    },
  }
  return [
    {
      info: { id: "message_timeout", sessionID: "session_retry_guard", role: "assistant" },
      parts: [timeout],
    },
    ...(input.withHealthProbe
      ? [
          {
            info: { id: "message_health", sessionID: "session_retry_guard", role: "assistant" },
            parts: [health],
          },
        ]
      : []),
  ] as unknown as Tool.Context["messages"]
}

function context(messages: Tool.Context["messages"]): Tool.Context {
  return {
    sessionID: "session_retry_guard",
    messageID: "message_current",
    callID: "call_current",
    agent: "research",
    abort: new AbortController().signal,
    messages,
    metadata() {},
    async ask() {},
  }
}

function userMessage(sessionID: string, created: number): Tool.Context["messages"][number] {
  return {
    info: {
      id: `message_user_${sessionID}`,
      sessionID,
      role: "user",
      time: { created },
      agent: "research",
      model: { providerID: "test", modelID: "test" },
    },
    parts: [
      {
        id: `part_user_${sessionID}`,
        sessionID,
        messageID: `message_user_${sessionID}`,
        type: "text",
        text: "The strategy changed; retry now.",
      },
    ],
  } as unknown as Tool.Context["messages"][number]
}

test("kernel timeout similarity catches the P5 pandas retry but allows a raw-byte preflight", () => {
  const first = {
    environment: "python",
    code: [
      "import pandas as pd, csv, os, json",
      "for f in ['e_mtab_6701_scea_design.tsv','e_mtab_6701_scea_clusters.tsv']:",
      "    d=pd.read_csv(f,sep='\\t')",
      "    print(d.columns.tolist())",
      "    print(d.head(3).to_string())",
    ].join("\n"),
  }
  const p5Retry = {
    environment: "python",
    code: [
      "import pandas as pd",
      "for f in ['e_mtab_6701_scea_design.tsv','e_mtab_6701_scea_clusters.tsv']:",
      "    d=pd.read_csv(f,sep='\\t',nrows=10)",
      "    print(d.shape,d.columns.tolist())",
      "    print(d.head(3).to_string())",
    ].join("\n"),
  }
  const preflight = {
    environment: "python",
    code: [
      "from pathlib import Path",
      "for f in ['e_mtab_6701_scea_design.tsv','e_mtab_6701_scea_clusters.tsv']:",
      "    print(Path(f).stat().st_size)",
      "    with open(f,'rb') as handle: print(handle.readline(4096))",
    ].join("\n"),
  }

  expect(ToolRetryGuard.kernelSimilarity(first, p5Retry)).toMatchObject({
    same: true,
    sharedResources: ["e_mtab_6701_scea_design.tsv", "e_mtab_6701_scea_clusters.tsv"],
  })
  expect(ToolRetryGuard.kernelSimilarity(first, preflight).same).toBe(false)
  expect(ToolRetryGuard.kernelSimilarity(first, { environment: "different", code: first.code }).same).toBe(true)
  expect(
    ToolRetryGuard.kernelSimilarity(first, {
      environment: "different",
      code: [
        "from pandas import read_csv",
        "for f in ['e_mtab_6701_scea_design.tsv','e_mtab_6701_scea_clusters.tsv']:",
        "    d=read_csv(f,sep='\\t',nrows=10)",
        "    print(d.head(3).to_string())",
      ].join("\n"),
    }).same,
  ).toBe(true)
  expect(
    ToolRetryGuard.kernelSimilarity(first, {
      environment: "different",
      code: first.code.replaceAll("pd.read_csv", "pd.read_table"),
    }),
  ).toMatchObject({ same: true, changedStrategy: false })

  const cosmeticMarkers = {
    environment: "renamed-environment",
    code: `${p5Retry.code}\n# streaming\nnote = 'chunk_size'\nchunk_size = 1000`,
  }
  expect(ToolRetryGuard.kernelSimilarity(first, cosmeticMarkers)).toMatchObject({
    same: true,
    changedStrategy: false,
  })

  const appendedUnrelatedStrategy = {
    environment: "renamed-environment",
    code: `${first.code}\nimport polars as pl\npl.scan_csv('tiny-unrelated.csv').collect_schema()`,
  }
  expect(ToolRetryGuard.kernelSimilarity(first, appendedUnrelatedStrategy)).toMatchObject({
    same: true,
    changedStrategy: false,
  })

  const chunked = {
    environment: "renamed-environment",
    code: [
      "import pandas as pd",
      "for f in ['e_mtab_6701_scea_design.tsv','e_mtab_6701_scea_clusters.tsv']:",
      "    for chunk in pd.read_csv(f, sep='\\t', chunksize=1000):",
      "        print(chunk.shape)",
    ].join("\n"),
  }
  expect(ToolRetryGuard.kernelSimilarity(first, chunked)).toMatchObject({
    same: false,
    changedStrategy: true,
  })

  const transformed = {
    environment: "renamed-environment",
    code: "df=pd.read_csv('wide.tsv')\nresult=df.groupby('gene').sum()",
  }
  const transformedChunked = {
    environment: "renamed-environment",
    code: ["for chunk in pd.read_csv('wide.tsv', chunksize=1000):", "    result=chunk.groupby('gene').sum()"].join(
      "\n",
    ),
  }
  expect(ToolRetryGuard.kernelSimilarity(transformed, transformedChunked)).toMatchObject({
    same: false,
    changedStrategy: true,
  })

  const polars = {
    environment: "renamed-environment",
    code: "import polars as pl\nprint(pl.scan_csv('e_mtab_6701_scea_design.tsv').collect_schema())",
  }
  expect(ToolRetryGuard.kernelSimilarity(first, polars)).toMatchObject({
    same: false,
    changedStrategy: true,
  })
})

test("a successful health probe does not clear a Python timeout for the same operation", async () => {
  const args = {
    code: "import time\ntime.sleep(30)",
    source: "analysis.py",
    environment: "nbody",
    timeout: 120_000,
  }
  const annotated = ToolRetryGuard.annotateKernelTimeout(
    context([]),
    args,
    "python",
    "nbody",
    new Error("Cell execution timed out after 120s"),
  )
  expect(annotated.message).toBe("Cell execution timed out after 120s")
  expect(ToolRetryGuard.errorMetadata(annotated)).toMatchObject({
    openscienceRetryGuard: {
      kind: "failure",
      failure: { code: "kernel_timeout", environment: "nbody", timeout_ms: 120_000 },
    },
  })

  await expect(
    ToolRetryGuard.assertKernel(
      context(
        history({
          tool: "python",
          args,
          error: annotated.message,
          metadata: ToolRetryGuard.errorMetadata(annotated),
          withHealthProbe: true,
        }),
      ),
      {
        language: "python",
        environment: "nbody",
        source: "analysis.py",
        code: "import time\n# only cosmetic\ntime.sleep(30)",
      },
    ),
  ).rejects.toThrow("stopped before starting a new kernel")

  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "python", args, error: annotated.message })), {
      language: "python",
      environment: "renamed-environment",
      source: "analysis.py",
      code: "import time\n# streaming\nnote = 'chunk_size'\nchunk_size = 1000\ntime.sleep(30)",
    }),
  ).rejects.toThrow("stopped before starting a new kernel")

  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "python", args, error: annotated.message })), {
      language: "python",
      environment: "nbody",
      source: "analysis.py",
      code: "from pathlib import Path\nprint(Path('input.tsv').stat().st_size)",
    }),
  ).resolves.toBeUndefined()
})

test("the same timeout guard and changed-strategy escape apply to R", async () => {
  const args = {
    code: "d <- read.delim('wide.tsv')\nsummary(d)",
    timeout: 120_000,
  }
  const annotated = ToolRetryGuard.annotateKernelTimeout(
    context([]),
    args,
    "r",
    "r",
    new Error("Cell execution timed out after 120s"),
  )
  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "r", args, error: annotated.message })), {
      language: "r",
      environment: "r",
      code: "d <- read.delim('wide.tsv', nrows=10)\nsummary(d)",
    }),
  ).rejects.toThrow("stopped before starting a new kernel")
  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "r", args, error: annotated.message })), {
      language: "r",
      environment: "renamed-r-environment",
      code: "d <- utils::read.delim('wide.tsv', nrows=10)\nsummary(d)",
    }),
  ).rejects.toThrow("stopped before starting a new kernel")
  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "r", args, error: annotated.message })), {
      language: "r",
      environment: "renamed-r-environment",
      code: "d <- utils::read.table('wide.tsv', nrows=10)\nsummary(d)",
    }),
  ).rejects.toThrow("stopped before starting a new kernel")
  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "r", args, error: annotated.message })), {
      language: "r",
      environment: "renamed-r-environment",
      code: `${args.code}\nvroom::vroom('tiny-unrelated.tsv')`,
    }),
  ).rejects.toThrow("stopped before starting a new kernel")
  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "r", args, error: annotated.message })), {
      language: "r",
      environment: "renamed-r-environment",
      code: `${args.code}\n# streaming\nchunk_size <- 1000\nnote <- 'chunk_size'`,
    }),
  ).rejects.toThrow("stopped before starting a new kernel")
  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "r", args, error: annotated.message })), {
      language: "r",
      environment: "r",
      code: "print(file.info('wide.tsv')$size)",
    }),
  ).resolves.toBeUndefined()
  await expect(
    ToolRetryGuard.assertKernel(context(history({ tool: "r", args, error: annotated.message })), {
      language: "r",
      environment: "r",
      code: "d <- vroom::vroom('wide.tsv')\nsummary(d)",
    }),
  ).resolves.toBeUndefined()
})

test("kernel resources canonicalize cosmetic local and HTTP spellings", () => {
  const local = { environment: "python", source: "cell", code: "df = pd.read_csv('wide.tsv')" }
  for (const resource of ["./wide.tsv", "./data/../wide.tsv"]) {
    expect(
      ToolRetryGuard.kernelSimilarity(local, {
        environment: "renamed",
        source: "cell",
        code: `df = pandas.read_table('${resource}')`,
      }),
    ).toMatchObject({ same: true, sharedResources: ["wide.tsv"], changedStrategy: false })
  }

  expect(
    ToolRetryGuard.kernelSimilarity(
      { environment: "python", source: "cell", code: "pd.read_csv('HTTPS://EXAMPLE.COM:443/data.csv#old')" },
      { environment: "other", source: "cell", code: "pandas.read_table('https://example.com/data.csv')" },
    ),
  ).toMatchObject({ same: true, sharedResources: ["https://example.com/data.csv"], changedStrategy: false })

  expect(
    ToolRetryGuard.kernelSimilarity(
      { environment: "r", source: "cell", code: "d <- read.delim('./data/../wide.tsv')" },
      { environment: "renamed", source: "cell", code: "d <- utils::read.table('wide.tsv')" },
    ),
  ).toMatchObject({ same: true, sharedResources: ["wide.tsv"], changedStrategy: false })

  expect(
    ToolRetryGuard.kernelSimilarity(
      { environment: "python", source: "cell", code: "pd.read_csv('Tumor.csv')" },
      { environment: "python", source: "cell", code: "pd.read_csv('tumor.csv')" },
    ),
  ).toMatchObject({ same: false, sharedResources: [], changedStrategy: false })
})

test("bounded executable subsets authorize retained operations without cosmetic bypasses", () => {
  const fit = { environment: "python", source: "cell", code: "model.fit(X_train, y_train)" }
  expect(
    ToolRetryGuard.kernelSimilarity(fit, {
      environment: "renamed",
      source: "cell",
      code: "model.fit(X_train[:1000], y_train[:1000])",
    }),
  ).toMatchObject({ same: false, changedStrategy: true })

  const aggregate = {
    environment: "python",
    source: "cell",
    code: "result = df.groupby('gene').sum()",
  }
  expect(
    ToolRetryGuard.kernelSimilarity(aggregate, {
      environment: "python",
      source: "cell",
      code: "result = df.head(100).groupby('gene').sum()",
    }),
  ).toMatchObject({ same: false, changedStrategy: true })
  expect(
    ToolRetryGuard.kernelSimilarity(aggregate, {
      environment: "python",
      source: "cell",
      code: "result = df.sample(n=100).groupby('gene').sum()",
    }),
  ).toMatchObject({ same: false, changedStrategy: true })

  for (const cosmetic of [
    `${fit.code}\n# model.fit(X_train[:1000], y_train[:1000])`,
    `${fit.code}\nnote = 'model.fit(X_train[:1000], y_train[:1000])'`,
    `other.head(100)\n${fit.code}`,
    "model.fit(X_train, y_train, verbose=flags[0])",
    "model.fit(X_train, y_train, callbacks=[1])",
  ]) {
    expect(
      ToolRetryGuard.kernelSimilarity(fit, { environment: "renamed", source: "cell", code: cosmetic }),
    ).toMatchObject({ same: true, changedStrategy: false })
  }
})

test("URL normalization keeps resource identity but not client fragments", () => {
  expect(ToolRetryGuard.normalizeURL("HTTPS://EXAMPLE.COM:443/a/../data?q=1#first")).toBe(
    "https://example.com/data?q=1",
  )
  expect(ToolRetryGuard.normalizeURL("https://example.com/data?q=2")).not.toBe(
    ToolRetryGuard.normalizeURL("https://example.com/data?q=1"),
  )
})

test("a legacy agent-chosen cap gets exactly one same-turn disk-policy migration", async () => {
  const url = "https://www.ebi.ac.uk/gxa/sc/experiment/E-MTAB-6701/download/zip?fileType=quantification-raw"
  const legacyInput = { url, output_path: "raw.zip", max_bytes: 20_000_000 }
  const legacy = [
    {
      info: { id: "message_legacy_webfetch", sessionID: "session_legacy_webfetch", role: "assistant" },
      parts: [
        {
          id: "part_legacy_webfetch",
          sessionID: "session_legacy_webfetch",
          messageID: "message_legacy_webfetch",
          type: "tool",
          tool: "webfetch",
          callID: "call_legacy_webfetch",
          state: {
            status: "error",
            input: legacyInput,
            error:
              "Download exceeds max_bytes (19.1 MiB). Partial data was discarded; choose a smaller source or explicitly raise max_bytes within the supported limit.",
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ] as unknown as Tool.Context["messages"]
  const legacyContext = { ...context(legacy), sessionID: "session_legacy_webfetch" }
  await expect(ToolRetryGuard.assertWebFetch(legacyContext, { url, output_path: "raw.zip" })).resolves.toBeUndefined()
  await expect(ToolRetryGuard.assertWebFetch(legacyContext, { url, output_path: "raw.zip" })).rejects.toThrow(
    "already used its one same-turn migration",
  )

  const diskFailure = [
    ...legacy,
    {
      info: { id: "message_disk_webfetch", sessionID: "session_legacy_webfetch", role: "assistant" },
      parts: [
        {
          id: "part_disk_webfetch",
          sessionID: "session_legacy_webfetch",
          messageID: "message_disk_webfetch",
          type: "tool",
          tool: "webfetch",
          callID: "call_disk_webfetch",
          state: {
            status: "error",
            input: { url, output_path: "raw.zip" },
            error:
              "Download exceeds the current safe workspace capacity of 12 bytes (12 bytes); response size 13 bytes (13 bytes). " +
              "This capacity is computed from live free disk minus the 512.0 MiB (536870912 bytes) host reserve.",
            time: { start: 3, end: 4 },
          },
        },
      ],
    },
  ] as unknown as Tool.Context["messages"]
  await expect(
    ToolRetryGuard.assertWebFetch({ ...legacyContext, messages: diskFailure }, { url, output_path: "raw.zip" }),
  ).rejects.toThrow("already exceeded the live safe workspace capacity of 12 bytes")

  await expect(
    ToolRetryGuard.assertWebFetch(
      { ...legacyContext, messages: [...diskFailure, userMessage("session_legacy_webfetch", 5)] },
      { url, output_path: "raw.zip" },
    ),
  ).resolves.toBeUndefined()
})

test("a legacy default-cap failure migrates once to live disk policy without evidence", async () => {
  const target = "https://example.com/legacy-default.bin"
  const messages = [
    {
      info: { id: "message_legacy_default", sessionID: "session_legacy_default", role: "assistant" },
      parts: [
        {
          id: "part_legacy_default",
          sessionID: "session_legacy_default",
          messageID: "message_legacy_default",
          type: "tool",
          tool: "webfetch",
          callID: "call_legacy_default",
          state: {
            status: "error",
            input: { url: target, output_path: "target.bin" },
            error: "Download exceeds max_bytes (256.0 MiB). Partial data was discarded.",
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ] as unknown as Tool.Context["messages"]
  await expect(
    ToolRetryGuard.assertWebFetch(
      { ...context(messages), sessionID: "session_legacy_default" },
      { url: target, output_path: "target.bin" },
    ),
  ).resolves.toBeUndefined()
})

test("current and legacy text oversize history require a body strategy change", async () => {
  const url = "https://example.com/large.json"
  for (const [suffix, error] of [
    ["current", "Response is too large for Web fetch (6.0 MiB); the text-response limit is 5.0 MiB."],
    ["legacy", "Response too large (exceeds 5MB limit)"],
  ] as const) {
    const input = { url, format: "text" }
    const messages = [
      {
        info: { id: `message_${suffix}`, sessionID: `session_${suffix}`, role: "assistant" },
        parts: [
          {
            id: `part_${suffix}`,
            sessionID: `session_${suffix}`,
            messageID: `message_${suffix}`,
            type: "tool",
            tool: "webfetch",
            callID: `call_${suffix}`,
            state: { status: "error", input, error, time: { start: 1, end: 2 } },
          },
        ],
      },
    ] as unknown as Tool.Context["messages"]
    const ctx = { ...context(messages), sessionID: `session_${suffix}` }

    await expect(ToolRetryGuard.assertWebFetch(ctx, { url })).rejects.toThrow(
      "already exceeded the WebFetch body-response limit",
    )
    await expect(ToolRetryGuard.assertWebFetch(ctx, { url, output_path: "large.json" })).resolves.toBeUndefined()
    await expect(ToolRetryGuard.assertWebFetch(ctx, { url: `${url}?page=2` })).resolves.toBeUndefined()
  }
})

test("an identical failed patch requires a reread before another write", async () => {
  const patchText = [
    "*** Begin Patch",
    "*** Update File: analysis.py",
    "@@",
    "-missing old line",
    "+replacement",
    "*** End Patch",
  ].join("\n")
  const sessionID = "session_patch_retry"
  const messages = [
    {
      info: { id: "message_patch", sessionID, role: "assistant" },
      parts: [
        {
          id: "part_patch",
          sessionID,
          messageID: "message_patch",
          type: "tool",
          tool: "apply_patch",
          callID: "call_patch",
          state: {
            status: "error",
            input: { patchText },
            error: "apply_patch verification failed: Could not find the expected context",
            time: { start: 1, end: 2 },
          },
        },
      ],
    },
  ] as unknown as Tool.Context["messages"]
  const ctx = { ...context(messages), sessionID }

  await expect(ToolRetryGuard.assertApplyPatch(ctx, patchText)).rejects.toThrow(
    "A patch already failed verification for analysis.py",
  )
  const revised = patchText.replace("missing old line", "observed current line")
  await expect(ToolRetryGuard.assertApplyPatch(ctx, revised)).resolves.toBeUndefined()
  const reread = {
    info: { id: "message_read", sessionID, role: "assistant" },
    parts: [
      {
        id: "part_read",
        sessionID,
        messageID: "message_read",
        type: "tool",
        tool: "read",
        callID: "call_read",
        state: {
          status: "completed",
          input: { filePath: "/workspace/analysis.py", offset: 1, limit: 80 },
          output: "observed current line",
          title: "analysis.py",
          metadata: {},
          time: { start: 3, end: 4 },
        },
      },
    ],
  } as unknown as Tool.Context["messages"][number]
  await expect(
    ToolRetryGuard.assertApplyPatch({ ...ctx, messages: [...messages, reread] }, revised),
  ).resolves.toBeUndefined()
  await expect(
    ToolRetryGuard.assertApplyPatch({ ...ctx, messages: [...messages, userMessage(sessionID, 3)] }, patchText),
  ).resolves.toBeUndefined()
})
