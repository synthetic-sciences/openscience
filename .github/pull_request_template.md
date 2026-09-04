<!-- Title: conventional commit prefix, e.g. `fix(app): ...`, `feat(skills): ...`, `docs: ...` -->

### What does this PR do, and why?

### Linked issue

<!-- `Fixes #123`, or "small fix, no issue" for typos, docs, and broken skill/connector repairs -->

### How did you verify it?

<!-- Commands you ran, what you observed, and how a reviewer can reproduce it -->

### Checklist

- [ ] `bun run check` is green (format, typecheck, backend + frontend/ui + SDK tests)
- [ ] `bun run --cwd frontend/workspace build` succeeds if I touched `frontend/workspace` or `frontend/ui`
- [ ] `./tooling/repo/generate.ts` was run and the `tooling/sdk` output committed if I changed `backend/cli/src/server`
- [ ] CHANGELOG.md has an **Unreleased** entry if the change is user-visible
- [ ] The matching docs page under `frontend/docs/src/content/openscience/` is updated if behavior changed
- [ ] Screenshots or a short video are attached for UI changes
- [ ] No version bumps (`package.json` versions and tags are written by the release workflow)
- [ ] `install` and `frontend/landing/public/install` are still byte-identical if I touched either
