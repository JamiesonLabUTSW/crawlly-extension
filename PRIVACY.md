# Privacy Policy - ETHOS IRB Exporter

Last updated: 2026-03-01

## Summary

ETHOS IRB Exporter processes study content from ETHOS pages to build a local export package in the user's Downloads folder.

The extension is designed for local export workflows and does not intentionally transmit data to external servers.

## Data the extension accesses

The extension may access the following data on `https://ethos.swmed.edu/*` pages:

- Study identifiers (for example, `STU...` IDs)
- SmartForm section content and related view/dialog content
- Document names and download links/actions exposed in the ETHOS UI

## Data the extension writes locally

The extension writes files to the user's local Downloads location under:

- `~/Downloads/ETHOS/<STUDY_ID>/`

This includes:

- `manifest.json`
- `export_diagnostics.json`
- `smartform/index.json`
- `smartform/<section>/segment.html`
- `smartform/<section>/view*.html`
- downloaded documents in `documents/`

## Data transmission

- The extension does not include a backend upload feature in the current release.
- The extension does not intentionally send study artifacts to third-party services.

## Data retention

- Files are stored on the user's device in Downloads until the user deletes them.
- The extension does not currently persist export content in extension storage.

## Permissions rationale

- `tabs`: identify and navigate the active ETHOS study tab.
- `scripting`: run page-context capture logic for SmartForm and Documents.
- `downloads`: save exported artifacts and documents to deterministic local paths.
- Host permission `https://ethos.swmed.edu/*`: scope page access to ETHOS only.

The extension does **not** request `history`, `storage`, `activeTab`, or `debugger`.

## Security practices

- Host scope is restricted to ETHOS domain.
- CI checks block unsafe patterns (`eval`, `new Function`, string timers, remote script tags).
- Release artifacts are generated from reviewed repository code.

## Contact

For privacy inquiries, contact the maintainer team listed in repository ownership documentation.
