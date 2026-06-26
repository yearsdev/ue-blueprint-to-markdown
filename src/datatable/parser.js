// ============================================================================
// datatable/parser.js — UE DataTable row copy/paste text -> structured rows.
//
// Copying a row out of the Data Table editor (or exporting one) serializes the
// row struct as a UStruct literal:
//
//   (SpellID="Lesser_Heal",SpellName=NSLOCTEXT("DT_NPCSpells_New [GUID]",
//    "Lesser_Heal_SpellName","Lesser Heal"),Duration=0.000000,IsCurable=False,
//    CastVFX=None,Color=(R=1.0,G=0.0,B=0.0,A=1.0))
//
// Unlike Blueprint/material pastes there are no Begin Object blocks and no
// exec/data pins — just one or more parenthesized structs, optionally preceded
// by a row name. parseDataTable returns { rows, fields, nodes, structName,
// graphType }, where each row is { name, entries:[{key,value}], fieldMap, raw }.
//
// A value is one of:
//   - a string (scalar: number/bool/None/enum/object-ref, or unquoted text)
//   - { kind: "struct", entries: [{key, value}] }   for nested (A=..,B=..)
//   - { kind: "array",  items: [value, ...] }        for nested (v1,v2,..)
// Localized text (NSLOCTEXT/LOCTEXT/INVTEXT) is collapsed to its display string.
// ============================================================================

// Cheap sniff used by the editor's router. A data table paste has no Begin
// Object blocks and no K2Node_/MaterialExpression classes — it's a bare
// parenthesized struct whose first member is an Ident=Value pair.
export function looksLikeDataTable(text) {
  if (!text) return false;
  if (/Begin Object/.test(text)) return false;
  if (/\bK2Node_/.test(text)) return false;
  if (/\bMaterialExpression[A-Za-z]/.test(text)) return false;
  return /\(\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text);
}

// Pull every top-level double-quoted string out of s, unescaping \" and \\.
// Used both to read text-macro arguments and to unquote a plain string value.
function extractQuotedStrings(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      let j = i + 1;
      let buf = "";
      while (j < s.length) {
        if (s[j] === "\\" && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        if (s[j] === '"') break;
        buf += s[j];
        j++;
      }
      out.push(buf);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

// NSLOCTEXT("ns","key","display") -> "display"; LOCTEXT("key","display") ->
// "display"; INVTEXT("text") -> "text". Returns null when raw isn't a text
// macro, so the caller can fall through to scalar/struct handling.
function extractTextMacro(raw) {
  const m = raw.match(/^(NSLOCTEXT|LOCTEXT|INVTEXT)\s*\(/i);
  if (!m) return null;
  const open = raw.indexOf("(");
  const close = raw.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const args = extractQuotedStrings(raw.slice(open + 1, close));
  const macro = m[1].toUpperCase();
  if (macro === "NSLOCTEXT") return args.length >= 3 ? args[2] : (args[args.length - 1] || "");
  if (macro === "LOCTEXT") return args.length >= 2 ? args[1] : (args[0] || "");
  return args[0] || "";
}

// Split s on top-level commas, respecting quotes and nested parentheses. Drops
// empty segments so trailing commas (UE writes (A,B,)) don't produce blanks.
function splitTopLevel(s) {
  const parts = [];
  let cur = "";
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      cur += c;
      if (c === '"' && s[i - 1] !== "\\") inQuote = false;
      continue;
    }
    if (c === '"') { inQuote = true; cur += c; }
    else if (c === "(") { depth++; cur += c; }
    else if (c === ")") { depth--; cur += c; }
    else if (c === "," && depth === 0) { parts.push(cur); cur = ""; }
    else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// Split one segment at its first top-level '=' into {key, raw}. Returns null
// when the segment carries no top-level assignment (an array element).
function splitKeyValue(seg) {
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (inQuote) {
      if (c === '"' && seg[i - 1] !== "\\") inQuote = false;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "=" && depth === 0) {
      return { key: seg.slice(0, i).trim(), raw: seg.slice(i + 1).trim() };
    }
  }
  return null;
}

// Parse the contents of a (...) group. If every member is an Ident=Value pair
// it's a struct; otherwise it's an array. A struct preserves member order so
// the rendered output matches the authored field order.
function parseContainer(inner) {
  const segs = splitTopLevel(inner);
  if (segs.length === 0) return { kind: "struct", entries: [] };
  const kvs = segs.map(splitKeyValue);
  if (kvs.every(Boolean)) {
    return {
      kind: "struct",
      entries: kvs.map((kv) => ({ key: kv.key, value: interpretValue(kv.raw) })),
    };
  }
  return { kind: "array", items: segs.map(interpretValue) };
}

function interpretValue(raw) {
  raw = raw.trim();
  if (raw === "") return "";
  if (raw[0] === "(" && raw[raw.length - 1] === ")") return parseContainer(raw.slice(1, -1));
  const macro = extractTextMacro(raw);
  if (macro !== null) return macro;
  if (raw[0] === '"') {
    const s = extractQuotedStrings(raw);
    return s.length ? s[0] : raw.replace(/^"|"$/g, "");
  }
  return raw; // number / True / False / None / enum / object ref
}

// Render a parsed value as a single-line string for a table cell or row line.
// Floats serialized with UE's six-decimal padding collapse to their shortest
// form (0.000000 -> 0, 40.000000 -> 40, 1.500000 -> 1.5).
export function formatValue(v) {
  if (typeof v === "string") {
    if (/^-?\d+\.\d+$/.test(v)) {
      const n = parseFloat(v);
      return Number.isFinite(n) ? String(n) : v;
    }
    return v;
  }
  if (v && v.kind === "struct") {
    return "(" + v.entries.map((e) => e.key + "=" + formatValue(e.value)).join(", ") + ")";
  }
  if (v && v.kind === "array") {
    return "[" + v.items.map((it) => formatValue(it)).join(", ") + "]";
  }
  return String(v);
}

// Split the whole paste into rows. Each row is an optional name prefix followed
// by a top-level (...) struct. Text between structs (a leading row name, commas,
// newlines) is captured as the next row's prefix.
function splitRows(text) {
  const rows = [];
  let prefix = "";
  let buf = "";
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth === 0) {
      if (c === "(") { depth = 1; buf = "("; }
      else prefix += c;
    } else {
      buf += c;
      if (inQuote) {
        if (c === '"' && text[i - 1] !== "\\") inQuote = false;
      } else if (c === '"') {
        inQuote = true;
      } else if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
        if (depth === 0) {
          rows.push({ prefix: prefix.trim(), struct: buf });
          prefix = "";
          buf = "";
        }
      }
    }
  }
  return rows;
}

// Normalize a captured prefix into a row name. Handles bare names, quoted
// names, trailing separators, and Name=Value forms (takes the value side).
function cleanRowName(prefix) {
  let p = prefix.replace(/[\r\n\t]+/g, " ").trim().replace(/[,;]+$/, "").trim();
  if (p.includes("=")) p = p.slice(p.lastIndexOf("=") + 1).trim();
  return p.replace(/^"|"$/g, "").trim();
}

function isScalarString(v) { return typeof v === "string" && v !== ""; }

// When a row carries no explicit name prefix, derive one from its fields: prefer
// an Id/Name-ish key, else the first scalar string, else a positional fallback.
function deriveRowName(entries, idx) {
  const pick = (pred) => {
    const e = entries.find((x) => isScalarString(x.value) && pred(x.key));
    return e ? e.value : null;
  };
  return (
    pick((k) => /^(rowname|name|id)$/i.test(k)) ||
    pick((k) => /id$/i.test(k)) ||
    pick((k) => /name$/i.test(k)) ||
    (entries.find((e) => isScalarString(e.value)) || {}).value ||
    "Row " + (idx + 1)
  );
}

// The owning asset name is embedded in the NSLOCTEXT namespace UE writes for
// localized fields: "DT_NPCSpells_New [GUID]" -> "DT_NPCSpells_New". Used to
// title and auto-name the export when present.
function extractStructName(text) {
  const m = text.match(/NSLOCTEXT\(\s*"([^"]+)"/);
  if (!m) return "";
  return m[1].replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}

export function parseDataTable(text) {
  const rows = [];
  splitRows(text).forEach((rr, idx) => {
    const container = parseContainer(rr.struct.slice(1, -1));
    const entries = container.kind === "struct" ? container.entries : [];
    const fieldMap = new Map();
    for (const e of entries) fieldMap.set(e.key, e.value);
    const name = cleanRowName(rr.prefix) || deriveRowName(entries, idx);
    rows.push({ name, entries, fieldMap, raw: rr.struct });
  });

  const fields = [];
  const seen = new Set();
  for (const r of rows) {
    for (const e of r.entries) {
      if (!seen.has(e.key)) { seen.add(e.key); fields.push(e.key); }
    }
  }

  // `nodes` mirrors the blueprint/material shape so the editor's shared header
  // (parsed.nodes.length) works without special-casing.
  return { rows, fields, nodes: rows, structName: extractStructName(text), graphType: "datatable" };
}
