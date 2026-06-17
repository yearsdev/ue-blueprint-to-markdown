// ============================================================================
// material/parser.js - UE Material graph copy/paste text -> node graph.
//
// A material graph serializes the same Begin Object / End Object blocks and the
// same CustomProperties Pin lines as a Blueprint, so the low-level walkers
// (splitTopLevelBlocks, parsePinLine) are shared from blueprint/common.js. What
// differs structurally:
//
//   - Each graph node is a wrapper: Class=/Script/UnrealEd.MaterialGraphNode
//     (or _Root for the material output, _Comment for a comment box). The real
//     node type lives one level down in a nested
//     Begin Object Class=/Script/Engine.MaterialExpression<Type> block, named
//     again on a MaterialExpression="...MaterialExpression<Type>'...'" line.
//   - There is no execution flow. Connectivity is the pin LinkedTo graph, the
//     same as Blueprint, but it describes a pure data DAG that is read BACKWARD
//     from the root output node (see renderer.js).
//
// parseMaterial returns { nodes, byName, rootNode, comments, graphType }.
// ============================================================================

import {
  matchField, humanize, splitTopLevelBlocks, parsePinLine, PIN_REGEX,
} from "../blueprint/common.js";

// Cheap sniff used by the editor to route a paste to the material engine vs the
// blueprint engine. Material pastes are full of MaterialGraphNode wrappers;
// Blueprint pastes are full of K2Node_* classes and never mention them.
export function detectGraphType(text) {
  if (!text) return "blueprint";
  if (/Class=\/Script\/UnrealEd\.MaterialGraphNode/.test(text)) return "material";
  if (/\bMaterialExpression[A-Za-z]/.test(text) && !/\bK2Node_/.test(text)) return "material";
  return "blueprint";
}

// The expression class names this graph knows how to humanize. Anything not
// listed falls back to humanize() of the class tail, so an unknown expression
// still renders a sensible label rather than the raw class path.
const OPERATOR_LABELS = {
  Add: "Add (+)",
  Subtract: "Subtract (−)",
  Multiply: "Multiply (×)",
  Divide: "Divide (÷)",
};

// Pull the asset/identifier tail out of a UE object reference value like
//   MaterialFunction="/Script/Engine.MaterialFunction'/Engine/.../VectorLength.VectorLength'"
// The user-facing name is the segment after the final '.'.
function assetTail(value) {
  if (!value) return null;
  const cleaned = value.replace(/['"]/g, "").trim();
  const m = cleaned.match(/([A-Za-z0-9_]+)$/);
  return m ? m[1] : null;
}

// Extract the inner MaterialExpression class for a graph node. The wrapper
// declares it on a MaterialExpression="/Script/Engine.MaterialExpression<X>'...'"
// line; comment nodes use MaterialExpressionComment="...". Returns the class
// tail (e.g. "MaterialExpressionLinearInterpolate") or null for the root.
function extractExpressionClass(block) {
  const m = block.match(/^\s*MaterialExpression(?:Comment)?="?\/Script\/Engine\.(MaterialExpression[A-Za-z0-9_]+)/m);
  return m ? m[1] : null;
}

// Strip the "MaterialExpression" prefix to get the bare type ("Multiply").
function exprShortType(exprClass) {
  return exprClass ? exprClass.replace(/^MaterialExpression/, "") : "";
}

// A scalar/vector parameter's authored value lives on its own expression line
// (DefaultValue=2500.000000), distinct from the inline DefaultValue="..." that
// sits inside pin lines. matchField is line-anchored, so it reads the former.
function expressionField(block, field) {
  return matchField(block, field);
}

function friendlyMaterialName(node) {
  if (node.isRoot) return "Material Output";
  if (node.isComment) return node.comment ? "// " + node.comment : "// Comment";

  const type = exprShortType(node.exprClass);
  const block = node.raw;

  if (OPERATOR_LABELS[type]) return OPERATOR_LABELS[type];

  if (type === "LinearInterpolate") return "Lerp";
  if (type === "Saturate") return "Saturate";
  if (type === "OneMinus") return "OneMinus (1-x)";
  if (type === "Power") return "Power";
  if (type === "Fresnel") return "Fresnel";
  if (type === "Time") return "Time";
  if (type === "Sine") return "Sine";
  if (type === "Cosine") return "Cosine";
  if (type === "Frac") return "Frac";
  if (type === "Abs") return "Abs";
  if (type === "Floor") return "Floor";
  if (type === "Ceil") return "Ceil";
  if (type === "Constant") return "Constant " + (expressionField(block, "R") || "");
  if (type === "Constant2Vector") return "Constant2";
  if (type === "Constant3Vector") return "Constant3";
  if (type === "Constant4Vector") return "Constant4";

  if (type === "ScalarParameter") {
    const name = stripQuotes(expressionField(block, "ParameterName")) || "Scalar";
    const def = expressionField(block, "DefaultValue");
    return def ? "Scalar: " + name + " = " + def : "Scalar: " + name;
  }
  if (type === "VectorParameter") {
    const name = stripQuotes(expressionField(block, "ParameterName")) || "Vector";
    return "Vector: " + name;
  }
  if (type === "StaticBoolParameter" || type === "StaticSwitchParameter") {
    const name = stripQuotes(expressionField(block, "ParameterName")) || "Switch";
    return "Static Bool: " + name;
  }
  if (type === "TextureSampleParameter2D" || type === "TextureObjectParameter") {
    const name = stripQuotes(expressionField(block, "ParameterName")) || "Texture";
    return "Texture Param: " + name;
  }
  if (type === "TextureSample") {
    const tex = assetTail(expressionField(block, "Texture"));
    return tex ? "Texture Sample: " + tex : "Texture Sample";
  }

  if (type === "ComponentMask") {
    const channels = ["R", "G", "B", "A"]
      .filter((ch) => new RegExp("^\\s*" + ch + "=True", "m").test(block))
      .join("");
    return channels ? "Mask " + channels : "Mask";
  }

  if (type === "WorldPosition") return "World Position";
  if (type === "CameraPositionWS") return "Camera Position (WS)";
  if (type === "ObjectPositionWS") return "Object Position (WS)";
  if (type === "PixelNormalWS") return "Pixel Normal (WS)";
  if (type === "VertexNormalWS") return "Vertex Normal (WS)";

  if (type === "SceneTexture") {
    const id = expressionField(block, "SceneTextureId");
    return id ? "Scene Texture: " + id : "Scene Texture";
  }
  if (type === "TextureCoordinate") {
    const idx = expressionField(block, "CoordinateIndex");
    return idx ? "TexCoord[" + idx + "]" : "TexCoord";
  }

  if (type === "VectorNoise" || type === "Noise") {
    const fn = expressionField(block, "NoiseFunction");
    return fn ? type.replace(/([a-z])([A-Z])/g, "$1 $2") + " (" + fn + ")"
             : type.replace(/([a-z])([A-Z])/g, "$1 $2");
  }

  if (type === "MaterialFunctionCall") {
    const fn = assetTail(expressionField(block, "MaterialFunction"));
    return fn ? "Fn: " + fn : "Material Function";
  }
  if (type === "FunctionInput") {
    const name = stripQuotes(expressionField(block, "InputName")) || "Input";
    return "Func Input: " + name;
  }
  if (type === "FunctionOutput") {
    const name = stripQuotes(expressionField(block, "OutputName")) || "Output";
    return "Func Output: " + name;
  }

  return humanize(type) || "Expression";
}

function stripQuotes(s) {
  return s ? s.replace(/^"|"$/g, "") : s;
}

export function parseMaterial(text) {
  const blocks = splitTopLevelBlocks(text);
  const nodes = [];
  for (const block of blocks) {
    const firstLine = block.split("\n")[0];
    const headerMatch = firstLine.match(/Class=([^\s]+)\s+Name="([^"]+)"/);
    if (!headerMatch) continue;
    const rawClass = headerMatch[1];
    const outerClass = rawClass.split(".").pop();

    const node = {
      raw: block,
      rawClass,
      outerClass,
      name: headerMatch[2],
      exprClass: extractExpressionClass(block),
      exprType: exprShortType(extractExpressionClass(block)),
      isRoot: outerClass === "MaterialGraphNode_Root",
      isComment: outerClass === "MaterialGraphNode_Comment",
      comment: stripQuotes(matchField(block, "NodeComment")) || "",
      pins: [],
      friendly: "",
      posX: parseInt(matchField(block, "NodePosX") || "0", 10),
      posY: parseInt(matchField(block, "NodePosY") || "0", 10),
    };

    PIN_REGEX.lastIndex = 0;
    let pm;
    while ((pm = PIN_REGEX.exec(block)) !== null) {
      node.pins.push(parsePinLine(pm[1]));
    }

    node.friendly = friendlyMaterialName(node);
    nodes.push(node);
  }

  const byName = new Map();
  for (const n of nodes) byName.set(n.name, n);

  // Resolve every LinkedTo target pin id to its pin name and direction so the
  // renderer can follow wires without re-scanning. Material wires are described
  // redundantly (inner Expression= refs AND pin LinkedTo); we rely solely on the
  // pin LinkedTo graph, which uniquely identifies the exact output pin and so
  // handles multi-output nodes (a MaterialFunctionCall's V2 vs V3 outputs)
  // without parsing OutputIndex.
  for (const n of nodes) {
    for (const p of n.pins) {
      for (const link of p.LinkedTo) {
        const target = byName.get(link.nodeName);
        if (!target) continue;
        const tp = target.pins.find((x) => x.PinId === link.pinId);
        if (tp) {
          link.pinName = tp.PinName;
          link.pinSubCategory = tp.PinSubCategory;
        }
      }
    }
  }

  const rootNode = nodes.find((n) => n.isRoot) || null;
  const comments = nodes.filter((n) => n.isComment);

  return { nodes, byName, rootNode, comments, graphType: "material" };
}
