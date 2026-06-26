// ============================================================================
// datatable/analysis.js — metadata, review notes, and markdown export for the
// DataTable pipeline. Mirrors material/analysis.js so the editor drives all
// three engines through one call shape.
//
// The markdown export is the documentation artifact: rows always render as one
// columnar table — field names as the header, one line per record — so a paste
// reads like the data table it came from, whether it's one row or many.
// ============================================================================

import { formatValue } from "./parser.js";

export function deriveDataTableFilenameBase(parsed, explicitName) {
  if (explicitName && explicitName.trim()) return explicitName.trim();
  if (parsed.structName) return parsed.structName;
  if (parsed.rows.length === 1) return parsed.rows[0].name;
  return "datatable";
}

export function extractDataTableMetadata(parsed) {
  return {
    graphType: "datatable",
    functionName: parsed.structName || "",
    component: "",
    nodeCount: parsed.rows.length,
    rowCount: parsed.rows.length,
    fields: parsed.fields,
    // No variableRefs — the editor guards on its presence, keeping the var
    // counter hidden for data tables.
  };
}

export function generateDataTableReviewNotes(parsed) {
  const notes = [];
  const { rows, fields } = parsed;

  const counts = new Map();
  for (const r of rows) counts.set(r.name, (counts.get(r.name) || 0) + 1);
  const dups = [...counts].filter(([, c]) => c > 1).map(([n]) => n);
  if (dups.length) {
    notes.push({
      label: dups.length + " duplicate row name" + (dups.length === 1 ? "" : "s"),
      text: "Rows resolve to the same name (no explicit row name in the paste): " + dups.join(", "),
    });
  }

  if (rows.length > 1) {
    const ragged = rows.filter((r) => r.entries.length !== fields.length);
    if (ragged.length) {
      notes.push({
        label: ragged.length + " row" + (ragged.length === 1 ? "" : "s") + " with missing fields",
        text: "Not every row defines all " + fields.length + " fields: " +
          ragged.map((r) => r.name).join(", "),
      });
    }
  }

  return notes;
}

// Escape a value for a markdown table cell: neutralize pipes, flatten newlines,
// and show an em dash for an empty cell.
function mdCell(s) {
  const out = String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  return out || "—";
}

export function generateDataTableMarkdown(parsed, ascii, opts) {
  const o = opts || {};
  const { rows, fields } = parsed;
  const title = o.name || deriveDataTableFilenameBase(parsed, "");
  const lines = [];

  lines.push("# " + title);
  lines.push("");
  lines.push("_Unreal Engine data table — " + rows.length + " row" + (rows.length === 1 ? "" : "s") +
    ", " + fields.length + " field" + (fields.length === 1 ? "" : "s") + "._");
  if (o.timestamp) { lines.push(""); lines.push("Generated " + o.timestamp + "."); }
  lines.push("");

  if (rows.length > 0) {
    lines.push("## Rows");
    lines.push("");
    lines.push("| Row | " + fields.map(mdCell).join(" | ") + " |");
    lines.push("| --- |" + fields.map(() => " --- ").join("|") + "|");
    for (const r of rows) {
      const cells = fields.map((f) => mdCell(formatValue(r.fieldMap.has(f) ? r.fieldMap.get(f) : "")));
      lines.push("| " + mdCell(r.name) + " | " + cells.join(" | ") + " |");
    }
  }

  lines.push("");
  lines.push("## Detail");
  lines.push("");
  lines.push("```");
  lines.push(ascii);
  lines.push("```");

  const notes = generateDataTableReviewNotes(parsed);
  if (notes.length > 0) {
    lines.push("");
    lines.push("## Review notes");
    lines.push("");
    for (const n of notes) lines.push("- **" + n.label + "** — " + n.text);
  }

  if (o.includeRaw && o.rawInput) {
    lines.push("");
    lines.push("## Raw paste");
    lines.push("");
    lines.push("```");
    lines.push(o.rawInput);
    lines.push("```");
  }

  return lines.join("\n");
}
