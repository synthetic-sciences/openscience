import { describe, expect, test } from "bun:test"
import { GpuInventory } from "../../src/experiments/gpu"

describe("GpuInventory.parse", () => {
  // A row with no name is a slot, not a nameless one: the same parser already
  // treats a blank temperature cell as absent, so a blank name cell has to
  // reach the same fallback instead of rendering an empty label.
  test("falls back to the label when the name cell is blank", () => {
    const parsed = GpuInventory.parse("0, , 8192, 0, 5, 40\n")

    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.name).toBe("GPU")
  })

  test("keeps a real name", () => {
    expect(GpuInventory.parse("0, NVIDIA A100, 81920, 1024, 5, 40\n")[0]?.name).toBe("NVIDIA A100")
  })

  test("still reads a blank temperature as absent", () => {
    expect(GpuInventory.parse("0, , 8192, 0, 5, \n")[0]?.temperatureC).toBeNull()
  })
})
