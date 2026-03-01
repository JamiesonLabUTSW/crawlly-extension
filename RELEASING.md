# Release Process

## 1. Prepare release branch / PR

- Ensure all changes are merged and CI is green.
- Confirm permission model in `manifest.json` is unchanged or explicitly approved.

## 2. Version bump

- Update `version` in `manifest.json`.
- Keep `package.json` version aligned if you use it for metadata.

## 3. Local validation

Run:

- `npm ci`
- `npm run ci`
- `npm run pack`

Expected artifact:

- `dist/ethos-irb-exporter-v<version>.zip`

## 4. Functional smoke test

In a clean browser profile:

- Load unpacked extension.
- Run export on a known ETHOS study.
- Enforce operating constraints during test:
  - Only one export job at a time.
  - No unrelated downloads during export.
  - Keep the ETHOS tab open through terminal state.
- Verify generated files:
  - `manifest.json`
  - `export_diagnostics.json`
  - `smartform/index.json`
  - expected `smartform/*` and `documents/*`

## 5. Tag and publish

- Create git tag: `v<version>`
- Push tag to trigger packaging workflow
- Upload vetted zip to distribution channel (Chrome Web Store / Edge Add-ons / enterprise process)

## 6. Post-release checks

- Verify installed extension version matches intended tag.
- Verify no new warnings/errors in diagnostics on first production run.
- Monitor support channel for regressions.
