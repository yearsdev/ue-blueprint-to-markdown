import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseMaterial, detectGraphType, renderMaterialASCII,
  extractMaterialMetadata, generateMaterialReviewNotes,
  deriveMaterialFilenameBase,
} from "../materialEngine.js";

// A compact but representative material paste, modeled on a post-process fog
// graph: Material Output.Emissive ← Lerp, with a ComponentMask over a
// SceneTexture, a VectorParameter shared between two consumers (one of them a
// masked .A channel), and a Multiply carrying an inline constant operand.
//
//   Emissive ← Lerp(A=Mask(SceneTexture), B=FogColor, Alpha=Mul(Saturate(Mul(FogDist, 0.01)), FogColor.A))
const FOG_PAYLOAD = [
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Root Name="MaterialGraphNode_Root_0"',
  '   Material="/Script/UnrealEd.PreviewMaterial\'/Engine/Transient.PPM_CheapFog\'"',
  '   NodePosX=0',
  '   NodePosY=0',
  '   CustomProperties Pin (PinId=R_BC,PinName="Base Color",PinType.PinSubCategory="rgba",DefaultValue="(R=0.5)")',
  '   CustomProperties Pin (PinId=R_EM,PinName="Emissive Color",PinType.PinSubCategory="rgba",LinkedTo=(MaterialGraphNode_0 N0_OUT,))',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_0"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionLinearInterpolate\'MaterialExpressionLinearInterpolate_0\'"',
  '   NodePosX=-300',
  '   CustomProperties Pin (PinId=N0_A,PinName="A",LinkedTo=(MaterialGraphNode_1 N1_OUT,))',
  '   CustomProperties Pin (PinId=N0_B,PinName="B",LinkedTo=(MaterialGraphNode_2 N2_OUT,))',
  '   CustomProperties Pin (PinId=N0_AL,PinName="Alpha",LinkedTo=(MaterialGraphNode_3 N3_OUT,))',
  '   CustomProperties Pin (PinId=N0_OUT,PinName="Output",Direction="EGPD_Output")',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_1"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionComponentMask\'MaterialExpressionComponentMask_0\'"',
  '   R=True',
  '   G=True',
  '   B=True',
  '   NodePosX=-600',
  '   CustomProperties Pin (PinId=N1_IN,PinName="Input",PinType.PinCategory="required",LinkedTo=(MaterialGraphNode_4 N4_OUT,))',
  '   CustomProperties Pin (PinId=N1_OUT,PinName="Output",Direction="EGPD_Output")',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_2"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionVectorParameter\'MaterialExpressionVectorParameter_0\'"',
  '   DefaultValue=(R=0.279188,G=0.299881,B=0.322917,A=1.000000)',
  '   ParameterName="FogColor"',
  '   NodePosX=-600',
  '   NodePosY=200',
  '   CustomProperties Pin (PinId=N2_OUT,PinName="Output",Direction="EGPD_Output",PinType.PinCategory="mask")',
  '   CustomProperties Pin (PinId=N2_A,PinName="Output5",Direction="EGPD_Output",PinType.PinCategory="mask",PinType.PinSubCategory="alpha")',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_3"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionMultiply\'MaterialExpressionMultiply_0\'"',
  '   NodePosX=-500',
  '   CustomProperties Pin (PinId=N3_A,PinName="A",LinkedTo=(MaterialGraphNode_5 N5_OUT,))',
  '   CustomProperties Pin (PinId=N3_B,PinName="B",LinkedTo=(MaterialGraphNode_2 N2_A,))',
  '   CustomProperties Pin (PinId=N3_OUT,PinName="Output",Direction="EGPD_Output")',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_4"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionSceneTexture\'MaterialExpressionSceneTexture_0\'"',
  '   SceneTextureId=PPI_PostProcessInput0',
  '   NodePosX=-900',
  '   CustomProperties Pin (PinId=N4_OUT,PinName="Color",Direction="EGPD_Output",PinType.PinCategory="mask")',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_5"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionSaturate\'MaterialExpressionSaturate_0\'"',
  '   NodePosX=-800',
  '   CustomProperties Pin (PinId=N5_IN,PinName="Input",PinType.PinCategory="required",LinkedTo=(MaterialGraphNode_7 N7_OUT,))',
  '   CustomProperties Pin (PinId=N5_OUT,PinName="Output",Direction="EGPD_Output")',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_6"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionScalarParameter\'MaterialExpressionScalarParameter_0\'"',
  '   DefaultValue=2500.000000',
  '   ParameterName="FogDistance"',
  '   NodePosX=-1100',
  '   CustomProperties Pin (PinId=N6_OUT,PinName="Output",Direction="EGPD_Output")',
  'End Object',
  'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_7"',
  '   MaterialExpression="/Script/Engine.MaterialExpressionMultiply\'MaterialExpressionMultiply_1\'"',
  '   NodePosX=-1000',
  '   CustomProperties Pin (PinId=N7_A,PinName="A",LinkedTo=(MaterialGraphNode_6 N6_OUT,))',
  '   CustomProperties Pin (PinId=N7_B,PinName="B",DefaultValue="0.01")',
  '   CustomProperties Pin (PinId=N7_OUT,PinName="Output",Direction="EGPD_Output")',
  'End Object',
].join("\n");

const BLUEPRINT_SNIPPET = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
  '   CustomFunctionName="MyEvent"',
  'End Object',
].join("\n");

describe("detectGraphType", () => {
  it("routes a material paste to the material engine", () => {
    expect(detectGraphType(FOG_PAYLOAD)).toBe("material");
  });
  it("routes a blueprint paste to the blueprint engine", () => {
    expect(detectGraphType(BLUEPRINT_SNIPPET)).toBe("blueprint");
  });
  it("defaults empty input to blueprint", () => {
    expect(detectGraphType("")).toBe("blueprint");
  });
});

describe("parseMaterial", () => {
  const parsed = parseMaterial(FOG_PAYLOAD);

  it("parses every wrapper node and finds the root", () => {
    expect(parsed.nodes.length).toBe(9);
    expect(parsed.rootNode).toBeTruthy();
    expect(parsed.rootNode.name).toBe("MaterialGraphNode_Root_0");
  });

  it("reads the inner MaterialExpression class as the node type", () => {
    const lerp = parsed.byName.get("MaterialGraphNode_0");
    expect(lerp.exprType).toBe("LinearInterpolate");
    expect(lerp.friendly).toBe("Lerp");
  });

  it("labels operators with their symbol", () => {
    expect(parsed.byName.get("MaterialGraphNode_3").friendly).toBe("Multiply (×)");
  });

  it("names parameters with their authored value", () => {
    expect(parsed.byName.get("MaterialGraphNode_6").friendly).toBe("Scalar: FogDistance = 2500.000000");
    expect(parsed.byName.get("MaterialGraphNode_2").friendly).toBe("Vector: FogColor");
  });

  it("folds component-mask channels into the title", () => {
    expect(parsed.byName.get("MaterialGraphNode_1").friendly).toBe("Mask RGB");
  });

  it("reads scene-texture id into the title", () => {
    expect(parsed.byName.get("MaterialGraphNode_4").friendly).toBe("Scene Texture: PPI_PostProcessInput0");
  });

  it("resolves LinkedTo pin names so wires can be followed", () => {
    const lerp = parsed.byName.get("MaterialGraphNode_0");
    const aPin = lerp.pins.find((p) => p.PinName === "A");
    expect(aPin.LinkedTo[0].nodeName).toBe("MaterialGraphNode_1");
    expect(aPin.LinkedTo[0].pinName).toBe("Output");
  });
});

describe("renderMaterialASCII", () => {
  const parsed = parseMaterial(FOG_PAYLOAD);
  const ascii = renderMaterialASCII(parsed, { showDataPins: true });

  it("heads the tree with the Material Output and its driven pin", () => {
    expect(ascii.startsWith("Material Output")).toBe(true);
    expect(ascii).toContain("Emissive Color ← Lerp");
  });

  it("expands a shared node once with an anchor and references it elsewhere", () => {
    // FogColor feeds both Lerp.B and Multiply.B -> anchored, expanded once.
    expect(ascii).toContain("[#1] Vector: FogColor");
    expect(ascii).toContain("(shown above)");
    const anchorExpansions = ascii.split("\n").filter((l) => /\[#1\] Vector: FogColor(?! \.| \()/.test(l) && !l.includes("shown above"));
    expect(anchorExpansions.length).toBe(1);
  });

  it("annotates which output channel a wire reads", () => {
    // Multiply.B reads the .A (alpha) channel of the vector parameter.
    expect(ascii).toContain(".A (shown above)");
  });

  it("surfaces an inline constant operand on a math node", () => {
    expect(ascii).toContain("B = 0.01");
  });

  it("hides inline operands when data pins are off", () => {
    const bare = renderMaterialASCII(parsed, { showDataPins: false });
    expect(bare).not.toContain("B = 0.01");
    // Wired structure still renders.
    expect(bare).toContain("Emissive Color ← Lerp");
  });

  it("renders terminal nodes when no Material Output is present", () => {
    const noRoot = parseMaterial([
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_9"',
      '   MaterialExpression="/Script/Engine.MaterialExpressionSaturate\'MaterialExpressionSaturate_9\'"',
      '   CustomProperties Pin (PinId=A,PinName="Input",LinkedTo=(MaterialGraphNode_10 B,))',
      '   CustomProperties Pin (PinId=O,PinName="Output",Direction="EGPD_Output")',
      'End Object',
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_10"',
      '   MaterialExpression="/Script/Engine.MaterialExpressionConstant\'MaterialExpressionConstant_9\'"',
      '   R=0.5',
      '   CustomProperties Pin (PinId=B,PinName="Output",Direction="EGPD_Output")',
      'End Object',
    ].join("\n"));
    const out = renderMaterialASCII(noRoot, { showDataPins: true });
    expect(out.startsWith("Saturate")).toBe(true);
  });
});

describe("extractMaterialMetadata", () => {
  const parsed = parseMaterial(FOG_PAYLOAD);
  const meta = extractMaterialMetadata(parsed);

  it("reports graph type and material name", () => {
    expect(meta.graphType).toBe("material");
    expect(meta.functionName).toBe("PPM_CheapFog");
  });

  it("collects parameters with type and default", () => {
    const byName = Object.fromEntries(meta.parameters.map((p) => [p.name, p]));
    expect(byName.FogColor.type).toBe("Vector");
    expect(byName.FogDistance.type).toBe("Scalar");
    expect(byName.FogDistance.default).toBe("2500.000000");
  });

  it("lists the connected material outputs", () => {
    expect(meta.outputs).toEqual(["Emissive Color"]);
  });
});

describe("generateMaterialReviewNotes", () => {
  it("flags nodes that don't reach the Material Output", () => {
    const stranded = parseMaterial([
      FOG_PAYLOAD,
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_99"',
      '   MaterialExpression="/Script/Engine.MaterialExpressionSine\'MaterialExpressionSine_0\'"',
      '   CustomProperties Pin (PinId=Z,PinName="Output",Direction="EGPD_Output")',
      'End Object',
    ].join("\n"));
    const notes = generateMaterialReviewNotes(stranded);
    const labels = notes.map((n) => n.label).join(" ");
    expect(labels).toContain("not reaching output");
  });

  it("flags a paste with no Material Output node", () => {
    const noRoot = parseMaterial([
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_9"',
      '   MaterialExpression="/Script/Engine.MaterialExpressionSaturate\'MaterialExpressionSaturate_9\'"',
      '   CustomProperties Pin (PinId=O,PinName="Output",Direction="EGPD_Output")',
      'End Object',
    ].join("\n"));
    expect(generateMaterialReviewNotes(noRoot).map((n) => n.label)).toContain("no Material Output");
  });
});

// Real UE clipboard text (a slice of a PPM_CheapFog post-process material):
// double-nested expression objects, full GUID pin ids, PinFriendlyName=NSLOCTEXT,
// OutputIndex, and a comment box. Guards the real-format parsing path that the
// hand-built payloads above abstract away.
const FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/material-fog.txt", import.meta.url)),
  "utf8",
);

describe("real UE material paste (fixture)", () => {
  const parsed = parseMaterial(FIXTURE);
  const ascii = renderMaterialASCII(parsed, { showDataPins: true });

  it("parses the double-nested expression wrappers and finds the root", () => {
    expect(detectGraphType(FIXTURE)).toBe("material");
    expect(parsed.rootNode).toBeTruthy();
    expect(parsed.comments.length).toBe(1);
  });

  it("renders Emissive ← Lerp from the Material Output", () => {
    expect(ascii.startsWith("Material Output")).toBe(true);
    expect(ascii).toContain("Emissive Color ← Lerp");
  });

  it("anchors both shared subgraphs (FogColor param, Saturate) once", () => {
    expect(ascii).toContain("[#1] Vector: FogColor");
    expect(ascii).toContain(".A (shown above)");
    expect(ascii).toContain("(shown above)");
  });

  it("surfaces the comment box as a region label", () => {
    expect(ascii).toContain("comment regions: Blend");
  });

  it("never throws on links whose targets are outside the paste", () => {
    // Trimmed fixture: some upstream nodes are absent; those render as "← ?".
    expect(ascii).toContain("← ?");
  });
});

describe("deriveMaterialFilenameBase", () => {
  it("prefers an explicit name", () => {
    const parsed = parseMaterial(FOG_PAYLOAD);
    expect(deriveMaterialFilenameBase(parsed, "MyFog")).toBe("MyFog");
  });
  it("falls back to the material asset name", () => {
    const parsed = parseMaterial(FOG_PAYLOAD);
    expect(deriveMaterialFilenameBase(parsed, "")).toBe("PPM_CheapFog");
  });
});
