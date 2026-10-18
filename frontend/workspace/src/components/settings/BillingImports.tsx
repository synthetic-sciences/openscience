import type { SettingsUsageImportsResponses, SettingsUsageBillingResponses } from "@synsci/sdk/v2/client"
import { createEffect, createSignal, For, Show, onCleanup } from "solid-js"
import { Button } from "@synsci/ui/button"
import { downloadBlob } from "@/artifacts/bytes"
import { settingsApi } from "./api"

type Batch = SettingsUsageImportsResponses[200][number]
type Record = SettingsUsageBillingResponses[200][number]

export function BillingImports(props: {
  base: string
  fetch: typeof fetch
  start: string
  end: string
  changed: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  const [batches, setBatches] = createSignal<Batch[]>([])
  const [records, setRecords] = createSignal<Record[]>([])
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  createEffect(() => {
    if (!open()) return
    const controller = new AbortController()
    refresh()
    const range = new URLSearchParams({ start: props.start, end: props.end })
    setError("")
    void Promise.all([
      settingsApi<Batch[]>(props.base, props.fetch, "/settings/usage/imports", { signal: controller.signal }),
      settingsApi<Record[]>(props.base, props.fetch, `/settings/usage/billing?${range}`, { signal: controller.signal }),
    ])
      .then(([batches, records]) => {
        if (controller.signal.aborted) return
        setBatches(batches)
        setRecords(records)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("Could not read billing imports. Please retry.")
      })
    onCleanup(() => controller.abort())
  })
  const mutate = async (init: RequestInit, suffix = "") => {
    if (busy()) return
    setBusy(true)
    setError("")
    await settingsApi(props.base, props.fetch, `/settings/usage/imports${suffix}`, init)
      .then(() => {
        setRefresh((value) => value + 1)
        props.changed()
      })
      .catch(() =>
        setError(
          "Import could not be saved or removed. Check the JSON format and conflicting billing IDs, then retry.",
        ),
      )
      .finally(() => setBusy(false))
  }
  const importFile = async (file?: File) => {
    if (!file) return
    if (file.size > 2 * 1024 * 1024) {
      setError("Choose a JSON file no larger than 2 MiB.")
      return
    }
    const document: unknown = await file
      .text()
      .then((text) => JSON.parse(text))
      .catch(() => undefined)
    if (!document) {
      setError("Choose a valid JSON billing document.")
      return
    }
    await mutate({ method: "POST", body: JSON.stringify(document) })
  }
  const template = () =>
    downloadBlob(
      "openscience-provider-billing-template.json",
      new Blob(
        [
          JSON.stringify(
            {
              schema_version: 1,
              provider: "openai",
              account_label: "Provider account label",
              currency: "USD",
              records: [
                {
                  billing_id: "replace-with-provider-billing-line-id",
                  kind: "charge",
                  provider_request_id: "replace-with-provider-request-id",
                  occurred_at: new Date().toISOString(),
                  model: "replace-with-model-id",
                  amount_usd: "0.012345",
                },
              ],
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    )
  return (
    <section class="usage-export" aria-label="Provider billing imports">
      <div>
        <strong>Provider billing imports</strong>
        <p>
          Import normalized JSON billing evidence. Files stay on this device and never change provider bills or Wallet
          charges.
        </p>
        <Button size="small" variant="secondary" onClick={() => setOpen(!open())}>
          {open() ? "Hide billing imports" : "Manage billing imports"}
        </Button>
        <Show when={open()}>
          <p>
            Use the template to convert provider exports: stable billing ID, provider ID, account label, UTC timestamp,
            exact nonnegative USD amount, charge/credit kind and optional provider request ID/model. When a billed model
            differs from the requested alias, retain it as model and add the original alias as requested_model. Only USD
            is supported; no exchange rate is inferred. Credits remain separate from charges. Maximum 2 MiB and 10,000
            records per file.
          </p>
          <Button size="small" variant="secondary" onClick={template}>
            Download billing template
          </Button>
          <label>
            Import billing JSON{" "}
            <input
              aria-label="Import billing JSON"
              type="file"
              accept=".json,application/json"
              disabled={busy()}
              onChange={(event) => {
                void importFile(event.currentTarget.files?.[0])
                event.currentTarget.value = ""
              }}
            />
          </label>
          <p>
            Matching uses exact provider/request IDs and unique local calls. The optional requested_model must match the
            saved request model; without it, model is checked instead. Account labels and alias annotations are user
            supplied and are not verified. Amounts without a unique match remain imported evidence rather than an
            assigned task charge.
          </p>
          <p>
            Selected dates: {records().filter((record) => record.match === "matched").length} matched ·{" "}
            {records().filter((record) => record.match === "unmatched").length} unmatched ·{" "}
            {records().filter((record) => record.match === "ambiguous").length} ambiguous billing records.
          </p>
          <Button
            size="small"
            variant="secondary"
            disabled={!records().length}
            onClick={() =>
              downloadBlob(
                "openscience-billing-reconciliation.json",
                new Blob([JSON.stringify(records(), null, 2)], { type: "application/json" }),
              )
            }
          >
            Export billing reconciliation
          </Button>
          <For each={batches()}>
            {(batch) => (
              <p>
                {batch.provider} · {batch.accountLabel} · {batch.records} records{" "}
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy()}
                  aria-label={`Remove import ${batch.id}`}
                  onClick={() => mutate({ method: "DELETE" }, `/${batch.id}`)}
                >
                  Remove import
                </Button>
              </p>
            )}
          </For>
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </div>
    </section>
  )
}
