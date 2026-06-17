// ============================================================================
// blueprint/metadata.js — Function metadata extraction.
// Pulls component, signature, locals, writes, calls, dispatchers from a
// parsed graph, plus the markdown emitter for that metadata block.
// ============================================================================

import { matchField, isExecPin } from "./common.js";

function typeLabelFromPin(pin) {
  if (!pin) return "?";
  const cat = pin.PinCategory || "";
  const sub = pin.PinSubCategory || "";
  const subObj = pin.PinSubCategoryObject || "";
  const container = pin.ContainerType || "";

  let label;
  if (cat === "real") {
    label = sub || "real";
  } else if (cat === "object" || cat === "class" || cat === "softobject" || cat === "softclass" || cat === "interface") {
    const m = subObj.match(/\.([A-Za-z0-9_]+)['"]?$/);
    const className = m ? m[1].replace(/_C$/, "") : (subObj || "Object");
    const suffix = (cat === "class" || cat === "softclass") ? " (Class)" : "*";
    label = className + suffix;
  } else if (cat === "struct") {
    const m = subObj.match(/\.([A-Za-z0-9_]+)['"]?$/);
    label = m ? m[1] : "Struct";
  } else if (cat === "byte" && subObj) {
    const m = subObj.match(/\.([A-Za-z0-9_]+)['"]?$/);
    label = m ? m[1] : "byte";
  } else if (cat === "exec") {
    label = "exec";
  } else {
    label = cat || "?";
  }

  if (container === "Array") return label + "[]";
  if (container === "Set") return "Set<" + label + ">";
  if (container === "Map") return "Map<" + label + ">";
  return label;
}

function parseLocalVariables(funcEntryBlock) {
  const locals = [];
  if (!funcEntryBlock) return locals;
  const lines = funcEntryBlock.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*LocalVariables\(\d+\)=\((.*)\)\s*$/);
    if (!m) continue;
    const inner = m[1];
    const nameMatch = inner.match(/VarName="([^"]*)"/);
    if (!nameMatch) continue;
    const typeMatch = inner.match(/VarType=\(([^)]*)\)/);
    let label = "unknown";
    if (typeMatch) {
      const typeInner = typeMatch[1];
      const cat = typeInner.match(/PinCategory="([^"]*)"/);
      const sub = typeInner.match(/PinSubCategory="([^"]*)"/);
      label = typeLabelFromPin({
        PinCategory: cat ? cat[1] : "",
        PinSubCategory: sub ? sub[1] : "",
        PinSubCategoryObject: "",
        ContainerType: "",
      });
    }
    locals.push({ name: nameMatch[1].trim(), type: label });
  }
  return locals;
}

function extractOwningComponent(parseResult) {
  for (const node of parseResult.nodes) {
    const m = node.raw.match(/ExportPath="[^"]*\/([A-Z][A-Za-z0-9_]+)\.\1:/);
    if (m) return m[1];
  }
  return null;
}

function categorizeMemberParent(memberParent) {
  if (!memberParent) return { kind: "self", label: null };
  const m = memberParent.match(/\.([A-Za-z0-9_]+)['"]?$/);
  const label = m ? m[1].replace(/_C$/, "") : memberParent;
  if (/(Library|Statics)$/i.test(label)) return { kind: "engine", label };
  if (/BlueprintGeneratedClass/i.test(memberParent)) return { kind: "component", label };
  return { kind: "component", label };
}

function extractMemberRefName(refValue) {
  if (!refValue) return null;
  const m = refValue.match(/MemberName="?([^",)]+)"?/);
  return m ? m[1] : null;
}

function extractMemberParent(refValue) {
  if (!refValue) return null;
  const m = refValue.match(/MemberParent=("[^"]+"|'[^']+'|[^,)]+)/);
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

export function extractFunctionMetadata(parseResult) {
  const meta = {
    component: extractOwningComponent(parseResult),
    functionName: null,
    parameters: [],
    returns: [],
    localVariables: [],
    writes: { self: new Map(), local: new Map(), external: new Map() },
    variableRefs: { self: new Map(), local: new Map(), external: new Map() },
    calls: { self: new Map(), component: new Map(), engine: new Map(), unknown: new Map() },
    dispatchers: new Map(),
  };

  const funcEntry = parseResult.nodes.find((n) => n.nodeClass === "K2Node_FunctionEntry");
  if (funcEntry) {
    const fnRef = matchField(funcEntry.raw, "FunctionReference");
    meta.functionName = extractMemberRefName(fnRef);
    meta.localVariables = parseLocalVariables(funcEntry.raw);
    for (const pin of funcEntry.pins) {
      if (isExecPin(pin)) continue;
      if (pin.Direction !== "EGPD_Output") continue;
      meta.parameters.push({ name: pin.PinName, type: typeLabelFromPin(pin) });
    }
  } else {
    const evt = parseResult.nodes.find((n) => n.nodeClass === "K2Node_Event" || n.nodeClass === "K2Node_CustomEvent");
    if (evt) meta.functionName = evt.friendly;
  }

  const funcResult = parseResult.nodes.find((n) => n.nodeClass === "K2Node_FunctionResult");
  if (funcResult) {
    for (const pin of funcResult.pins) {
      if (isExecPin(pin)) continue;
      if (pin.Direction !== "EGPD_Input") continue;
      meta.returns.push({ name: pin.PinName, type: typeLabelFromPin(pin) });
    }
  }

  for (const node of parseResult.nodes) {
    if (node.nodeClass === "K2Node_VariableSet" || node.nodeClass === "K2Node_VariableGet") {
      const isSet = node.nodeClass === "K2Node_VariableSet";
      const ref = matchField(node.raw, "VariableReference");
      const name = extractMemberRefName(ref);
      if (!name) continue;
      const scopeMatch = ref ? ref.match(/MemberScope="([^"]+)"/) : null;
      const parent = extractMemberParent(ref);
      let scope;
      let qualified = name;
      if (scopeMatch) {
        scope = "local";
      } else if (parent) {
        const cat = categorizeMemberParent(parent);
        qualified = (cat.label || "External") + "." + name;
        scope = "external";
      } else {
        scope = "self";
      }
      // Pull the type from the value pin: output for Get, input (non-self) for Set.
      const direction = isSet ? "EGPD_Input" : "EGPD_Output";
      const valuePin = node.pins.find((p) =>
        !isExecPin(p) && p.Direction === direction && p.PinName !== "self"
      );
      const type = valuePin ? typeLabelFromPin(valuePin) : "?";
      const refsBucket = meta.variableRefs[scope];
      let entry = refsBucket.get(qualified);
      if (!entry) {
        entry = { type, reads: 0, writes: 0 };
        refsBucket.set(qualified, entry);
      } else if ((!entry.type || entry.type === "?") && type !== "?") {
        entry.type = type;
      }
      if (isSet) {
        entry.writes++;
        meta.writes[scope].set(qualified, (meta.writes[scope].get(qualified) || 0) + 1);
      } else {
        entry.reads++;
      }
    } else if (node.nodeClass === "K2Node_CallFunction" || node.nodeClass === "K2Node_CallFunctionOnMember" || node.nodeClass === "K2Node_CallArrayFunction") {
      const ref = matchField(node.raw, "FunctionReference");
      const name = extractMemberRefName(ref);
      if (!name) continue;
      if (/^(Add|Subtract|Multiply|Divide|EqualEqual|NotEqual|Greater|Less|GreaterEqual|LessEqual|Boolean|Conv_)/.test(name)) continue;
      const parent = extractMemberParent(ref);
      const cat = categorizeMemberParent(parent);
      const qualified = cat.label ? (cat.label + "." + name) : name;
      const bucket = meta.calls[cat.kind] || meta.calls.unknown;
      bucket.set(qualified, (bucket.get(qualified) || 0) + 1);
    } else if (node.nodeClass === "K2Node_CallDelegate") {
      const ref = matchField(node.raw, "DelegateReference");
      const name = extractMemberRefName(ref);
      if (name) meta.dispatchers.set(name, (meta.dispatchers.get(name) || 0) + 1);
    }
  }

  return meta;
}

function formatMetaMap(map) {
  if (!map || map.size === 0) return "(none)";
  const entries = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([name, count]) => "`" + name + "`" + (count > 1 ? " ×" + count : "")).join(", ");
}

function formatVariableRefs(map) {
  if (!map || map.size === 0) return null;
  const entries = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([name, entry]) => {
    const counts = [];
    if (entry.reads > 0) counts.push(entry.reads + (entry.reads === 1 ? " read" : " reads"));
    if (entry.writes > 0) counts.push(entry.writes + (entry.writes === 1 ? " write" : " writes"));
    return "`" + name + "` (" + entry.type + ")" + (counts.length ? " — " + counts.join(", ") : "");
  }).join(", ");
}

export function generateFunctionMetadataMarkdown(meta) {
  const lines = [];
  if (meta.component) lines.push("**Component:** `" + meta.component + "`");
  if (meta.functionName) {
    const params = meta.parameters.map((p) => p.name + ": " + p.type).join(", ");
    const returnsLabel = meta.returns.length === 0
      ? "void"
      : meta.returns.map((r) => (r.name && r.name !== "ReturnValue" ? r.name + ": " : "") + r.type).join(", ");
    lines.push("**Function:** `" + meta.functionName + "(" + params + ")` returns `" + returnsLabel + "`");
  }
  if (meta.localVariables.length > 0) {
    lines.push("");
    lines.push("**Local Variables**");
    for (const v of meta.localVariables) lines.push("- `" + v.name + "`: " + v.type);
  }
  const hasWrites = meta.writes.self.size + meta.writes.local.size + meta.writes.external.size > 0;
  if (hasWrites) {
    lines.push("");
    lines.push("**Writes**");
    if (meta.writes.self.size > 0)     lines.push("- Self: " + formatMetaMap(meta.writes.self));
    if (meta.writes.local.size > 0)    lines.push("- Local: " + formatMetaMap(meta.writes.local));
    if (meta.writes.external.size > 0) lines.push("- External: " + formatMetaMap(meta.writes.external));
  }
  const refs = meta.variableRefs;
  const hasRefs = refs.self.size + refs.local.size + refs.external.size > 0;
  if (hasRefs) {
    lines.push("");
    lines.push("**Variables Referenced**");
    if (refs.self.size > 0)     lines.push("- Self: " + formatVariableRefs(refs.self));
    if (refs.local.size > 0)    lines.push("- Local: " + formatVariableRefs(refs.local));
    if (refs.external.size > 0) lines.push("- External: " + formatVariableRefs(refs.external));
  }
  const hasCalls = meta.calls.self.size + meta.calls.component.size + meta.calls.engine.size + meta.calls.unknown.size > 0;
  if (hasCalls) {
    lines.push("");
    lines.push("**Calls**");
    if (meta.calls.self.size > 0)      lines.push("- Self: " + formatMetaMap(meta.calls.self));
    if (meta.calls.component.size > 0) lines.push("- Component / cross-actor: " + formatMetaMap(meta.calls.component));
    if (meta.calls.engine.size > 0)    lines.push("- Engine: " + formatMetaMap(meta.calls.engine));
    if (meta.calls.unknown.size > 0)   lines.push("- Other: " + formatMetaMap(meta.calls.unknown));
  }
  if (meta.dispatchers.size > 0) {
    lines.push("");
    lines.push("**Dispatchers Fired**");
    lines.push("- " + formatMetaMap(meta.dispatchers));
  }
  return lines.join("\n");
}
