# Unsliced Core

**Unsliced 家族 / Unsliced family:** [Core](https://github.com/harrythex42/unsliced-core) · [MCP](https://github.com/harrythex42/unsliced-mcp) · [Web](https://github.com/harrythex42/unsliced-web)

English · [中文](README.zh-CN.md)

Unsliced Core is the shared pagination engine for searchable, copyable PDFs. It evaluates page breaks across the whole document, keeps headings with what follows, and splits long tables only between complete rows, repeating the header.

Use the [MCP tool](https://github.com/harrythex42/unsliced-mcp) or the [web app](https://harrythex42.github.io/unsliced-web/) to convert Markdown or HTML. This repository holds the pagination source, browser and Node adapters, command-line tools, HTML samples, and experiments.

![Fixed-height slices cut a table row; Unsliced keeps the row whole](docs/images/hero-slices.png)

## Use the engine

Choose a specific [Core release](https://github.com/harrythex42/unsliced-core/releases), not `/latest`. Download `unsliced-engine.tar.gz` and `unsliced-engine.tar.gz.sha256`. Run `shasum -a 256 -c unsliced-engine.tar.gz.sha256` from their directory before extracting (`tar -xzf unsliced-engine.tar.gz`). Consumers record the release tag, full source commit, and archive SHA-256 in their repository. On upgrade, verify the archive against the pinned hash, and verify the source commit and per-file hashes in `engine/manifest.json`.

- `engine/runtime/index.global.js` exposes `BreakFlow` in the browser. See the [browser API](packages/browser/README.md).
- `engine/runtime/index.mjs` exports `generatePdf` and `DEFAULT_OPTIMAL_OPTIONS`. Install the exact `playwright` version listed in the manifest and its Chromium browser. Keep the browser bundle and `engine/assets/fonts/` in their original locations next to the Node runtime. See the [Playwright adapter](packages/playwright/README.md).

The products take the release independently; neither needs the other.

## Build, test and package

With Node.js 22+, pnpm, and Python 3:

```sh
pnpm install --frozen-lockfile
python3 -m pip install -r scripts/requirements.txt
pnpm exec playwright install chromium
pnpm acceptance
```

The 34 acceptance cases produce a [report](output/acceptance/report.md), PDFs and page images under `output/acceptance/`. The report compares page counts, whitespace, split blocks and stranded headings for both pagination strategies.

After acceptance passes, run `pnpm engine:pack` from a clean checkout. Upload the archive and checksum from `output/engine-release/` to a new GitHub release tagged at the exact commit recorded in the manifest. Don't replace assets for an existing version.

[Architecture](docs/architecture.md) · [Pagination](docs/optimal-pagination.md) · [Tables](docs/tables.md) · [Comparisons](docs/comparison/README.md) · [Experiments](experiments/web-feasibility/README.md)

Based on [BreakFlow](https://github.com/mehmetduran932/BreakFlow). See the [MIT license](LICENSE) and [font license (OFL)](packages/playwright/assets/fonts/OFL.txt).
