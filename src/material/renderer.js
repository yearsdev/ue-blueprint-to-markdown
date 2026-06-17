// ============================================================================
// material/renderer.js - Material graph -> ASCII expression tree.
//
// Unlike the Blueprint renderer (which walks execution flow forward from event
// nodes), a material graph has no exec flow: it is a pure data DAG read BACKWARD
// from the Material Output node. Each connected output pin (Base Color, Emissive
// Color, ...) is the head of an expression whose operands are upstream nodes.
//
// We render that as an indented tree where every line is "<pin> ← <source>",
// and the source's own inputs become the next level. Nodes consumed by more
// than one downstream pin (a Saturate feeding two blends) are shared: they are
// expanded once with an [#N] anchor and referenced by anchor everywhere else,
// so a diamond-shaped DAG stays linear in the output instead of exploding.
// ============================================================================

import { pinLiteralValue } from "../blueprint/parser.js";

// Canonical Material Output pin order, so the tree reads top-to-bottom in the
// same order the UE material node shows its inputs. Pins not listed (custom
// data, customized UVs) fall after these, in paste order.
const ROOT_PIN_ORDER = [
  "Base Color", "Metallic", "Specular", "Roughness", "Anisotropy",
  "Emissive Color", "Opacity", "Opacity Mask", "Normal", "Tangent",
  "World Position Offset", "Subsurface Color", "Ambient Occlusion",
  "Refraction", "Pixel Depth Offset",
];

// Node types whose unlinked A/B/Alpha pins are real inline operand constants
// worth surfacing (Multiply by 0.01, Lerp Alpha 0.5), as opposed to config
// defaults on other node types (a ComponentMask's channel toggles, a noise
// node's quality) which belong in the title, not as tree children.
const OPERAND_TYPES = new Set([
  "Add", "Subtract", "Multiply", "Divide", "LinearInterpolate", "Power",
  "Fmod", "Max", "Min", "Dot", "Cross", "Append", "Clamp", "Step", "SmoothStep",
]);
const OPERAND_PINS = new Set(["A", "B", "Alpha", "Min", "Max", "Value"]);

function isOutputPin(p) { return p.Direction === "EGPD_Output"; }

// Annotate which output of a multi-output source a wire actually reads. A plain
// single "Output" pin needs no annotation; a named output (XYZ, V2 Length) or a
// masked channel (the .A of a vector parameter) does, otherwise two wires off
// the same node read identically.
function annotateOutput(link) {
  const name = link.pinName;
  if (!name || name === "Output") return "";
  if (/^Output\d*$/.test(name)) {
    const ch = { red: "R", green: "G", blue: "B", alpha: "A" }[link.pinSubCategory];
    return ch ? " ." + ch : "";
  }
  return " (" + name + ")";
}

// The input pins of a node that should appear as tree children: every wired
// input, plus (for operator nodes, when data pins are shown) any unlinked
// operand carrying an inline constant. Root inputs are only shown when wired;
// an unconnected material attribute is just its engine default.
function childPins(node, showDataPins) {
  const out = [];
  for (const p of node.pins) {
    if (isOutputPin(p)) continue;
    if (p.LinkedTo.length > 0) {
      out.push({ pin: p, kind: "link" });
      continue;
    }
    if (node.isRoot || !showDataPins) continue;
    if (!OPERAND_TYPES.has(node.exprType) || !OPERAND_PINS.has(p.PinName)) continue;
    const lit = pinLiteralValue(p);
    if (lit !== null) out.push({ pin: p, kind: "literal", literal: lit });
  }
  return out;
}

function sortRootChildren(children) {
  return [...children].sort((a, b) => {
    const ai = ROOT_PIN_ORDER.indexOf(a.pin.PinName);
    const bi = ROOT_PIN_ORDER.indexOf(b.pin.PinName);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

function assignAnchor(node, ctx) {
  if (ctx.anchorIds.has(node.name)) return ctx.anchorIds.get(node.name);
  const id = "[#" + (ctx.anchorIds.size + 1) + "]";
  ctx.anchorIds.set(node.name, id);
  return id;
}

// Render one consumer pin and (recursively) the upstream subtree feeding it.
// prefix is the accumulated indentation drawn from ancestor branches; isLast
// controls whether this pin uses the corner (└─) or tee (├─) connector.
function renderPin(entry, ctx, prefix, isLast, lines) {
  const branch = isLast ? "└─ " : "├─ ";
  const childPrefix = prefix + (isLast ? "   " : "│  ");
  const pinName = entry.pin.PinName;

  if (entry.kind === "literal") {
    lines.push(prefix + branch + pinName + " = " + entry.literal);
    return;
  }

  const link = entry.pin.LinkedTo[0];
  const src = ctx.byName.get(link.nodeName);
  if (!src) {
    lines.push(prefix + branch + pinName + " ← ?");
    return;
  }

  const outAnn = annotateOutput(link);
  const shared = (ctx.consumers.get(src.name) || 0) > 1;

  if (shared && ctx.expanded.has(src.name)) {
    const anchor = ctx.anchorIds.get(src.name);
    lines.push(prefix + branch + pinName + " ← " + anchor + " " + src.friendly + outAnn + " (shown above)");
    return;
  }

  let label = src.friendly;
  if (shared) {
    label = assignAnchor(src, ctx) + " " + label;
    ctx.expanded.add(src.name);
  }
  lines.push(prefix + branch + pinName + " ← " + label + outAnn);

  const children = childPins(src, ctx.showDataPins);
  children.forEach((c, i) => renderPin(c, ctx, childPrefix, i === children.length - 1, lines));
}

// Render a node as the head of a tree (the Material Output, or each terminal
// node when no root is in the paste).
function renderRoot(node, ctx, lines) {
  lines.push(node.friendly);
  let children = childPins(node, ctx.showDataPins);
  if (node.isRoot) children = sortRootChildren(children);
  children.forEach((c, i) => renderPin(c, ctx, "", i === children.length - 1, lines));
}

export function renderMaterialASCII(parsed, opts) {
  const { nodes, byName, rootNode, comments } = parsed;
  const showDataPins = opts ? opts.showDataPins : true;

  const expressionNodes = nodes.filter((n) => !n.isComment);
  if (expressionNodes.length === 0) return "(no material nodes parsed)";

  // Count downstream consumers per node: how many input pins anywhere wire into
  // it. >1 marks a shared subgraph that should be anchored, not re-expanded.
  const consumers = new Map();
  for (const n of nodes) {
    for (const p of n.pins) {
      if (isOutputPin(p)) continue;
      for (const link of p.LinkedTo) {
        consumers.set(link.nodeName, (consumers.get(link.nodeName) || 0) + 1);
      }
    }
  }

  const ctx = {
    byName, consumers, showDataPins,
    anchorIds: new Map(),
    expanded: new Set(),
  };

  // Render roots: the Material Output if present, otherwise every node nothing
  // else consumes (terminal sinks of a partial paste).
  let roots;
  if (rootNode) {
    roots = [rootNode];
  } else {
    roots = expressionNodes
      .filter((n) => !(consumers.get(n.name) > 0))
      .sort((a, b) => (a.posY - b.posY) || (a.posX - b.posX));
  }

  if (roots.length === 0) {
    return "(no Material Output and no terminal node found in " + expressionNodes.length + " nodes)";
  }

  const sections = [];
  for (const r of roots) {
    const lines = [];
    renderRoot(r, ctx, lines);
    sections.push(lines.join("\n"));
  }

  let out = sections.join("\n\n" + "─".repeat(40) + "\n\n");

  if (comments.length > 0) {
    const labels = comments
      .map((c) => c.comment)
      .filter(Boolean)
      .join(", ");
    if (labels) out += "\n\n─── comment regions: " + labels + " ───";
  }

  return out;
}
