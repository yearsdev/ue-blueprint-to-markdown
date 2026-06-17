// ============================================================================
// material/analysis.js - metadata, review notes, and markdown export for the
// material graph pipeline. Mirrors blueprint/metadata.js + blueprint/markdown.js
// so the editor can treat both engines through the same call shape.
// ============================================================================

import { matchField } from "../blueprint/common.js";
import { pinLiteralValue } from "../blueprint/parser.js";

// The owning material asset name, read from any node's
// Material="/Script/UnrealEd.PreviewMaterial'/Engine/Transient.PPM_CheapFog'"
// line. Used to auto-name the saved diagram.
function materialAssetName(parsed) {
  for (const n of parsed.nodes) {
    const ref = matchField(n.raw, "Material");
    if (ref) {
      const m = ref.replace(/['"]/g, "").match(/([A-Za-z0-9_]+)$/);
      if (m && m[1] !== "PreviewMaterial") return m[1];
    }
  }
  return "";
}

// Parameter expression types carry an author-facing ParameterName; collect them
// so docs can list a material's tunable knobs.
const PARAM_TYPES = {
  ScalarParameter: "Scalar",
  VectorParameter: "Vector",
  StaticBoolParameter: "Static Bool",
  StaticSwitchParameter: "Static Switch",
  TextureSampleParameter2D: "Texture2D",
  TextureObjectParameter: "Texture Object",
};

function collectParameters(parsed) {
  const params = [];
  for (const n of parsed.nodes) {
    const type = PARAM_TYPES[n.exprType];
    if (!type) continue;
    const name = (matchField(n.raw, "ParameterName") || "").replace(/^"|"$/g, "");
    const def = matchField(n.raw, "DefaultValue");
    params.push({ name: name || "(unnamed)", type, default: def || null });
  }
  return params;
}

// Connected Material Output pins - the surfaces this graph actually drives.
function connectedOutputs(parsed) {
  if (!parsed.rootNode) return [];
  return parsed.rootNode.pins
    .filter((p) => p.Direction !== "EGPD_Output" && p.LinkedTo.length > 0)
    .map((p) => p.PinName);
}

// Walk the link graph backward from the root to find every node that actually
// contributes to an output. Anything outside this set is dead weight in the
// paste - surfaced as a review note.
function reachableFromRoot(parsed) {
  const reached = new Set();
  if (!parsed.rootNode) return reached;
  const stack = [parsed.rootNode];
  while (stack.length) {
    const node = stack.pop();
    if (reached.has(node.name)) continue;
    reached.add(node.name);
    for (const p of node.pins) {
      if (p.Direction === "EGPD_Output") continue;
      for (const link of p.LinkedTo) {
        const src = parsed.byName.get(link.nodeName);
        if (src && !reached.has(src.name)) stack.push(src);
      }
    }
  }
  return reached;
}

export function extractMaterialMetadata(parsed) {
  const expressionNodes = parsed.nodes.filter((n) => !n.isComment);
  const name = materialAssetName(parsed);
  return {
    graphType: "material",
    functionName: name,
    component: "",
    nodeCount: expressionNodes.length,
    parameters: collectParameters(parsed),
    outputs: connectedOutputs(parsed),
    // Blueprint metadata carries variableRefs; the editor guards on its
    // presence, so leaving it undefined keeps the var counter hidden.
  };
}

export function generateMaterialReviewNotes(parsed) {
  const notes = [];
  const expressionNodes = parsed.nodes.filter((n) => !n.isComment);

  if (!parsed.rootNode) {
    notes.push({
      label: "no Material Output",
      text: "No Material Output (MaterialGraphNode_Root) node in the paste — the tree is rendered from terminal nodes instead.",
    });
  } else if (connectedOutputs(parsed).length === 0) {
    notes.push({
      label: "output unconnected",
      text: "The Material Output node has no connected inputs — nothing drives a material surface.",
    });
  }

  if (parsed.rootNode) {
    const reached = reachableFromRoot(parsed);
    const stranded = expressionNodes.filter((n) => !n.isRoot && !reached.has(n.name));
    if (stranded.length > 0) {
      notes.push({
        label: stranded.length + " node" + (stranded.length === 1 ? "" : "s") + " not reaching output",
        text: "These nodes don't feed the Material Output and won't affect the result: " +
          stranded.map((n) => n.friendly).join(", "),
      });
    }
  }

  return notes;
}

export function deriveMaterialFilenameBase(parsed, explicitName) {
  if (explicitName && explicitName.trim()) return explicitName.trim();
  return materialAssetName(parsed) || "material";
}

export function generateMaterialMarkdown(parsed, ascii, opts) {
  const o = opts || {};
  const meta = extractMaterialMetadata(parsed);
  const title = o.name || deriveMaterialFilenameBase(parsed, "");
  const lines = [];

  lines.push("# " + title);
  lines.push("");
  lines.push("_Unreal Engine material graph — " + meta.nodeCount + " nodes._");
  if (o.timestamp) lines.push("");
  if (o.timestamp) lines.push("Generated " + o.timestamp + ".");
  lines.push("");

  if (meta.outputs.length > 0) {
    lines.push("## Drives");
    lines.push("");
    for (const out of meta.outputs) lines.push("- " + out);
    lines.push("");
  }

  if (meta.parameters.length > 0) {
    lines.push("## Parameters");
    lines.push("");
    for (const p of meta.parameters) {
      lines.push("- **" + p.name + "** (" + p.type + ")" + (p.default ? " = " + p.default : ""));
    }
    lines.push("");
  }

  lines.push("## Graph");
  lines.push("");
  lines.push("```");
  lines.push(ascii);
  lines.push("```");

  const notes = generateMaterialReviewNotes(parsed);
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
