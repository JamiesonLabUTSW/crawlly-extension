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
- Review terminal popup status:
  - `COMPLETED` means no warnings were recorded.
  - `COMPLETED WITH WARNINGS` means export finished, but `export_diagnostics.json` should be reviewed before upload/use.
- Review document diagnostics:
  - `documents.optionRowsDetected`
  - `documents.countStable`
  - `documents.countRetryUsed`
  - `summary.documentCountCaptured`
  - any document warnings or errors

## 5. Tag and publish

- Create git tag: `v<version>`
- Push tag to trigger packaging workflow:
  - `git push origin v<version>`
- Confirm the GitHub Release was created and contains:
  - `ethos-irb-exporter-v<version>.zip`
- Upload vetted zip to distribution channel (Chrome Web Store / Edge Add-ons / enterprise process)
- For Chrome Web Store / Edge Add-ons uploads, use the local or release artifact:
  - `dist/ethos-irb-exporter-v<version>.zip`
- Confirm the store draft shows the same version as `manifest.json` before submitting for review.

The preferred release path is tag-driven. The web UI is still fine for emergency/manual uploads, but the tag pipeline keeps version validation, packaging, and GitHub release assets reproducible.

Manual package-only run:

- Open GitHub Actions > Release Package > Run workflow.
- Leave `create_release` disabled to only produce an Actions artifact.
- Enable `create_release` only when the checked-out manifest version is final and should create/update `v<version>`.

## 6. Post-release checks

- Verify installed extension version matches intended tag.
- Verify no new warnings/errors in diagnostics on first production run.
- Monitor support channel for regressions.
