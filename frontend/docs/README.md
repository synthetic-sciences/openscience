# OpenScience docs

The documentation site for OpenScience, the open-source AI workbench for scientific research. It ships at [openscience.sh/docs](https://openscience.sh/docs).

It is a small Vite + React app that renders a folder of MDX pages — no docs framework, no CMS, no server. Pages live in `src/content/openscience/` as `.mdx` files plus a `docs.json` that drives the sidebar. Routing is hash-based (`#/openscience/<page>`), so the whole thing is a static single-page app.

## Develop

```bash
bun install                       # from the repo root
bun run --cwd frontend/docs dev   # hot-reloads .mdx edits
```

## Build

```bash
bun run --cwd frontend/docs build      # emits dist/ with assets under /docs/
bun run --cwd frontend/docs typecheck  # tsc --noEmit
```

## Add a page

1. Create `src/content/openscience/<page>.mdx` with `title` and `description` frontmatter.
2. Add the page to `src/content/openscience/docs.json` under the right group.
3. Internal links use `/openscience/<page>`; they resolve to hash routes at build.

## Deploy

Vite `base` is `/docs/` so asset URLs resolve beneath the `/docs` path. The build command is `bun run build`, the output directory is `dist`, and deep links under `/docs` fall back to `index.html` (see `vercel.json`). Merges to `main` deploy automatically.
