# landing

Marketing site for OpenScience — the source behind [openscience.sh](https://openscience.sh).

Standalone Vite + React + Tailwind project (not part of the monorepo bun
workspace, so its deps stay isolated). The whole page is one file:
`src/pages/Landing.tsx`, styled by `src/index.css` (warm-dark palette,
self-hosted CMU Concrete, dither/grain/atmosphere utilities, scroll reveals).

```bash
bun install
bun run dev              # local preview
bun run build            # production build → dist/
```

`public/install` is served at `openscience.sh/install`, so
`curl -fsSL https://openscience.sh/install | bash` works. Screenshots in
`src/assets/` are captured from the real workspace UI.

`public/install-desktop` is the certificate-free macOS bootstrap. It verifies
the release checksum and app identity, installs the app in Applications,
removes the downloaded quarantine attribute, and launches the verified copy.

Merges to `main` deploy automatically through the linked Vercel project. For
a manual production deployment, run `vercel deploy --prod`.
