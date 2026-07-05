# docs

The OpenScience documentation and session-share site, built with [Astro Starlight](https://starlight.astro.build/).

This package is part of the bun workspace, so install dependencies from the repo root:

```bash
bun install
```

Then run the dev server:

```bash
bun run --cwd frontend/docs dev
```

Or build the site:

```bash
bun run --cwd frontend/docs build
```

Pages live in `src/content/docs/` as `.md`/`.mdx` files, each exposed as a route based on its file name.
