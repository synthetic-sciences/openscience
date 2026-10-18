import z from "zod"
import { OpenScience } from "@/openscience"
import { managedApiBase } from "@/endpoints"
import { Storage } from "@/storage/storage"
import { CallAudit } from "./call-audit"

export namespace TaskReceipts {
  const Receipt = z.object({
    receipt_id: z.string(),
    hold_id: z.string(),
    charged_microusd: z
      .string()
      .max(20)
      .regex(/^[0-9]+$/),
    settled_at: z.string().datetime({ offset: true }),
    provider: z.string(),
    model: z.string(),
  })
  const Call = z.object({
    call_id: z.string().uuid(),
    state: z.enum(["missing", "pending", "not_charged", "settled", "inconsistent", "unknown"]),
    hold_id: z.string().nullable(),
    receipt_id: z.string().nullable(),
  })
  const Remote = z.object({
    schema_version: z.literal(1),
    checked_at: z.string().datetime({ offset: true }),
    calls: Call.array(),
    receipts: Receipt.array(),
  })
  export const Info = z.object({
    rootSessionID: z.string(),
    sessions: z.number().int().nonnegative(),
    managedCalls: z.number().int().nonnegative(),
    missingCallIDs: z.number().int().nonnegative(),
    state: z.enum(["available", "unavailable"]),
    reason: z
      .enum(["signed_out", "unsupported", "unauthorized", "server_unavailable", "invalid_report", "account_changed"])
      .optional(),
    checkedAt: z.string().datetime({ offset: true }).optional(),
    chargedMicrousd: z
      .string()
      .regex(/^[0-9]+$/)
      .optional(),
    calls: Call.array(),
    receipts: Receipt.array(),
  })

  export async function check(rootSessionID: string): Promise<z.infer<typeof Info>> {
    const audit = await CallAudit.report(rootSessionID)
    const managed = audit.calls.filter((call) => call.route === "managed")
    const identifiers = [
      ...new Set(
        managed.flatMap((call) => (z.string().uuid().safeParse(call.httpCall).success ? [call.httpCall!] : [])),
      ),
    ]
    const info: z.infer<typeof Info> = {
      rootSessionID,
      sessions: audit.sessions.length,
      managedCalls: managed.length,
      missingCallIDs: managed.filter((call) => !z.string().uuid().safeParse(call.httpCall).success).length,
      state: "unavailable",
      calls: [],
      receipts: [],
    }
    const account = await OpenScience.getSession()
    if (!account?.user_id) return { ...info, reason: "signed_out" }
    const base = managedApiBase()
    const same = async () => {
      const current = await OpenScience.getSession()
      return (
        current?.api_key === account.api_key &&
        current?.user_id === account.user_id &&
        current?.organization_id === account.organization_id &&
        managedApiBase() === base
      )
    }
    const receipts = new Map<string, z.infer<typeof Receipt>>()
    const calls: z.infer<typeof Call>[] = []
    const times: string[] = []
    for (let offset = 0; offset < identifiers.length; offset += 128) {
      const batch = identifiers.slice(offset, offset + 128)
      const response = await fetch(`${base}/api/credits/call-receipts`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: {
          Authorization: `Bearer ${account.api_key}`,
          "Content-Type": "application/json",
          ...(account.organization_id ? { "X-Organization-ID": account.organization_id } : {}),
        },
        body: JSON.stringify({ call_ids: batch }),
      }).catch(() => undefined)
      if (!(await same())) {
        await response?.body?.cancel().catch(() => undefined)
        return { ...info, reason: "account_changed" }
      }
      if (!response) return { ...info, reason: "server_unavailable" }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return {
          ...info,
          reason:
            response.status === 404
              ? "unsupported"
              : response.status === 401 || response.status === 403
                ? "unauthorized"
                : "server_unavailable",
        }
      }
      const result = Remote.safeParse(await response.json().catch(() => undefined))
      if (!result.success) return { ...info, reason: "invalid_report" }
      const report = result.data
      const ids = new Set(report.calls.map((call) => call.call_id))
      const charges = new Map(report.receipts.map((receipt) => [receipt.receipt_id, receipt]))
      if (
        ids.size !== batch.length ||
        report.calls.length !== batch.length ||
        batch.some((id) => !ids.has(id)) ||
        charges.size !== report.receipts.length ||
        report.calls.some((call) =>
          call.state === "settled"
            ? !call.receipt_id || charges.get(call.receipt_id)?.hold_id !== call.hold_id
            : call.receipt_id !== null,
        ) ||
        report.receipts.some((receipt) => !report.calls.some((call) => call.receipt_id === receipt.receipt_id))
      ) {
        return { ...info, reason: "invalid_report" }
      }
      for (const receipt of report.receipts) {
        const previous = receipts.get(receipt.receipt_id)
        if (previous && JSON.stringify(previous) !== JSON.stringify(receipt))
          return { ...info, reason: "invalid_report" }
        receipts.set(receipt.receipt_id, receipt)
      }
      calls.push(...report.calls)
      times.push(report.checked_at)
    }
    if (!(await same())) return { ...info, reason: "account_changed" }
    const result: z.infer<typeof Info> = {
      ...info,
      state: "available",
      calls,
      receipts: [...receipts.values()],
      checkedAt: times.sort()[0] ?? new Date().toISOString(),
      chargedMicrousd: [...receipts.values()]
        .reduce((sum, receipt) => sum + BigInt(receipt.charged_microusd), 0n)
        .toString(),
    }
    const scope = new Bun.CryptoHasher("sha256")
      .update(JSON.stringify([base, account.user_id, account.organization_id ?? null]))
      .digest("hex")
    const store = await Storage.research()
    await store.transaction((db) => {
      for (const receipt of result.receipts)
        db.query(
          `INSERT INTO charge(account_id,id,data,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(account_id,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
        ).run(scope, receipt.receipt_id, JSON.stringify(receipt), Date.now())
      db.query(
        `INSERT INTO task_receipt(account_id,id,data,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(account_id,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      ).run(scope, rootSessionID, JSON.stringify(result), Date.now())
    })
    if (!(await same())) return { ...info, reason: "account_changed" }
    return result
  }
}
