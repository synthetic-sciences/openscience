import { describe, expect, test } from "bun:test"
import { createKernelRouteRequester, kernelAPI, requestKernelRoute, type KernelTransport } from "./kernel-api"

const response = (status: number, body = String(status)) => new Response(body, { status })

describe("kernel API compatibility", () => {
  test("uses the canonical route first and stops after a successful response", async () => {
    const calls: string[] = []
    const request: KernelTransport = async (path) => {
      calls.push(path)
      return response(200, "canonical")
    }

    const result = await requestKernelRoute(request, kernelAPI.inventory)

    expect(calls).toEqual(["/kernels"])
    expect(await result.text()).toBe("canonical")
  })

  test("retries the corresponding notebook route only after a 404", async () => {
    const calls: Array<{ path: string; init?: RequestInit; query?: Record<string, string> }> = []
    const request: KernelTransport = async (path, init, query) => {
      calls.push({ path, init, query })
      return path.startsWith("/kernels") ? response(404, "Not Found") : response(200, "legacy")
    }
    const init = { method: "POST", body: JSON.stringify({ sessionID: "ses_1" }) }
    const query = { client: "tab-1" }

    const result = await requestKernelRoute(request, kernelAPI.control("kernel/1", "restart"), init, query)

    expect(calls).toEqual([
      { path: "/kernels/kernel%2F1/restart", init, query },
      { path: "/notebook/kernels/kernel%2F1/restart", init, query },
    ])
    expect(await result.text()).toBe("legacy")
  })

  test("does not hide non-404 server failures behind a legacy retry", async () => {
    const calls: string[] = []
    const request: KernelTransport = async (path) => {
      calls.push(path)
      return response(503, "registry unavailable")
    }

    const result = await requestKernelRoute(request, kernelAPI.commands)

    expect(calls).toEqual(["/kernels/commands"])
    expect(result.status).toBe(503)
    expect(await result.text()).toBe("registry unavailable")
  })

  test("does not retry transport failures", async () => {
    const calls: string[] = []
    const request: KernelTransport = async (path) => {
      calls.push(path)
      throw new Error("offline")
    }

    await expect(requestKernelRoute(request, kernelAPI.compute("tab 1"))).rejects.toThrow("offline")
    expect(calls).toEqual(["/kernels/compute?client=tab%201"])
  })

  test("pairs every Compute route with its supported notebook equivalent", () => {
    expect(kernelAPI.inventory).toEqual(["/kernels", "/notebook/kernels"])
    expect(kernelAPI.commands).toEqual(["/kernels/commands", "/notebook/commands"])
    expect(kernelAPI.compute("tab/1")).toEqual(["/kernels/compute?client=tab%2F1", "/notebook/compute?client=tab%2F1"])
    expect(kernelAPI.stopCommand("command/1")).toEqual([
      "/kernels/commands/command%2F1/stop",
      "/notebook/commands/command%2F1/stop",
    ])
  })

  test("remembers a legacy discovery route after its first confirmed miss", async () => {
    const calls: string[] = []
    const request = createKernelRouteRequester(async (path) => {
      calls.push(path)
      return path.startsWith("/notebook/") ? response(200, "legacy") : response(404, "Not Found")
    })

    expect((await request(kernelAPI.compute("tab"))).status).toBe(200)
    expect((await request(kernelAPI.compute("tab"))).status).toBe(200)
    expect(calls).toEqual([
      "/kernels/compute?client=tab",
      "/notebook/compute?client=tab",
      "/notebook/compute?client=tab",
    ])
  })

  test("re-probes the canonical discovery route once the remembered miss expires", async () => {
    const calls: string[] = []
    const clock = { now: 0 }
    const request = createKernelRouteRequester(
      async (path) => {
        calls.push(path)
        return path.startsWith("/notebook/") ? response(200, "legacy") : response(404, "Not Found")
      },
      { ttl: 1_000, now: () => clock.now },
    )

    await request(kernelAPI.inventory)
    clock.now = 999
    await request(kernelAPI.inventory)
    clock.now = 1_000
    await request(kernelAPI.inventory)

    expect(calls).toEqual(["/kernels", "/notebook/kernels", "/notebook/kernels", "/kernels", "/notebook/kernels"])
  })

  test("does not cache a missing runtime control as backend version evidence", async () => {
    const calls: string[] = []
    const request = createKernelRouteRequester(async (path) => {
      calls.push(path)
      return response(404, "missing runtime")
    })
    const route = kernelAPI.control("gone", "stop")

    await request(route)
    await request(route)

    expect(calls).toEqual([route[0], route[1], route[0], route[1]])
  })
})
