# Integrating this branch with main's sandbox

## Why this file exists

`main` and `feat/kernel-package-install` independently rewrote
`backend/cli/src/sandbox/sandbox.ts`. A trial merge conflicts in 18 files. That
looks like a collision of designs and is not one: **main hardened the filesystem
model, this branch built the network model and the Windows backend.** They are
complementary, and the merge is a composition rather than a choice.

Written while the comparison was fresh. The merge will happen later and from
memory otherwise, and the good parts of main are exactly the kind of thing that
gets dropped silently in a large conflict resolution.

## State at the time of writing

- merge base: `edd58546` (5 days back)
- main ahead: 4 commits, 814 files — the substantial one is
  `07d9ff13 feat: ship the hardened scientific research harness (#284)`
- this branch ahead: 97 commits
- trial merge: 18 conflicts, including `sandbox.ts`, `tool/notebook.ts`,
  `cli/cmd/sandbox.ts`, `science/kernel/registry.ts`, `ci.yml`

## Neither side is a complete solution

|                  | main                                                     | this branch                                         |
| ---------------- | -------------------------------------------------------- | --------------------------------------------------- |
| Backends         | `seatbelt \| bubblewrap \| none` — **no Windows**        | + AppContainer, verified on real hardware and in CI |
| Network          | `network: boolean`                                       | `deny \| allowlist \| allow` + egress proxy         |
| Bounded egress   | none — its three `egress`/`allowlist` mentions are prose | the merge gate                                      |
| Filesystem model | hardened (below)                                         | basic                                               |

main cannot meet the merge gate: no Windows, no bounded egress. This branch
cannot claim session isolation: see the first takeaway.

## Take from main

### 1. Per-spawn private temp — a real hole here, not a preference

main allocates a fresh `0700` temp root per sandbox and states the reason
outright: _"Sharing one per server lets mutually untrusted projects/sessions read
and overwrite each other's temp files, even when the main workspace grants are
disjoint."_

`tempDirs()` on this branch does the opposite — it makes `os.tmpdir()` and
`$TMPDIR`/`$TMP`/`$TEMP` **writable**, i.e. the shared host temp. So two
sandboxed sessions with disjoint workspaces can read and clobber each other
through `/tmp`.

**Treat this as a merge precondition.** Nothing is shipping while the branch is
unmerged, but landing it without main's fix would introduce a session-isolation
hole that main already closes. Note the knock-on for Windows: the AppContainer
grants and the Low integrity label follow the writable list, so a per-spawn temp
root also shrinks what has to be relabelled — a smaller blast radius, not a
larger one.

### 2. Canonicalisation before spawn

main resolves policy paths and never follows the caller's lexical spelling —
TOCTOU and symlink hardening — and drops relative paths and broken symlink
ancestors fail-closed.

This branch uses `path.resolve`, which does **not** follow symlinks. That exact
gap bit this session: macOS temp is `/var/folders/...`, `/var` is a firmlink to
`/private/var`, and comparing the two spellings failed. It was fixed in
`package/installer.ts` (`same()` now realpaths) and **`sandbox.ts` still has it**.

### 3. `readableExact`

Ancestor directories enumerable while walking toward an allowed subtree, without
making their children readable. Finer-grained than this branch's single
`readable`, and the distinction matters for a resolver that has to traverse.

### 4. `cleanup()` guarded by an allocation allowlist

_"Only roots allocated by this module can be removed, so a forged Plan cannot
turn this helper into a deletion API."_ Worth copying as a habit, not just as
code. The same `process.once("exit")` shape is already used here for restoring
the Windows integrity label.

## Keep from this branch

- The tri-state `network` policy and `Egress` proxy — the merge gate depends on it
- `src/sandbox/appcontainer.ts` and the Windows backend, with everything measured
  in `windows-egress-design.md`
- `Shell.invocation`/`Shell.family` — cmd.exe takes `/c`, and has no `printf`
- Case-insensitive kernel env filtering — Windows presents `Path`, `SystemRoot`
- The Windows CI job and its live tests

## Shape of the merge

Take main's non-sandbox changes wholesale. In `sandbox.ts`, start from **main's**
`Policy` and path handling, then re-apply this branch's additions on top:
`network` widened from boolean to the tri-state, `egress`, `profile`,
`capabilities`, and the `appcontainer` backend. `tool/notebook.ts` and
`science/kernel/registry.ts` need reconciling by hand — main's harness work is
substantial there and this branch's changes to those files are incidental by
comparison.

## Talk to Ishaan first

`#284` reworked `sandbox.ts` with no reference to this branch, which suggests
the two efforts were not aware of each other. Agreeing the composition above
before either side writes more code on the file is cheaper than resolving it
twice.
