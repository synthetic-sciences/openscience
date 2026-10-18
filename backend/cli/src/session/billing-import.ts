import z from "zod"
import { Storage } from "@/storage/storage"

/** Imported provider evidence stays separate from model estimates and Wallet receipts. */
export namespace BillingImport {
  export class Conflict extends Error {}
  const Amount = z.string().regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?$/)
  const Identifier = z.string().trim().min(1).max(256)
  export const Document = z
    .object({
      schema_version: z.literal(1),
      provider: Identifier,
      account_label: z.string().trim().min(1).max(128),
      currency: z.literal("USD"),
      records: z
        .array(
          z
            .object({
              billing_id: Identifier,
              kind: z.enum(["charge", "credit"]).default("charge"),
              provider_request_id: Identifier.optional(),
              occurred_at: z.string().datetime({ offset: true }),
              model: z.string().trim().min(1).max(256).optional(),
              requested_model: z.string().trim().min(1).max(256).optional(),
              amount_usd: Amount,
            })
            .strict(),
        )
        .min(1)
        .max(10_000),
    })
    .strict()
  export const Record = z.object({
    kind: z.enum(["charge", "credit"]),
    id: z.string(),
    provider: z.string(),
    accountLabel: z.string(),
    billingID: z.string(),
    providerRequestID: z.string().optional(),
    occurredAt: z.string(),
    model: z.string().optional(),
    requestedModel: z.string().optional(),
    amountUSD: Amount,
    match: z.enum(["matched", "unmatched", "ambiguous"]),
    callID: z.string().optional(),
    sessionID: z.string().optional(),
  })
  export const Batch = z.object({
    id: z.string(),
    provider: z.string(),
    accountLabel: z.string(),
    importedAt: z.string(),
    records: z.number().int().nonnegative(),
  })
  const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
  const canonical = (value: string) => (value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value)

  export async function add(value: z.input<typeof Document>) {
    const document = Document.parse(value)
    const seen = new Set<string>()
    const records = document.records
      .map((row) => {
        const id = hash([document.provider, document.account_label, row.billing_id])
        if (seen.has(id)) throw new Conflict("A billing ID appears more than once in this import")
        seen.add(id)
        return {
          id,
          kind: row.kind,
          provider: document.provider,
          accountLabel: document.account_label,
          billingID: row.billing_id,
          ...(row.provider_request_id ? { providerRequestID: row.provider_request_id } : {}),
          occurredAt: new Date(row.occurred_at).toISOString(),
          ...(row.model ? { model: row.model } : {}),
          ...(row.requested_model ? { requestedModel: row.requested_model } : {}),
          amountUSD: canonical(row.amount_usd),
        }
      })
      .sort((a, b) => a.id.localeCompare(b.id))
    const batch = Batch.parse({
      id: hash(records),
      provider: document.provider,
      accountLabel: document.account_label,
      importedAt: new Date().toISOString(),
      records: records.length,
    })
    const store = await Storage.research()
    return store.transaction((db) => {
      const previous = db.query<{ data: string }, [string]>("SELECT data FROM billing_import WHERE id=?").get(batch.id)
      if (previous) return Batch.parse(JSON.parse(previous.data))
      for (const record of records) {
        const previous = db
          .query<{ data: string }, [string]>("SELECT data FROM billing_record WHERE id=?")
          .get(record.id)
        if (previous && previous.data !== JSON.stringify(record))
          throw new Conflict(
            "A billing record already has different evidence. Remove its existing imports before replacing it.",
          )
        db.query("INSERT INTO billing_record(id,data) VALUES (?,?) ON CONFLICT(id) DO NOTHING").run(
          record.id,
          JSON.stringify(record),
        )
      }
      db.query("INSERT INTO billing_import(id,data) VALUES (?,?)").run(batch.id, JSON.stringify(batch))
      for (const record of records)
        db.query("INSERT INTO billing_import_item(import_id,record_id) VALUES (?,?)").run(batch.id, record.id)
      return batch
    })
  }
  export async function list() {
    return (await Storage.research()).query((db) =>
      db
        .query<{ data: string }, []>("SELECT data FROM billing_import ORDER BY rowid DESC")
        .all()
        .map((row) => Batch.parse(JSON.parse(row.data))),
    )
  }
  export async function remove(id: string) {
    await (
      await Storage.research()
    ).transaction((db) => {
      db.query("DELETE FROM billing_import WHERE id=?").run(id)
      db.exec(
        "DELETE FROM billing_record WHERE NOT EXISTS (SELECT 1 FROM billing_import_item i WHERE i.record_id=billing_record.id)",
      )
    })
  }
  export async function records(start: number, end: number): Promise<z.infer<typeof Record>[]> {
    return (await Storage.research()).query((db) => {
      const rows = db
        .query<
          {
            data: string
            accounts: number
            calls: number
            callID: string | null
            sessionID: string | null
            model: string | null
          },
          [string, string]
        >(
          `SELECT r.data,
        (SELECT COUNT(DISTINCT json_extract(a.data,'$.accountLabel')) FROM billing_record a
          WHERE json_extract(a.data,'$.provider')=json_extract(r.data,'$.provider')
          AND json_extract(a.data,'$.providerRequestID')=json_extract(r.data,'$.providerRequestID')) AS accounts,
        COUNT(c.id) AS calls,MIN(c.id) AS callID,MIN(c.session_id) AS sessionID,MIN(json_extract(c.data,'$.model')) AS model
        FROM billing_record r LEFT JOIN model_call c
          ON json_extract(c.data,'$.provider')=json_extract(r.data,'$.provider')
          AND json_extract(c.data,'$.providerRequest')=json_extract(r.data,'$.providerRequestID')
          AND json_extract(c.data,'$.route') IN ('byok','custom')
        WHERE json_extract(r.data,'$.occurredAt')>=? AND json_extract(r.data,'$.occurredAt')<? GROUP BY r.id ORDER BY r.id`,
        )
        .all(new Date(start).toISOString(), new Date(end).toISOString())
      return rows.map((row) => {
        const record = Record.omit({ match: true, callID: true, sessionID: true }).parse(JSON.parse(row.data))
        if (row.accounts > 1 || row.calls > 1) return { ...record, match: "ambiguous" as const }
        const requested = record.requestedModel ?? record.model
        if (!row.callID || !row.sessionID || (requested && row.model !== requested))
          return { ...record, match: "unmatched" as const }
        return { ...record, match: "matched" as const, callID: row.callID, sessionID: row.sessionID }
      })
    })
  }
}
