# OpenScience implementation plans

The current release plan is
[2026-08-29-product-experience-release.md](2026-08-29-product-experience-release.md).
It owns the harness, permissions, skills, onboarding, updater, storage,
compute/connectors, billing, and release work requested on 2026-08-29.

## Historical full redesign plan

The material below is the historical implementation plan for pull request #240.
`/Users/aayambansal/Downloads/fixes.docx` is the product authority. When this
plan and that document disagree, the document wins.

The work is ordered by product value:

1. truthful Customize, connectors, and integrations;
2. calm workspace shell, responsive panes, and composer;
3. session scratch, access boundaries, kernels, and Compute;
4. immutable artifacts, Files, Review, and lifecycle;
5. packaged `test`-channel validation after each major milestone;
6. CI/CD repair and final launch gates.

Rules:

- Work and push only `aayam/kernel-science-workbench`.
- Never push or merge `main`.
- Publish npm packages only through the `test publish` workflow and `test`
  dist-tag. Never publish `latest` or production.
- Every visible control needs a real backend state transition, persisted state,
  recovery state, and test. Hide incomplete surfaces.
- Leave Atlas behavior and implementation unchanged during the redesign pass.
- Leave Memory data and implementation unchanged. Hide launch UI that implies
  Memory is ready; a later Hermes Agent / company-brain design will replace it.
- CI/CD is deliberately the final phase. Product work may temporarily leave CI
  red while focused local and packaged tests remain mandatory.

See [acceptance.md](acceptance.md) for scope and
[verification.md](verification.md) for the release loop.
