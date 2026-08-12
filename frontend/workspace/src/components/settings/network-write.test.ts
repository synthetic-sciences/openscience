import { describe, expect, test } from "bun:test"
import { commitNetworkState, type NetworkSettingsState } from "./network-write"

const initial: NetworkSettingsState = { allowlistEnabled: false, enabled: [], custom: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

describe("Network Settings writes", () => {
  test("serializes whole-state writes so an older response cannot overwrite a newer edit", async () => {
    let state = initial
    let saving = false
    let error: string | undefined
    let calls = 0
    const pending = deferred<NetworkSettingsState>()
    const hooks = {
      isSaving: () => saving,
      state: () => state,
      setState: (next: NetworkSettingsState) => (state = next),
      setSaving: (next: boolean) => (saving = next),
      setError: (next: string | undefined) => (error = next),
      write: async () => {
        calls++
        return pending.promise
      },
    }

    const firstState = { ...initial, allowlistEnabled: true }
    const first = commitNetworkState(firstState, hooks)
    const second = await commitNetworkState({ ...firstState, custom: ["example.org"] }, hooks)

    expect(second).toEqual({ ok: false, busy: true })
    expect(calls).toBe(1)
    expect(state).toEqual(firstState)
    expect(saving).toBe(true)
    expect(error).toBeUndefined()

    pending.resolve(firstState)
    expect(await first).toEqual({ ok: true })
    expect(saving).toBe(false)
  })

  test("restores the last confirmed state and exposes a failed write", async () => {
    let state = initial
    let saving = false
    let error: string | undefined
    const result = await commitNetworkState(
      { ...initial, custom: ["example.org"] },
      {
        isSaving: () => saving,
        state: () => state,
        setState: (next) => (state = next),
        setSaving: (next) => (saving = next),
        setError: (next) => (error = next),
        write: async () => {
          throw new Error("disk is read-only")
        },
      },
    )

    expect(result).toEqual({ ok: false, error: "disk is read-only" })
    expect(state).toEqual(initial)
    expect(saving).toBe(false)
    expect(error).toBe("disk is read-only")
  })
})
