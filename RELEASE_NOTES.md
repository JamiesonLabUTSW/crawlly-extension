# Release Notes

## v0.2.4

- Replaces existing downloaded document files on repeat exports instead of creating `(1)` duplicates.

## v0.2.3

- Promotes the v3 icon artwork to the canonical installed-extension icon filenames.
- Removes older, badge, and v3-suffixed duplicate icon assets from the package.

## v0.2.2

- Adds installed-extension icons to `manifest.json` for Chrome and Edge.
- Includes the `icons/` directory in the packaged web-store zip.

## v0.2.1

- Adds `COMPLETED WITH WARNINGS` status when an export finishes with reviewable warnings.
- Keeps normal Documents top-frame fallback as a log message instead of a warning.
- Waits for the Documents row count to stabilize before downloading.
- Reopens the Documents tab once if no document rows are detected on first count.
- Retries each failed document row once after restoring the Documents context.
- Extends Documents download-menu wait time to reduce timing-related failures.
- Adds final document completeness validation when fewer documents are captured than detected.
- Adds document-count retry/stability diagnostics to `export_diagnostics.json`.

## v0.2.0

- Adds SmartForm print-view capture for reviewer/edit credential contexts.
- Waits for ETHOS print progress and section counts to stabilize before export.
- Captures related `View` records and stitches them into their parent SmartForm section.
- Filters nested related-record views so question-level headings are not exported as standalone sections.
- Removes duplicate ETHOS print/screen radio and checkbox controls from exported HTML.
- Removes hidden conditional regions from exported HTML to reduce irrelevant hidden content.
- Removes obvious system/admin metadata tables from related-record exports.
- Adds SmartForm print-readiness diagnostics for section count, heading count, view-link count, and progress.
