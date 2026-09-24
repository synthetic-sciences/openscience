import { expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"

const original: Auth.Oauth = {
  type: "oauth",
  access: "expired-access",
  refresh: "original-refresh",
  expires: 1,
  accountId: "original-account",
}
const renewed: Auth.Oauth = {
  ...original,
  access: "fresh-access",
  refresh: "rotated-refresh",
  expires: Date.now() + 60_000,
}

test("OAuth renewal refreshes caches without revoking live work; replacing or removing still revokes", async () => {
  const provider = `oauth-${crypto.randomUUID()}`
  await Auth.set(provider, original)
  let refreshes = 0
  let revocations = 0
  const refresh = CredentialLifecycle.onRefresh(() => {
    refreshes++
  })
  const revoke = CredentialLifecycle.onRevoke(() => {
    revocations++
  })
  try {
    expect(await Auth.renew(provider, original, renewed)).toBe(true)
    expect(await Auth.get(provider)).toEqual(renewed)
    expect({ refreshes, revocations }).toEqual({ refreshes: 1, revocations: 0 })
    await Auth.set(provider, renewed)
    expect(revocations).toBe(1)
    await Auth.remove(provider)
    expect(revocations).toBe(2)
  } finally {
    refresh()
    revoke()
    await Auth.remove(provider)
  }
})

test.each(["logout", "replacement", "rotation"])("a late OAuth renewal cannot undo %s", async (change) => {
  const provider = `oauth-${crypto.randomUUID()}`
  await Auth.set(provider, original)
  const replacement = { ...renewed, accountId: "replacement-account" }
  try {
    if (change === "logout") await Auth.remove(provider)
    if (change === "replacement") await Auth.set(provider, replacement)
    if (change === "rotation") await Auth.renew(provider, original, renewed)
    const revision = await Bun.file(CredentialLifecycle.revisionPath()).text()
    expect(await Auth.renew(provider, original, { ...renewed, access: "late-access" })).toBe(false)
    expect(await Bun.file(CredentialLifecycle.revisionPath()).text()).toBe(revision)
    if (change === "logout") expect(await Auth.get(provider)).toBeUndefined()
    if (change !== "logout") expect(await Auth.get(provider)).toEqual(change === "replacement" ? replacement : renewed)
  } finally {
    await Auth.remove(provider)
  }
})

test("OAuth renewal refuses a changed account or enterprise", async () => {
  const provider = `oauth-${crypto.randomUUID()}`
  await Auth.set(provider, original)
  try {
    await expect(Auth.renew(provider, original, { ...renewed, accountId: "another" })).rejects.toThrow(
      "changed the connected account",
    )
    await expect(
      Auth.renew(provider, original, { ...renewed, enterpriseUrl: "https://another.example" }),
    ).rejects.toThrow("changed the connected account")
    expect(await Auth.get(provider)).toEqual(original)
  } finally {
    await Auth.remove(provider)
  }
})
