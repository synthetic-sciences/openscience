import z from "zod"
import { OpenScience } from "@/openscience"
import { managedApiBase } from "@/endpoints"
import { UsageLogging } from "./usage-logging"

export namespace LoggingHealth {
  const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  export const Report = z
    .object({
      schema_version: z.literal(1),
      scope: z.literal("account_installation_workspace"),
      since: z.string().datetime({ offset: true }),
      until: z.string().datetime({ offset: true }),
      checked_at: z.string().datetime({ offset: true }),
      status: z.enum(["healthy", "attention", "no_data", "incomplete"]),
      receipts: z.object({ deliveries: Count, anomalous: Count, orphaned_events: Count }),
      usage: z.object({
        responses: Count,
        projected: Count,
        missing_projection: Count,
        unknown_input: Count,
        unknown_output: Count,
        unknown_reasoning: Count,
        unknown_cache_read: Count,
        unknown_cache_write: Count,
      }),
      managed: z.object({
        responses: Count,
        pending: Count,
        settled: Count,
        not_charged: Count,
        missing_call_id: Count,
        missing_link: Count,
        ambiguous_link: Count,
        missing_hold: Count,
        hold_mismatch: Count,
        settled_missing_charge: Count,
        duplicate_charge: Count,
        token_mismatch: Count,
        charge_amount_mismatch: Count,
        unknown_charge_amount: Count,
      }),
    })
    .refine((value) => {
      const duration = Date.parse(value.until) - Date.parse(value.since)
      return duration > 0 && duration <= 86_400_000
    }, "Server report must cover at most 24 hours")
  export const Result = z.discriminatedUnion("state", [
    z.object({ state: z.literal("available"), report: Report }),
    z.object({
      state: z.literal("unavailable"),
      reason: z.enum([
        "signed_out",
        "unsupported",
        "unauthorized",
        "server_unavailable",
        "invalid_report",
        "account_changed",
      ]),
    }),
  ])

  export async function check(): Promise<z.infer<typeof Result>> {
    const session = await OpenScience.getSession()
    if (!session?.user_id) return { state: "unavailable", reason: "signed_out" }
    const base = managedApiBase()
    const url = new URL(`${base}/api/v1/telemetry/health`)
    url.searchParams.set("installation_id", await UsageLogging.installationID())
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${session.api_key}`,
        ...(session.organization_id ? { "X-Organization-ID": session.organization_id } : {}),
      },
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    }).catch(() => undefined)
    if (!response) return { state: "unavailable", reason: "server_unavailable" }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return {
        state: "unavailable",
        reason:
          response.status === 404
            ? "unsupported"
            : response.status === 401 || response.status === 403
              ? "unauthorized"
              : "server_unavailable",
      }
    }
    const parsed = Report.safeParse(await response.json().catch(() => undefined))
    const current = await OpenScience.getSession()
    if (
      current?.api_key !== session.api_key ||
      current?.user_id !== session.user_id ||
      current?.organization_id !== session.organization_id ||
      managedApiBase() !== base
    ) {
      await response?.body?.cancel().catch(() => undefined)
      return { state: "unavailable", reason: "account_changed" }
    }
    return parsed.success
      ? { state: "available", report: parsed.data }
      : { state: "unavailable", reason: "invalid_report" }
  }
}
