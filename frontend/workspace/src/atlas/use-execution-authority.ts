import { useParams } from "@solidjs/router"
import { createMemo, createResource, createSignal, onCleanup, type Accessor } from "solid-js"
import { useSDK } from "@/context/sdk"
import {
  createExecutionAuthorityAPI,
  executionAuthorityError,
  executionAuthorityMessage,
  type ExecutionCapability,
} from "./execution-authority"

export function useExecutionAuthority(capability: ExecutionCapability | Accessor<ExecutionCapability>) {
  const sdk = useSDK()
  const params = useParams()
  const api = createExecutionAuthorityAPI(sdk.request)
  const current = () => (typeof capability === "function" ? capability() : capability)
  const input = createMemo(() => {
    const projectID = sdk.projectID
    const sessionID = params.id
    if (!projectID || !sessionID || sessionID === "new") return
    return { projectID, sessionID, capability: current() }
  })
  const [decision, controls] = createResource(input, api.inspect)
  const [trusting, setTrusting] = createSignal(false)
  const refresh = () => {
    if (!input()) return
    void controls.refetch()
  }
  const trust = sdk.event.on("project.trust.changed", (event) => {
    if (event.properties.status.projectID !== sdk.projectID) return
    refresh()
  })
  const grant = sdk.event.on("session.filesystem.changed", (event) => {
    if (event.properties.sessionID !== params.id) return
    refresh()
  })
  onCleanup(trust)
  onCleanup(grant)

  const message = createMemo(() => {
    if (!params.id || params.id === "new") return "Save this session before starting a process."
    if (!sdk.projectID) return "Execution access is unavailable until the project is ready."
    if (decision.error) return executionAuthorityError(decision.error)
    if (decision.loading) return "Checking execution access…"
    const value = decision()
    if (!value) return "Checking execution access…"
    return executionAuthorityMessage(value)
  })
  const allowed = createMemo(() => {
    if (decision.error || decision.loading) return false
    const expected = input()
    const value = decision()
    if (!expected || !value) return false
    return (
      value.allowed &&
      value.projectID === expected.projectID &&
      value.sessionID === expected.sessionID &&
      value.capability === expected.capability
    )
  })
  const canTrust = createMemo(() => {
    const value = decision()
    return !decision.error && !decision.loading && value?.reason === "project_untrusted" && !!value.remediation
  })
  const trustProject = async () => {
    const value = decision()
    if (!value || !canTrust() || trusting()) throw new Error("Project trust is not currently available.")
    setTrusting(true)
    try {
      await api.trust(value)
      await controls.refetch()
    } finally {
      setTrusting(false)
    }
  }

  return {
    decision,
    allowed,
    loading: () => decision.loading,
    message,
    canTrust,
    trusting,
    trust: trustProject,
    refetch: refresh,
  }
}
