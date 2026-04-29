# Release Notes

## v0.2.0

- Adds SmartForm print-view capture for reviewer/edit credential contexts.
- Waits for ETHOS print progress and section counts to stabilize before export.
- Captures related `View` records and stitches them into their parent SmartForm section.
- Filters nested related-record views so question-level headings are not exported as standalone sections.
- Removes duplicate ETHOS print/screen radio and checkbox controls from exported HTML.
- Removes hidden conditional regions from exported HTML to reduce irrelevant hidden content.
- Removes obvious system/admin metadata tables from related-record exports.
- Adds SmartForm print-readiness diagnostics for section count, heading count, view-link count, and progress.
