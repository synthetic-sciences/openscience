import { expect, spyOn, test } from "bun:test"
import { ManagedEnvironments } from "../../src/science/kernel/environment-manager"
import { ComputeSettingsRoutes } from "../../src/server/routes/settings/compute"

// Repair used to let a starter failure escape as a bare 500, so the person
// clicking "Set up or repair" on Windows saw "Internal Server Error" and not
// the R error that explained it (#704).
test("a starter that cannot be set up answers 409 with the interpreter's own reason", async () => {
  const reason =
    "r starter environment failed its import probe: Error in library(tidyverse) : there is no package called 'tidyverse'"
  const repair = spyOn(ManagedEnvironments, "repair").mockRejectedValue(new Error(reason))
  try {
    const response = await ComputeSettingsRoutes().request("/environments/repair", { method: "POST" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: "environment_setup_failed", message: reason })
    expect(repair).toHaveBeenCalledTimes(1)
  } finally {
    repair.mockRestore()
  }
})
