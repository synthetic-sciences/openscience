# landing

Marketing site for OpenScience — the source behind [openscience.sh](https://openscience.sh).

Standalone Vite + React project (not part of the monorepo bun workspace, so
its deps stay isolated). The layout follows opencode.ai (one bordered page
column, sticky header, 4rem section rhythm) set in CMU Concrete: Roman for
text, Bold for titles, so the pages read like a preprint. The site is dark
only; a hairline diagonal grid fills the space outside the page column.

| Route       | File                     | What                                                                    |
| ----------- | ------------------------ | ----------------------------------------------------------------------- |
| `/`         | `src/pages/Landing.tsx`  | Hero, install tabs, workspace replica, what it is, benchmarks, Ace, FAQ |
| `/download` | `src/pages/Download.tsx` | Desktop installers, CLI installs, integrations, FAQ                     |
| `/ace`      | `src/pages/Ace.tsx`      | Managed models: pricing, how it works, the roster (Table 1), FAQ        |
| `/privacy`  | `src/pages/Privacy.tsx`  | What stays local, what leaves, traces, consent, deletion                |

Routing is a path switch in `src/main.tsx`; `vercel.json` rewrites every
path to `index.html`. Shared pieces live in `src/components/` (header,
footer, FAQ, copy buttons, provider marks, the SVG workspace replica). All
styling is `src/index.css`, scoped by `data-page` and `data-component`
attributes.

Things to keep current:

- `src/data/benchmarks.ts` holds every benchmark number on the home page and
  a `PRELIMINARY` flag that controls the footnote wording.
- `src/pages/Ace.tsx` mirrors `backend/cli/src/provider/managed-catalog.ts`.
- `src/components/Workspace.tsx` is a pixel replica of the product in its own
  font (Inter Variable) and tokens, standing in for a product video. Swap it
  for a `<video>` in `Landing.tsx` when a recording exists.
- `public/provider-logos.svg` is the same sprite the dashboard ships.
- Fonts under `public/fonts/` are CMU Concrete (OFL, `OFL-cmu.txt`) for the
  site and Inter Variable (OFL, `OFL-inter.txt`) for the product replica.

```bash
bun install
bun run dev              # local preview on :8080
bun run build            # builds ../docs first, then this site → dist/
```

`public/install` is served at `openscience.sh/install`, so
`curl -fsSL https://openscience.sh/install | bash` works.
`public/install-desktop` is the certificate-free macOS bootstrap. It verifies
the release checksum and app identity, installs the app in Applications,
removes the downloaded quarantine attribute, and launches the verified copy.

Merges to `main` deploy automatically through the linked Vercel project. For
a manual production deployment, run `vercel deploy --prod`.
