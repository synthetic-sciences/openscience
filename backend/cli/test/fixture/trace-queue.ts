import { Storage } from "../../src/storage/storage"

export async function resetTraceQueue() {
  await (
    await Storage.research()
  ).transaction((db) => {
    db.exec(
      "DELETE FROM trace_binding; DELETE FROM trace_delivery; DELETE FROM trace_event; DELETE FROM trace_settings",
    )
    db.query("DELETE FROM migration WHERE name='legacy-usage-logging'").run()
  })
}
