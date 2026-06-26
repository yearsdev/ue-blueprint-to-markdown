// ============================================================================
// datatable/renderer.js — DataTable rows -> ASCII.
//
// A data table has no graph to walk; it's a flat record set. We render each row
// as an aligned key/value block, which stays readable whether the paste is one
// row or many (a wide N-column ASCII grid would be unreadable for the 20+ field
// structs these tables typically carry — the columnar view is reserved for the
// markdown export, which scrolls). Rows are separated by a rule, matching the
// material renderer's multi-root separator.
// ============================================================================

import { formatValue } from "./parser.js";

function renderRowBlock(row) {
  const lines = ["● " + row.name];
  const keyW = row.entries.reduce((w, e) => Math.max(w, e.key.length), 0);
  for (const e of row.entries) {
    lines.push("  " + e.key.padEnd(keyW) + "  " + (formatValue(e.value) || "—"));
  }
  return lines.join("\n");
}

export function renderDataTableASCII(parsed) {
  const { rows } = parsed;
  if (!rows.length) return "(no data table rows parsed)";
  return rows.map(renderRowBlock).join("\n\n" + "─".repeat(40) + "\n\n");
}
