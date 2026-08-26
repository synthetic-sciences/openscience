import { expect, test } from "bun:test"
import { ComputeCapabilities } from "../../src/compute/capabilities"
import { ComputeSecrets } from "../../src/compute/secrets"

test("compute secrets resolve reviewed symbolic references without persisting values", async () => {
  const fields: ComputeSecrets.Fields = async (service) =>
    service === "nvidia"
      ? { api_key: "nvapi-secret" }
      : service === "nvidia_ngc"
        ? { api_key: "ngc-secret" }
        : undefined
  expect(await ComputeSecrets.available(fields)).toEqual(["nvidia_nim", "nvidia_ngc"])
  expect(await ComputeSecrets.resolve(["nvidia_nim", "nvidia_ngc", "nvidia_nim"], fields)).toEqual({
    NVIDIA_API_KEY: "nvapi-secret",
    NGC_API_KEY: "ngc-secret",
  })
})

test("compute capability metadata does not imply private-registry support", () => {
  const capabilities = ComputeCapabilities.describe({ modal: true, hosts: [], secrets: ["nvidia_ngc"] })
  const modal = capabilities.find((target) => target.kind === "modal")
  expect(modal?.secret_refs).toEqual(["nvidia_ngc"])
  expect(modal?.private_registry).toBe(false)
  expect(modal?.persistent_volume).toBe(true)
})
