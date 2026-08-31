import { expect, test } from "bun:test"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"
import { Global } from "../../src/global"

test("renewal cannot conceal an intervening revocation missed by another process", async () => {
  await CredentialLifecycle.mutate("fixture-initial", () => undefined)
  let refreshed = 0
  let revoked = 0
  const off = CredentialLifecycle.onRevoke(() => {
    revoked++
  })
  const refresh = CredentialLifecycle.onRefresh(() => {
    refreshed++
  })
  try {
    const lifecycle = new URL("../../src/credentials/lifecycle.ts", import.meta.url).href
    const run = async (reason: string[]) => {
      const worker = Bun.spawn(
        [
          process.execPath,
          "-e",
          `
        import { CredentialLifecycle } from ${JSON.stringify(lifecycle)};
        for (const reason of ${JSON.stringify(reason)}) await CredentialLifecycle.mutate(reason, () => undefined);
      `,
        ],
        {
          env: { ...process.env, OPENSCIENCE_DATA_DIR: Global.Path.data },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exit, error] = await Promise.all([worker.exited, new Response(worker.stderr).text()])
      expect(error).toBe("")
      expect(exit).toBe(0)
      await CredentialLifecycle.ensureFresh()
    }
    await run(["workspace-sync.renew"])
    expect({ refreshed, revoked }).toEqual({ refreshed: 1, revoked: 0 })
    await run(["fixture-access-revoked", "workspace-sync.renew", "workspace-sync.renew"])
    expect({ refreshed, revoked }).toEqual({ refreshed: 2, revoked: 1 })
    await run(["workspace-sync.renew"])
    expect({ refreshed, revoked }).toEqual({ refreshed: 3, revoked: 1 })
  } finally {
    off()
    refresh()
  }
})

test("a failed renewal write advances revocation rather than preserving uncertain authority", async () => {
  await CredentialLifecycle.mutate("fixture-initial", () => undefined)
  let revoked = 0
  const off = CredentialLifecycle.onRevoke(() => {
    revoked++
  })
  try {
    await expect(
      CredentialLifecycle.mutate("workspace-sync.renew", () => {
        throw new Error("failed write")
      }),
    ).rejects.toThrow("failed write")
    expect(revoked).toBe(1)
  } finally {
    off()
  }
})

test("a new process still reconciles revocation when its first revision is a renewal", async () => {
  await CredentialLifecycle.mutate("fixture-initial", () => undefined)
  await CredentialLifecycle.mutate("workspace-sync.renew", () => undefined)
  const lifecycle = new URL("../../src/credentials/lifecycle.ts", import.meta.url).href
  const worker = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { CredentialLifecycle } from ${JSON.stringify(lifecycle)};
    let revoked = 0;
    CredentialLifecycle.onRevoke(() => { revoked++ });
    await CredentialLifecycle.ensureFresh();
    await CredentialLifecycle.ensureFresh();
    process.stdout.write(String(revoked));
  `,
    ],
    {
      env: { ...process.env, OPENSCIENCE_DATA_DIR: Global.Path.data },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [exit, output, error] = await Promise.all([
    worker.exited,
    new Response(worker.stdout).text(),
    new Response(worker.stderr).text(),
  ])
  expect(error).toBe("")
  expect(exit).toBe(0)
  expect(output).toBe("1")
})
