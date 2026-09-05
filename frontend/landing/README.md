# landing

Marketing site for OpenScience — the source behind [openscience.sh](https://openscience.sh).

Standalone Vite + React + Tailwind project (not part of the monorepo bun
workspace, so its deps stay isolated). The whole page is one file:
`src/pages/Landing.tsx`, styled by the scoped `src/pages/landing.css`
(monochrome editorial layout, self-hosted CMU Concrete, interactive workflow
preview, detailed research categories, and an institution marquee). Shared download-page styles remain in
`src/index.css`. Motion respects reduced-motion preferences and can be paused.

```bash
bun install
bun run dev              # local preview
bun run build            # production build → dist/
```

`public/install` is served at `openscience.sh/install`, so
`curl -fsSL https://openscience.sh/install | bash` works. The home page uses a credited archival laboratory photograph; see
`src/assets/ATTRIBUTIONS.md`. The interactive workspace panel is labeled as an
illustrative workflow, not a captured session.

`public/install-desktop` is the certificate-free macOS bootstrap. It verifies
the release checksum and app identity, installs the app in Applications,
removes the downloaded quarantine attribute, and launches the verified copy.

Merges to `main` deploy automatically through the linked Vercel project. For
a manual production deployment, run `vercel deploy --prod`.
