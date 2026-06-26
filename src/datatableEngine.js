// ============================================================================
// datatableEngine.js — Barrel re-export for the DataTable row pipeline.
//
// Parallels blueprintEngine.js / materialEngine.js. A DataTable paste is a flat
// UStruct record set (no graph), so this pipeline has no shared low-level
// walkers — it parses the struct literal directly:
//   - datatable/parser.js    text -> rows (+ looksLikeDataTable router hook)
//   - datatable/renderer.js  rows -> aligned ASCII key/value blocks
//   - datatable/analysis.js  metadata, review notes, markdown table export
// ============================================================================

export { parseDataTable, looksLikeDataTable } from "./datatable/parser.js";
export { renderDataTableASCII } from "./datatable/renderer.js";
export {
  extractDataTableMetadata, generateDataTableReviewNotes,
  generateDataTableMarkdown, deriveDataTableFilenameBase,
} from "./datatable/analysis.js";
