# landing

Marketing site for OpenScience — the source behind [openscience.sh](https://openscience.sh).

Standalone Vite + React + Tailwind project (not part of the monorepo bun
workspace, so its deps stay isolated). The home page is `src/pages/Landing.tsx`;
`src/pages/Download.tsx` provides the platform downloads and terminal install.
The download page has two centered sections: desktop downloads and terminal
installation, followed by the shared footer. Both pages use the monochrome editorial styles in `src/pages/landing.css`, with
additional download styles in `src/pages/download.css`. Shared branding,
navigation, footer, and Ace offer live in `src/components/`.

The home page includes an interactive workflow preview, detailed research
categories, an expandable database grid, and an institution marquee. A searchable
model-picker preview uses a curated set of identities from the client catalog;
selection updates its illustrative composer without making inference requests. Motion
respects reduced-motion preferences and can be paused. Ace appears on the home page and links to the
Synthetic Sciences account billing page; its offer describes usage billing
and the fixed Wallet reload, not a monthly subscription.

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
