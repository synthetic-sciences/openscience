import { ComputeJobs } from "../compute/jobs"
import { MCP } from "../mcp"
import { Instance } from "../project/instance"
import { CommandRuntime } from "../science/command/registry"
import { SessionPrompt } from "../session/prompt"
import { CredentialLifecycle } from "./lifecycle"
import { CredentialProcessLedger } from "./process-ledger"
import { CredentialRevocation } from "./revocation"

/** The server-side response to a published credential revision. */
export namespace CredentialTeardown {
  export async function apply(event: Pick<CredentialLifecycle.Event, "reason">): Promise<void> {
    const target = CredentialRevocation.target(event.reason)
    if (target === "none") return
    if (target === "mcp") {
      // MCP authority is scoped to MCP transports. Do not stop unrelated
      // notebooks, compute, or shell commands when an OAuth token refreshes.
      await Instance.each(() => SessionPrompt.interrupt(new CredentialRevocation.Interruption(event.reason)))
      await Promise.all([CredentialProcessLedger.revoke("mcp"), Instance.disposeAll({ strict: true })])
      return
    }
    if (target === "overlay") {
      // The synced overlay lapsed. Only children whose spawn environment
      // carried that overlay inherited its secrets; the ledger targets them
      // exactly (and, failing closed, any entry written before the stamp
      // existed). Project instances, active model turns, language servers
      // (kernelEnv), the SSH broker and credential helpers (allowlists), and
      // every other child spawned without the overlay keep running. See
      // CredentialRevocation for why the previous global disposal was wrong.
      const reason = CredentialRevocation.message(event.reason)
      await Promise.all([
        ComputeJobs.cancelOverlayProcesses(),
        CommandRuntime.stopOverlay(reason),
        Instance.each(() => MCP.disposeOverlay()),
      ])
      return
    }
    // Compute jobs and long-running Bash commands do not live in Instance
    // state. MCP and LSP do, and their disposal callbacks close the
    // underlying transports/processes. Name the cause on every active turn
    // before disposal aborts it so the transcript records why it stopped.
    const reason = CredentialRevocation.message(event.reason)
    await Instance.each(() => SessionPrompt.interrupt(new CredentialRevocation.Interruption(event.reason)))
    await Promise.all([
      ComputeJobs.cancelCredentialProcesses(),
      CommandRuntime.stopAll(reason),
      CredentialProcessLedger.revoke("mcp"),
      Instance.disposeAll({ strict: true }),
    ])
  }
}
