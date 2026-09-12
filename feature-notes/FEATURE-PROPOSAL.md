# Feature proposal: plug arbitrary local skill directories into the skill library

**Status:** proposal + reference tooling · **Target:** synthetic-sciences/openscience

## Problem

`skills.paths` already exists in `openscience.json`, so skills can be loaded from
extra directories — but only **statically, at boot**. There is no way for a user
or a tool to

* ask the running server **which** skill roots are active and where each skill
  came from,
* **register or remove** a local skill directory without editing a config file
  and restarting,
* **sync / diff / vendor** a local skill collection against the server.

As a result anyone who keeps their own skill library (a private team pack, a
vendor pack, an air-gapped mirror) has to fork the project and patch the source,
which is exactly the situation this proposal removes.

### Current API surface (v2.0.93, measured)

| endpoint | state |
|:--|:--|
| `GET /skill` | lists `name, description, location, origin, permission_action, recommended, enabled` — **no content** |
| `PUT /skill/{name}` | write a skill (body: `content`) |
| `DELETE /skill/{name}` | remove a skill |
| `POST /settings/skills/install` | install from a `url` |
| `GET/POST/DELETE /skill/paths` | **absent (404)** |
| `POST /skill/reload` | **absent (404)** |
| `GET /skill?withContent=1` | parameter ignored |

## Proposal

### 1. Make skill roots first-class and introspectable

```
GET /skill/paths
-> { "paths": [
       { "path": "…/backend/cli/skills",        "kind": "builtin", "skills": 312 },
       { "path": "…/user-skills",               "kind": "user",    "skills": 295 },
       { "path": "D:/my-team-skills",           "kind": "custom",  "skills": 49 }
     ], "revision": 17 }
```

`kind` is `builtin | user | custom`, derived from how the root was registered.
`revision` increments on any change so clients can cache.

### 2. Register / unregister roots at runtime (no restart)

```
POST   /skill/paths   { "path": "D:/my-team-skills", "persist": true }
                      -> 201 { "revision": 18, "skills": 49 }
DELETE /skill/paths?path=D:/my-team-skills
                      -> 200 { "revision": 19 }
```

* the directory is **scanned immediately** and its skills become usable without
  a restart (hot reload); a `POST /skill/reload` endpoint is also useful for
  re-scanning after an out-of-band file change;
* `persist: true` appends the path to `skills.paths` in `openscience.json`, so it
  survives a restart (this is the only behaviour that needs a config write);
* reject paths that do not exist or are not directories (400), and paths already
  registered (409) rather than silently duplicating skills.

### 3. Deterministic conflict resolution

Scanning must be recursive — a real skill library nests skills under category
folders (`ml-training/unsloth-fine-tuning/SKILL.md`). When two roots expose the
same skill name:

```
priority: custom  >  user  >  builtin
```

(later-registered custom roots win over earlier ones), and the shadowed entry is
still reported by `GET /skill` with `"shadowed_by": "<path>"` so a user can see
why their edit had no effect. This is the single most confusing failure mode
today: a locally edited skill silently loses to a same-named builtin one.

### 4. Let clients sync without filesystem access

```
GET /skill?withContent=1     # include content in each entry
GET /skill/{name}/content    # or a dedicated sub-resource
```

Today the only way to read a skill's text is to follow `location` on the local
filesystem, which breaks for a remote or containerised server. Either form is
enough to make a dumb client able to vendor a whole library.

## Reference tooling (included here)

`sync-skills.js` — a dependency-free Node CLI that works against an **unmodified**
server today by reading each entry's `location`:

```
node sync-skills.js <url> list     # inventory with categories
node sync-skills.js <url> diff     # server vs local
node sync-skills.js <url> pull     # server -> local
node sync-skills.js <url> push     # local  -> server
node sync-skills.js <url> prune    # drop local skills removed upstream
```

Run it as `.cjs` (or outside the repo) when the surrounding `package.json` sets
`"type": "module"`. Once the endpoints above exist the same CLI can drop its
filesystem dependency and work against a remote server.

## Acceptance criteria

- [ ] `GET /skill/paths` reports every active root with `kind` and skill count
- [ ] `POST /skill/paths` makes a new directory's skills usable with **no restart**
- [ ] `DELETE /skill/paths` removes only that root's skills
- [ ] duplicate names resolve by the documented priority and are reported as shadowed
- [ ] `persist: true` survives a restart; the default does not touch the config file
- [ ] an empty / missing directory is a 400, not a silent no-op
- [ ] `withContent` returns the text so a remote client can vendor the library

## Backwards compatibility

`skills.paths` keeps its current meaning (a boot-time `custom` root list), so
existing configurations behave exactly as before; `GET /skill` without
`withContent` keeps its present shape.
