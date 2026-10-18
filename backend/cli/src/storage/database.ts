import { Database } from "bun:sqlite"
import path from "node:path"
import fs from "node:fs/promises"
import { FileLease } from "@/util/file-lease"
import { DataRootBarrier } from "@/global/data-root-barrier"

/** Session records share one transaction boundary. Legacy files are retained as
 * backups, but after import the database is authoritative, including deletes. */
export namespace ResearchDatabase {
  const tables = {
    session: { scope: "project_id", depth: 3 },
    message: { scope: "session_id", depth: 3 },
    part: { scope: "message_id", depth: 3 },
    session_diff: { scope: "scope_id", depth: 2 },
    todo: { scope: "scope_id", depth: 2 },
    trace: { scope: "scope_id", depth: 2 },
    model_call: { scope: "session_id", depth: 3 },
  } as const
  type Kind = keyof typeof tables

  export function handles(key: string[]) {
    return Object.hasOwn(tables, key[0] ?? "")
  }

  function missing(key: string[]): never {
    throw Object.assign(new Error(`Research record not found: ${key.join("/")}`), {
      code: "ENOENT",
      path: key.join("/"),
    })
  }

  export function create(root: string) {
    const filepath = path.join(root, "research.sqlite")
    const legacy = path.join(root, "storage")
    const shape = (key: string[]) => {
      const kind = key[0] as Kind
      const table = tables[kind]
      if (
        !table ||
        key.length !== table.depth ||
        key.some((value) => !value || value.includes("/") || value.includes("\\") || value === "." || value === "..")
      )
        throw new Error("Invalid research record key")
      return { kind, scope: table.scope, parent: table.depth === 3 ? key[1]! : "", id: key.at(-1)! }
    }
    const save = (db: Database, key: string[], value: unknown) => {
      const record = shape(key)
      const data = JSON.stringify(value)
      if (data === undefined) throw new Error("Research records must be JSON values")
      db.query(
        `INSERT INTO ${record.kind} (${record.scope},id,data,updated_at) VALUES (?,?,?,?)
        ON CONFLICT (${record.scope},id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at`,
      ).run(record.parent, record.id, data, Date.now())
    }
    const get = <T>(db: Database, key: string[]): T | undefined => {
      const record = shape(key)
      const row = db
        .query<{ data: string }, [string, string]>(`SELECT data FROM ${record.kind} WHERE ${record.scope}=? AND id=?`)
        .get(record.parent, record.id)
      return row ? (JSON.parse(row.data) as T) : undefined
    }
    const access = async <T>(fn: (db: Database) => T): Promise<T> => {
      await using operation = await DataRootBarrier.enter(filepath)
      await fs.mkdir(root, { recursive: true })
      const db = new Database(filepath, { create: true, strict: true })
      try {
        await fs.chmod(filepath, 0o600)
        db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
        const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version
        if (version > 3) throw new Error("This research database requires a newer OpenScience version")
        if (version < 3)
          db.transaction(() => {
            db.exec(`CREATE TABLE IF NOT EXISTS migration (name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS legacy_stage (
                kind TEXT NOT NULL, parent TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
                PRIMARY KEY(kind,parent,id));`)

            for (const [kind, table] of Object.entries(tables)) {
              db.exec(`CREATE TABLE IF NOT EXISTS ${kind} (
              ${table.scope} TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),
              updated_at INTEGER NOT NULL,PRIMARY KEY (${table.scope},id))`)
            }
            db.exec(`CREATE TABLE IF NOT EXISTS trace_settings (
              id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL CHECK(json_valid(data)));
            CREATE TABLE IF NOT EXISTS trace_event (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,account TEXT NOT NULL,session_id TEXT NOT NULL,model_route TEXT NOT NULL,
              data TEXT NOT NULL CHECK(json_valid(data)),state TEXT NOT NULL CHECK(state IN ('queued','quarantined','acknowledged')),
              queued_at INTEGER NOT NULL,error TEXT);
            CREATE INDEX IF NOT EXISTS idx_trace_event_queue ON trace_event(account,state,sequence);
            CREATE INDEX IF NOT EXISTS idx_trace_event_state ON trace_event(state,queued_at,sequence);
            CREATE INDEX IF NOT EXISTS idx_trace_event_session ON trace_event(session_id,id);
            CREATE TABLE IF NOT EXISTS trace_binding (
              session_id TEXT NOT NULL,message_id TEXT NOT NULL,account TEXT NOT NULL,model_route TEXT NOT NULL,
              data TEXT NOT NULL CHECK(json_valid(data)),PRIMARY KEY(session_id,message_id));
            CREATE TABLE IF NOT EXISTS trace_delivery (
              id TEXT PRIMARY KEY,account TEXT NOT NULL,started_at INTEGER NOT NULL,completed_at INTEGER,
              status INTEGER,state TEXT NOT NULL,accepted INTEGER NOT NULL DEFAULT 0,replayed INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS trace_delivery_event (
              delivery_id TEXT NOT NULL REFERENCES trace_delivery(id) ON DELETE CASCADE,
              event_id TEXT NOT NULL REFERENCES trace_event(id) ON DELETE CASCADE,
              PRIMARY KEY(delivery_id,event_id));`)
            db.exec(`CREATE INDEX IF NOT EXISTS idx_session_parent ON session(json_extract(data,'$.parentID'));
            CREATE INDEX IF NOT EXISTS idx_part_session ON part(json_extract(data,'$.sessionID'));
            CREATE INDEX IF NOT EXISTS idx_part_call ON part(json_extract(data,'$.callID'));
            CREATE INDEX IF NOT EXISTS idx_part_model_call ON part(json_extract(data,'$.usage.call'));
            PRAGMA user_version=3;`)
          }).immediate()
        if (!db.query("SELECT 1 FROM migration WHERE name='legacy-session-records'").get()) {
          await using lease = await FileLease.acquire(`${filepath}.migration.lock`, 120_000)
          await lease.during(async () => {
            if (db.query("SELECT 1 FROM migration WHERE name='legacy-session-records'").get()) return
            db.exec("DELETE FROM legacy_stage")
            const records: { kind: string; parent: string; id: string; data: string }[] = []
            const staged = { bytes: 0 }
            const flush = () => {
              db.transaction(() => {
                const insert = db.query("INSERT INTO legacy_stage (kind,parent,id,data) VALUES (?,?,?,?)")
                for (const record of records) insert.run(record.kind, record.parent, record.id, record.data)
              }).immediate()
              records.length = 0
              staged.bytes = 0
            }
            for (const kind of Object.keys(tables)) {
              const directory = path.join(legacy, kind)
              if (
                !(await fs
                  .stat(directory)
                  .then((stat) => stat.isDirectory())
                  .catch((error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return false
                    throw error
                  }))
              )
                continue
              for await (const relative of new Bun.Glob("**/*.json").scan({ cwd: directory, onlyFiles: true })) {
                const record = shape([kind, ...relative.slice(0, -5).split(path.sep)])
                const source = path.join(directory, relative)
                const data = await Bun.file(source).text()
                await Promise.resolve()
                  .then(() => JSON.parse(data))
                  .catch((error) => {
                    throw new Error(`Cannot migrate research record ${source}; the original file is unchanged`, {
                      cause: error,
                    })
                  })
                records.push({ kind, parent: record.parent, id: record.id, data })
                staged.bytes += Buffer.byteLength(data)
                if (records.length >= 250 || staged.bytes >= 4 * 1024 * 1024) flush()
              }
            }
            flush()
            db.transaction(() => {
              for (const [kind, table] of Object.entries(tables)) {
                db.query(
                  `INSERT INTO ${kind} (${table.scope},id,data,updated_at)
                  SELECT parent,id,data,? FROM legacy_stage WHERE kind=?
                  ON CONFLICT (${table.scope},id) DO NOTHING`,
                ).run(Date.now(), kind)
              }
              db.query("INSERT INTO migration (name,completed_at) VALUES ('legacy-session-records',?)").run(Date.now())
              db.exec("DELETE FROM legacy_stage")
            }).immediate()
          })
        }
        return fn(db)
      } finally {
        // No live SQLite handle may follow the old physical root after relocation.
        db.close()
      }
    }
    return {
      filepath,
      query: <T>(fn: (db: Database) => T) => access(fn),
      transaction: <T>(fn: (db: Database) => T) => access((db) => db.transaction(fn).immediate(db)),
      migrated: (name: string) => access((db) => !!db.query("SELECT 1 FROM migration WHERE name=?").get(name)),
      importRecords: (name: string, records: { key: string[]; value: unknown }[]) =>
        access((db) =>
          db
            .transaction(() => {
              if (db.query("SELECT 1 FROM migration WHERE name=?").get(name)) return
              for (const record of records) {
                if (get(db, record.key) === undefined) save(db, record.key, record.value)
              }
              db.query("INSERT INTO migration (name,completed_at) VALUES (?,?)").run(name, Date.now())
            })
            .immediate(),
        ),
      read: <T>(key: string[]) =>
        access((db) => {
          const value = get<T>(db, key)
          return value === undefined ? missing(key) : value
        }),
      write: (key: string[], value: unknown) => access((db) => db.transaction(() => save(db, key, value)).immediate()),
      update: <T>(key: string[], fn: (value: T) => void) =>
        access((db) =>
          db
            .transaction(() => {
              const current = get<T>(db, key)
              const value = current === undefined ? missing(key) : current
              fn(value)
              save(db, key, value)
              return value
            })
            .immediate(),
        ),
      upsert: <T>(key: string[], fn: (value: T | undefined) => T) =>
        access((db) =>
          db
            .transaction(() => {
              const next = fn(get<T>(db, key))
              save(db, key, next)
              return next
            })
            .immediate(),
        ),
      remove: (key: string[]) =>
        access((db) => {
          const record = shape(key)
          db.query(`DELETE FROM ${record.kind} WHERE ${record.scope}=? AND id=?`).run(record.parent, record.id)
        }),
      list: (prefix: string[]) =>
        access((db) => {
          const kinds = prefix.length ? [prefix[0] as Kind] : (Object.keys(tables) as Kind[])
          return kinds
            .flatMap((kind) => {
              const table = tables[kind]
              if (!table) return []
              const where =
                prefix[1] === undefined
                  ? ""
                  : table.depth === 3
                    ? ` WHERE ${table.scope}=?${prefix[2] === undefined ? "" : " AND id=?"}`
                    : " WHERE id=?"
              const parameters =
                prefix[1] === undefined
                  ? []
                  : table.depth === 3 && prefix[2] !== undefined
                    ? [prefix[1], prefix[2]]
                    : [prefix[1]]
              const rows = db
                .query<{ parent: string; id: string }, string[]>(
                  `SELECT ${table.scope} AS parent,id FROM ${kind}${where}`,
                )
                .all(...parameters)
              return rows
                .map((row) => (table.depth === 3 ? [kind, row.parent, row.id] : [kind, row.id]))
                .filter((key) => prefix.every((part, index) => key[index] === part))
            })
            .sort((a, b) => a.join("/").localeCompare(b.join("/")))
        }),
    }
  }
}
