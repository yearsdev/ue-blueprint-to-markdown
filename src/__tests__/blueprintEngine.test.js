import { describe, it, expect } from "vitest";
import {
  parseBlueprint, extractFunctionMetadata, deriveFilenameBase, renderASCII,
  generateReviewNotes,
} from "../blueprintEngine.js";

// Minimal UE Blueprint copy/paste payload: one CustomEvent feeding one
// CallFunction via the exec wire. Built by hand to keep the test readable.
const TWO_NODE_PAYLOAD = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
  '   NodePosX=0',
  '   NodePosY=0',
  '   CustomFunctionName="MyEvent"',
  '   CustomProperties Pin (PinId=AAA,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_0 BBB,))',
  'End Object',
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_0"',
  '   NodePosX=200',
  '   NodePosY=0',
  '   FunctionReference=(MemberName="DoThing")',
  '   CustomProperties Pin (PinId=BBB,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 AAA,))',
  'End Object',
].join("\n");

// Nested Begin Object: a CustomEvent with a UserDefinedPin sub-block. The
// parser's depth counter is the only thing keeping the inner block from
// being treated as a top-level node.
const NESTED_PAYLOAD = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
  '   CustomFunctionName="EvtWithParams"',
  '   Begin Object Class=/Script/Engine.UserDefinedPin Name="UserDefinedPin_0"',
  '      VarName="Amount"',
  '      VarType=(PinCategory="int")',
  '   End Object',
  '   CustomProperties Pin (PinId=CCC,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
  'End Object',
].join("\n");

// FunctionEntry + FunctionResult — feeds extractFunctionMetadata's name + return path.
const FUNCTION_PAYLOAD = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_FunctionEntry Name="K2Node_FunctionEntry_0"',
  '   FunctionReference=(MemberName="ComputeScore")',
  '   CustomProperties Pin (PinId=F1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=F2,PinName="InputValue",Direction="EGPD_Output",PinType.PinCategory="int")',
  'End Object',
  'Begin Object Class=/Script/BlueprintGraph.K2Node_FunctionResult Name="K2Node_FunctionResult_0"',
  '   CustomProperties Pin (PinId=F3,PinName="execute",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=F4,PinName="ReturnValue",PinType.PinCategory="int")',
  'End Object',
].join("\n");

describe("parseBlueprint", () => {
  it("returns an empty graph on empty input", () => {
    const r = parseBlueprint("");
    expect(r.nodes.length).toBe(0);
    expect(r.byName.size).toBe(0);
  });

  it("extracts top-level Begin Object blocks", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    expect(r.nodes.length).toBe(2);
    expect(r.byName.get("K2Node_CustomEvent_0")).toBeTruthy();
    expect(r.byName.get("K2Node_CallFunction_0")).toBeTruthy();
  });

  it("derives nodeClass from the Class header (last segment after dot)", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const evt = r.byName.get("K2Node_CustomEvent_0");
    expect(evt.nodeClass).toBe("K2Node_CustomEvent");
  });

  it("defaults pin Direction to EGPD_Input when the field is absent (UE only emits Direction for outputs)", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const call = r.byName.get("K2Node_CallFunction_0");
    const execPin = call.pins.find((p) => p.PinName === "execute");
    expect(execPin.Direction).toBe("EGPD_Input");
  });

  it("resolves LinkedTo pin names from pin IDs across nodes", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const evt = r.byName.get("K2Node_CustomEvent_0");
    const thenPin = evt.pins.find((p) => p.PinName === "then");
    expect(thenPin.LinkedTo.length).toBe(1);
    // pinName gets resolved from the target's pin table
    expect(thenPin.LinkedTo[0].pinName).toBe("execute");
  });

  it("handles nested Begin Object blocks without treating them as top-level nodes", () => {
    const r = parseBlueprint(NESTED_PAYLOAD);
    expect(r.nodes.length).toBe(1);
    expect(r.nodes[0].nodeClass).toBe("K2Node_CustomEvent");
  });

  it("parses node position fields", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const call = r.byName.get("K2Node_CallFunction_0");
    expect(call.posX).toBe(200);
    expect(call.posY).toBe(0);
  });

  it("populates a friendly name for known node classes", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const call = r.byName.get("K2Node_CallFunction_0");
    expect(call.friendly).toBe("Do Thing"); // humanized from "DoThing"
  });

  it("surfaces the specific operation on a K2Node_CallArrayFunction header", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallArrayFunction Name="K2Node_CallArrayFunction_0"',
      '   FunctionReference=(MemberName="Array_RemoveIndex",MemberParent=Class\'"/Script/Engine.KismetArrayLibrary"\')',
      '   CustomProperties Pin (PinId=A1,PinName="execute",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallArrayFunction Name="K2Node_CallArrayFunction_1"',
      '   FunctionReference=(MemberName="Array_Length",MemberParent=Class\'"/Script/Engine.KismetArrayLibrary"\')',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallArrayFunction Name="K2Node_CallArrayFunction_2"',
      // No FunctionReference - exercises the fallback branch.
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    expect(r.byName.get("K2Node_CallArrayFunction_0").friendly).toBe("Array Remove Index");
    expect(r.byName.get("K2Node_CallArrayFunction_1").friendly).toBe("Array Length");
    expect(r.byName.get("K2Node_CallArrayFunction_2").friendly).toBe("CallArrayFunction");
  });
});

describe("extractFunctionMetadata", () => {
  it("pulls the function name from a FunctionEntry", () => {
    const r = parseBlueprint(FUNCTION_PAYLOAD);
    const meta = extractFunctionMetadata(r);
    expect(meta.functionName).toBe("ComputeScore");
  });

  it("collects FunctionEntry output pins as parameters (skipping exec)", () => {
    const r = parseBlueprint(FUNCTION_PAYLOAD);
    const meta = extractFunctionMetadata(r);
    const names = meta.parameters.map((p) => p.name);
    expect(names).toContain("InputValue");
    expect(names).not.toContain("then"); // exec pin filtered out
  });

  it("collects FunctionResult input pins as returns (skipping exec)", () => {
    const r = parseBlueprint(FUNCTION_PAYLOAD);
    const meta = extractFunctionMetadata(r);
    const names = meta.returns.map((p) => p.name);
    expect(names).toContain("ReturnValue");
    expect(names).not.toContain("execute"); // exec pin filtered out
  });

  it("falls back to event name when no FunctionEntry exists", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const meta = extractFunctionMetadata(r);
    expect(meta.functionName).toContain("MyEvent");
  });

  it("counts K2Node_CallArrayFunction nodes as engine-library calls", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallArrayFunction Name="K2Node_CallArrayFunction_0"',
      '   FunctionReference=(MemberName="Array_Add",MemberParent=Class\'"/Script/Engine.KismetArrayLibrary"\')',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallArrayFunction Name="K2Node_CallArrayFunction_1"',
      '   FunctionReference=(MemberName="Array_Add",MemberParent=Class\'"/Script/Engine.KismetArrayLibrary"\')',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallArrayFunction Name="K2Node_CallArrayFunction_2"',
      '   FunctionReference=(MemberName="Array_Length",MemberParent=Class\'"/Script/Engine.KismetArrayLibrary"\')',
      'End Object',
    ].join("\n");
    const meta = extractFunctionMetadata(parseBlueprint(payload));
    expect(meta.calls.engine.get("KismetArrayLibrary.Array_Add")).toBe(2);
    expect(meta.calls.engine.get("KismetArrayLibrary.Array_Length")).toBe(1);
  });
});

describe("deriveFilenameBase", () => {
  it("uses the explicit name when provided", () => {
    const r = parseBlueprint("");
    expect(deriveFilenameBase(r, "  my-doc  ")).toBe("my-doc");
  });

  it("derives a name from component + function metadata when no explicit name", () => {
    const r = parseBlueprint(FUNCTION_PAYLOAD);
    const result = deriveFilenameBase(r, "");
    expect(result).toContain("ComputeScore");
  });

  it("falls back to 'diagram' when there is no name and no parsed function", () => {
    expect(deriveFilenameBase(null, "")).toBe("diagram");
  });
});

describe("renderASCII", () => {
  it("returns a non-empty string for a graph with an entry node", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: false });
    expect(typeof ascii).toBe("string");
    expect(ascii.length).toBeGreaterThan(0);
  });

  it("doesn't crash on an empty graph", () => {
    const r = parseBlueprint("");
    expect(() => renderASCII(r, { showDataPins: false })).not.toThrow();
  });

  // ForEachLoopWithBreak has two exec inputs (the standard entry + BreakLoop).
  // An incoming exec wire to BreakLoop looks identical to a normal entry-pin
  // wire on the rendered diagram unless we annotate the target pin. Bug 1 from
  // the Stage E audit: undisambiguated join pointers made break wires
  // indistinguishable from re-enter wires.
  it("disambiguates multi-exec-input macro joins on connector, join pointer, and header", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_Start"',
      '   CustomFunctionName="StartLoop"',
      '   CustomProperties Pin (PinId=S1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_MacroInstance_FE M1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_Stop"',
      '   CustomFunctionName="StopLoop"',
      '   CustomProperties Pin (PinId=S2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_MacroInstance_FE M2,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_MacroInstance Name="K2Node_MacroInstance_FE"',
      '   MacroGraphReference=(MacroGraph="/Script/Engine.EdGraph\'/Engine/EditorBlueprintResources/StandardMacros.StandardMacros:ForEachLoopWithBreak\'",GraphBlueprint=None)',
      '   CustomProperties Pin (PinId=M1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_Start S1,))',
      '   CustomProperties Pin (PinId=M2,PinName="BreakLoop",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_Stop S2,))',
      '   CustomProperties Pin (PinId=M4,PinName="LoopBody",Direction="EGPD_Output",PinType.PinCategory="exec")',
      '   CustomProperties Pin (PinId=M5,PinName="Completed",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: false });
    // Connector arrow on each wire identifies the entry pin.
    expect(ascii).toMatch(/into:\s*BreakLoop/);
    expect(ascii).toMatch(/into:\s*execute/);
    // Join pointer carries the entry pin so a grep for "BreakLoop" finds
    // every place a wire targets the break input, including the redirect.
    expect(ascii).toMatch(/continues at \[join 1: ForEachLoopWithBreak\.BreakLoop\]/);
    expect(ascii).toMatch(/continues at \[join 1: ForEachLoopWithBreak\.execute\]/);
    // Join header lists predecessors with their target pin so the "from:"
    // line itself encodes break-vs-reenter.
    expect(ascii).toMatch(/StartLoop → execute/);
    expect(ascii).toMatch(/StopLoop → BreakLoop/);
  });

  // Single-exec-input targets stay unlabeled — labeling every normal edge
  // would add noise without disambiguating anything.
  it("does not annotate incoming exec when the target has only one exec input", () => {
    const r = parseBlueprint(TWO_NODE_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: false });
    expect(ascii).not.toMatch(/into:/);
    expect(ascii).not.toMatch(/→ execute/);
  });

  // Bug 2 from the Stage E audit: when a Set node read a struct field straight
  // off a Break Struct, the export displayed "Field: <- Field" — the proximate
  // Break Struct node was invisible, making mutation chains look like no-ops.
  it("names Break Struct as the proximate source when a downstream pin reads a field directly off it", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
      '   CustomFunctionName="Tick"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_Set X1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_BreakStruct Name="K2Node_BreakStruct_0"',
      '   CustomProperties Pin (PinId=B2,PinName="Quantity_2_AB",PinFriendlyName=NSLOCTEXT("","","Quantity"),Direction="EGPD_Output",PinType.PinCategory="int",LinkedTo=(K2Node_CallFunction_Set X2,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_Set"',
      '   FunctionReference=(MemberName="SetSomething")',
      '   CustomProperties Pin (PinId=X1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
      '   CustomProperties Pin (PinId=X2,PinName="Quantity",PinType.PinCategory="int",LinkedTo=(K2Node_BreakStruct_0 B2,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/Quantity:\s*<-\s*Break Struct \(Quantity\)/);
  });

  // Bug 3 from the Stage E audit: pure constructor nodes (Make Struct / Make
  // Array) have no exec pins, so they never render as their own flow boxes.
  // Without expansion, any wire fanning out into a Make Struct's input was
  // invisible — including the LocalQuestItemsStored → Make.QuestItemsStored
  // wire that triggered the SpawnDeathMarker false positive on 2026-05-20.
  it("surfaces each wire fanning into a Make Struct as an indented binding under the consumer", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
      '   CustomFunctionName="SpawnDeathMarker"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_Spawn X1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_LineTrace"',
      '   FunctionReference=(MemberName="LineTraceSingle")',
      '   CustomProperties Pin (PinId=L1,PinName="HitLocation",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(K2Node_MakeStruct_0 M1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="K2Node_GetItems"',
      '   VariableReference=(MemberName="LocalQuestItemsStored",bSelfContext=True)',
      '   CustomProperties Pin (PinId=V1,PinName="LocalQuestItemsStored",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(K2Node_MakeStruct_0 M3,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_MakeStruct Name="K2Node_MakeStruct_0"',
      '   CustomProperties Pin (PinId=M1,PinName="Location",PinType.PinCategory="struct",LinkedTo=(K2Node_LineTrace L1,))',
      '   CustomProperties Pin (PinId=M3,PinName="QuestItemsStored",PinType.PinCategory="struct",LinkedTo=(K2Node_GetItems V1,))',
      '   CustomProperties Pin (PinId=M4,PinName="HasBeenLooted",PinType.PinCategory="bool",DefaultValue="false")',
      '   CustomProperties Pin (PinId=M5,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(K2Node_Spawn X3,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_SpawnActorFromClass Name="K2Node_Spawn"',
      '   CustomProperties Pin (PinId=X1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
      '   CustomProperties Pin (PinId=X3,PinName="MarkerData",PinType.PinCategory="struct",LinkedTo=(K2Node_MakeStruct_0 M5,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    // The Make Struct itself is still the proximate source on the main row.
    expect(ascii).toMatch(/MarkerData:\s*<-\s*Make Struct/);
    // Each field's wire is surfaced as its own indented subline. The
    // QuestItemsStored ← LocalQuestItemsStored binding was previously
    // invisible because Make Struct has no exec pins; this is the wire whose
    // absence triggered the audit false positive.
    expect(ascii).toMatch(/Location\s*←\s*Line Trace Single\(\)/);
    expect(ascii).toMatch(/QuestItemsStored\s*←\s*LocalQuestItemsStored/);
    // Wired bindings use ← ; defaults use = . Mixing them lets the reader
    // tell at a glance which fields were explicitly set vs left default.
    expect(ascii).toMatch(/HasBeenLooted\s*=\s*false/);
  });

  // A Make Struct with no wired inputs and no explicit defaults still renders
  // as a bare "Make Struct" with no parens or binding lines.
  it("renders an empty Make Struct as just the node name with no expansion", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
      '   CustomFunctionName="Tick"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_Spawn X1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_MakeStruct Name="K2Node_MakeStruct_0"',
      '   CustomProperties Pin (PinId=M5,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(K2Node_Spawn X3,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_SpawnActorFromClass Name="K2Node_Spawn"',
      '   CustomProperties Pin (PinId=X1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
      '   CustomProperties Pin (PinId=X3,PinName="MarkerData",PinType.PinCategory="struct",LinkedTo=(K2Node_MakeStruct_0 M5,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/MarkerData:\s*<-\s*Make Struct\s*│/);
    // No binding lines should follow on the next row.
    const idx = ascii.indexOf("MarkerData:");
    const nextRow = ascii.slice(idx).split("\n")[1];
    expect(nextRow).not.toMatch(/←/);
  });

  // When a Make Struct sits between source data and a writeback target, the
  // proximate Make Struct must be the reported source — not the upstream node.
  // Locks in the proximate-not-origin contract for value traceback.
  it("reports Make Struct as the proximate source for a value pin, not anything upstream of the Make", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
      '   CustomFunctionName="Tick"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_Set X1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_GAI"',
      '   FunctionReference=(MemberName="Array_Get")',
      '   CustomProperties Pin (PinId=G1,PinName="Item",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(K2Node_MakeStruct_0 M1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_MakeStruct Name="K2Node_MakeStruct_0"',
      '   CustomProperties Pin (PinId=M1,PinName="HasBeenLooted",PinType.PinCategory="bool",LinkedTo=(K2Node_CallFunction_GAI G1,))',
      '   CustomProperties Pin (PinId=M3,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(K2Node_CallFunction_Set X2,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_Set"',
      '   FunctionReference=(MemberName="Array_Set")',
      '   CustomProperties Pin (PinId=X1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
      '   CustomProperties Pin (PinId=X2,PinName="Item",PinType.PinCategory="struct",LinkedTo=(K2Node_MakeStruct_0 M3,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/Item:\s*<-\s*Make Struct/);
    expect(ascii).not.toMatch(/Item:\s*<-\s*Array Get/);
  });
});

// EnhancedInputAction node serialized as it appears in UE 5.6 clipboard text.
// InputAction is a UPROPERTY (not a pin) and the five exec outs are the
// ETriggerEvent values. Only Triggered is wired in this fixture.
const ENHANCED_INPUT_PAYLOAD = [
  'Begin Object Class=/Script/InputBlueprintNodes.K2Node_EnhancedInputAction Name="K2Node_EnhancedInputAction_0"',
  '   InputAction=InputAction\'"/Game/Input/Actions/IA_Jump.IA_Jump"\'',
  '   NodePosX=0',
  '   NodePosY=0',
  '   CustomProperties Pin (PinId=EI1,PinName="Triggered",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_X CALL1,))',
  '   CustomProperties Pin (PinId=EI2,PinName="Started",Direction="EGPD_Output",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=EI3,PinName="Ongoing",Direction="EGPD_Output",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=EI4,PinName="Canceled",Direction="EGPD_Output",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=EI5,PinName="Completed",Direction="EGPD_Output",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=EI6,PinName="ActionValue",Direction="EGPD_Output",PinType.PinCategory="struct")',
  'End Object',
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_X"',
  '   FunctionReference=(MemberName="Jump")',
  '   CustomProperties Pin (PinId=CALL1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_EnhancedInputAction_0 EI1,))',
  'End Object',
].join("\n");

// Async action node (AsyncLoadAsset-style): driven by an upstream CustomEvent,
// with two completion branches via the dynamic OnSuccess / OnFailure delegates.
// Only OnSuccess is wired in this fixture so we can verify that OnFailure
// still renders as a labeled unwired branch (rather than being collapsed away).
const ASYNC_NODE_PAYLOAD = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
  '   CustomFunctionName="StartLoad"',
  '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_AsyncAction_0 A1,))',
  'End Object',
  'Begin Object Class=/Script/BlueprintGraph.K2Node_AsyncAction Name="K2Node_AsyncAction_0"',
  '   ProxyFactoryFunctionName="LoadSomeData"',
  '   ProxyClass=Class\'"/Script/MyGame.LoadSomeDataAction"\'',
  '   CustomProperties Pin (PinId=A1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
  '   CustomProperties Pin (PinId=A2,PinName="OnSuccess",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_AS DONE,))',
  '   CustomProperties Pin (PinId=A3,PinName="OnFailure",Direction="EGPD_Output",PinType.PinCategory="exec")',
  'End Object',
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_AS"',
  '   FunctionReference=(MemberName="HandleLoaded")',
  '   CustomProperties Pin (PinId=DONE,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_AsyncAction_0 A2,))',
  'End Object',
].join("\n");

// Latent Delay: serialized as a plain CallFunction with a hidden LatentInfo
// pin. The hidden flag isn't emitted on the pin payload itself in this minimal
// fixture, only the LatentInfo PinName — that's what the detector keys off.
const LATENT_DELAY_PAYLOAD = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_0"',
  '   FunctionReference=(MemberParent=Class\'"/Script/Engine.KismetSystemLibrary"\',MemberName="Delay")',
  '   CustomProperties Pin (PinId=D1,PinName="execute",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=D2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
  '   CustomProperties Pin (PinId=D3,PinName="Duration",PinType.PinCategory="real",DefaultValue="0.2")',
  '   CustomProperties Pin (PinId=D4,PinName="LatentInfo",PinType.PinCategory="struct")',
  'End Object',
].join("\n");

describe("Enhanced Input", () => {
  it("treats K2Node_EnhancedInputAction as an entry node and renders its trigger pins", () => {
    const r = parseBlueprint(ENHANCED_INPUT_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: false });
    // Treated as entry: no "orphan nodes" header should appear for it.
    expect(ascii).not.toMatch(/orphan nodes/);
    // All trigger pins render even when only one is wired.
    expect(ascii).toContain("Triggered");
    expect(ascii).toContain("Started");
    expect(ascii).toContain("Completed");
  });

  it("extracts the InputAction asset name into the friendly name", () => {
    const r = parseBlueprint(ENHANCED_INPUT_PAYLOAD);
    const node = r.byName.get("K2Node_EnhancedInputAction_0");
    expect(node.friendly).toBe("Enhanced Input: IA_Jump");
  });

  it("orders exec outputs Triggered → Started → Ongoing → Canceled → Completed", () => {
    const r = parseBlueprint(ENHANCED_INPUT_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: false });
    const lines = ascii.split("\n");
    const idx = (label) => lines.findIndex((l) => l.includes("── " + label));
    expect(idx("Triggered")).toBeGreaterThanOrEqual(0);
    expect(idx("Triggered")).toBeLessThan(idx("Started"));
    expect(idx("Started")).toBeLessThan(idx("Ongoing"));
    expect(idx("Ongoing")).toBeLessThan(idx("Canceled"));
    expect(idx("Canceled")).toBeLessThan(idx("Completed"));
  });

  it("emits a review note reminding the user to add the mapping context", () => {
    const r = parseBlueprint(ENHANCED_INPUT_PAYLOAD);
    const notes = generateReviewNotes(r);
    expect(notes.some((n) => /AddMappingContext/.test(n.text))).toBe(true);
  });
});

describe("Async actions", () => {
  it("derives friendly name from ProxyFactoryFunctionName", () => {
    const r = parseBlueprint(ASYNC_NODE_PAYLOAD);
    const node = r.byName.get("K2Node_AsyncAction_0");
    expect(node.friendly).toBe("Load Some Data");
  });

  it("treats async nodes as branch-like and labels every completion pin, wired or not", () => {
    const r = parseBlueprint(ASYNC_NODE_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: false });
    expect(ascii).toContain("OnSuccess");
    expect(ascii).toContain("OnFailure");
    // Unwired OnFailure pin should still surface as an explicit unconnected branch.
    expect(ascii).toMatch(/OnFailure[\s\S]*\(unconnected\)/);
  });

  it("emits a review note flagging silent-failure risk on async completion pins", () => {
    const r = parseBlueprint(ASYNC_NODE_PAYLOAD);
    const notes = generateReviewNotes(r);
    expect(notes.some((n) => /Async node/.test(n.label) || /Async/.test(n.text))).toBe(true);
  });
});

// Component-bound event — what you get when you right-click a component and
// "Add OnComponentBeginOverlap". Editor shows it as
// "On Component Begin Overlap (CollisionComponent)".
const COMPONENT_BOUND_EVENT_PAYLOAD = [
  'Begin Object Class=/Script/BlueprintGraph.K2Node_ComponentBoundEvent Name="K2Node_ComponentBoundEvent_0"',
  '   DelegatePropertyName="OnComponentBeginOverlap"',
  '   ComponentPropertyName="CollisionComponent"',
  '   CustomProperties Pin (PinId=CB1,PinName="OutputDelegate",Direction="EGPD_Output",PinType.PinCategory="delegate")',
  '   CustomProperties Pin (PinId=CB2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
  'End Object',
].join("\n");

describe("Bound events", () => {
  it("formats ComponentBoundEvent as '<humanized delegate> (<component>)'", () => {
    const r = parseBlueprint(COMPONENT_BOUND_EVENT_PAYLOAD);
    const node = r.byName.get("K2Node_ComponentBoundEvent_0");
    expect(node.friendly).toBe("On Component Begin Overlap (CollisionComponent)");
  });

  it("classifies ComponentBoundEvent as an entry node, not an orphan", () => {
    const r = parseBlueprint(COMPONENT_BOUND_EVENT_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: false });
    expect(ascii).not.toMatch(/orphan nodes/);
  });
});

describe("Latent CallFunction", () => {
  it("flags latent calls via the (latent) prefix on the friendly name", () => {
    const r = parseBlueprint(LATENT_DELAY_PAYLOAD);
    const node = r.byName.get("K2Node_CallFunction_0");
    expect(node.friendly.startsWith("(latent) ")).toBe(true);
    expect(node.friendly).toContain("Delay");
  });

  it("emits a review note explaining the LatentInfo constraint", () => {
    const r = parseBlueprint(LATENT_DELAY_PAYLOAD);
    const notes = generateReviewNotes(r);
    expect(notes.some((n) => /LatentInfo/.test(n.text))).toBe(true);
  });
});

// "Convert to Validated Get" / "Convert to Branch" in UE drops a K2Node_
// VariableGet onto the exec chain by setting bIsPureGet=False and adding exec
// pins. Without distinct titling and labeled outputs, the diagram reads
// identically to a pure Get, which is what the user flagged on 2026-05-21.
describe("Impure (validated) VariableGet", () => {
  const IMPURE_EXECUTE_THEN = [
    'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_1"',
    '   CustomFunctionName="ExecuteMeleeAttack"',
    '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_VariableGet_15 G1,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="K2Node_VariableGet_15"',
    '   VariableReference=(MemberName="bIsAttacking",bSelfContext=True)',
    '   bIsPureGet=False',
    '   CustomProperties Pin (PinId=G1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_1 E1,))',
    '   CustomProperties Pin (PinId=G2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_1 C1,))',
    '   CustomProperties Pin (PinId=G3,PinName="bIsAttacking",Direction="EGPD_Output",PinType.PinCategory="bool")',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_1"',
    '   FunctionReference=(MemberName="DoAttack")',
    '   CustomProperties Pin (PinId=C1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_VariableGet_15 G2,))',
    'End Object',
  ].join("\n");

  const VALIDATED_GET_PARTIAL = [
    'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_1"',
    '   CustomFunctionName="OnHit"',
    '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_VariableGet_15 G1,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="K2Node_VariableGet_15"',
    '   VariableReference=(MemberName="ChaseTarget",bSelfContext=True)',
    '   bIsPureGet=False',
    '   CustomProperties Pin (PinId=G1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_1 E1,))',
    '   CustomProperties Pin (PinId=G2,PinName="IsValid",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_1 C1,))',
    '   CustomProperties Pin (PinId=G4,PinName="IsNotValid",Direction="EGPD_Output",PinType.PinCategory="exec")',
    '   CustomProperties Pin (PinId=G3,PinName="ChaseTarget",Direction="EGPD_Output",PinType.PinCategory="object")',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_1"',
    '   FunctionReference=(MemberName="DoAttack")',
    '   CustomProperties Pin (PinId=C1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_VariableGet_15 G2,))',
    'End Object',
  ].join("\n");

  it("titles an impure VariableGet as 'Validated Get: ...' so the exec-chain role is visible", () => {
    const r = parseBlueprint(IMPURE_EXECUTE_THEN);
    const node = r.byName.get("K2Node_VariableGet_15");
    expect(node.friendly).toBe("Validated Get: bIsAttacking");
  });

  it("leaves a pure VariableGet's friendly name as 'Get VarName'", () => {
    const pure = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="K2Node_PureGet"',
      '   VariableReference=(MemberName="HitPoints",bSelfContext=True)',
      '   CustomProperties Pin (PinId=PG1,PinName="HitPoints",Direction="EGPD_Output",PinType.PinCategory="int")',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(pure);
    expect(r.byName.get("K2Node_PureGet").friendly).toBe("Get HitPoints");
  });

  it("renders the impure execute/then variant as a flow box with a labeled 'then' connector", () => {
    const r = parseBlueprint(IMPURE_EXECUTE_THEN);
    const ascii = renderASCII(r, { showDataPins: false });
    expect(ascii).toContain("Validated Get: bIsAttacking");
    // The outgoing connector is now labeled so the reader can tell which exec
    // pin drove the next step — without this, the impure get looks identical
    // in shape to a pure get used as a value source.
    expect(ascii).toMatch(/├── then/);
    expect(ascii).toContain("Do Attack");
  });

  it("surfaces both branches of a validated get (IsValid wired, IsNotValid dangling)", () => {
    const r = parseBlueprint(VALIDATED_GET_PARTIAL);
    const ascii = renderASCII(r, { showDataPins: false });
    expect(ascii).toContain("Validated Get: ChaseTarget");
    expect(ascii).toMatch(/├── IsValid/);
    expect(ascii).toMatch(/├── IsNotValid[\s\S]*\(unconnected\)/);
  });

  it("keeps the value-pin source description as the bare variable name when wired into a downstream data pin", () => {
    // A consumer that reads the impure Get's value pin should still say
    // "<- VarName", not "<- Validated Get: VarName". The validated-prefix is
    // a title-level affordance, not a data-source one.
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_1"',
      '   CustomFunctionName="OnHit"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_VariableGet_15 G1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="K2Node_VariableGet_15"',
      '   VariableReference=(MemberName="ChaseTarget",bSelfContext=True)',
      '   bIsPureGet=False',
      '   CustomProperties Pin (PinId=G1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_1 E1,))',
      '   CustomProperties Pin (PinId=G2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_1 C1,))',
      '   CustomProperties Pin (PinId=G3,PinName="ChaseTarget",Direction="EGPD_Output",PinType.PinCategory="object",LinkedTo=(K2Node_CallFunction_1 C2,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_1"',
      '   FunctionReference=(MemberName="DoAttack")',
      '   CustomProperties Pin (PinId=C1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_VariableGet_15 G2,))',
      '   CustomProperties Pin (PinId=C2,PinName="Target",PinType.PinCategory="object",LinkedTo=(K2Node_VariableGet_15 G3,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/Target:\s*<-\s*ChaseTarget/);
    expect(ascii).not.toMatch(/Target:\s*<-\s*Validated Get/);
  });
});

// Regression: "Unconnected output(s)" review note must not false-positive on
// branches whose exec out is wired, even when the wire routes through a Knot
// (reroute) or terminates at a shared join target.
describe("Unconnected-output review note false-positive guard", () => {
  it("does not flag a Branch whose 'then' is wired through a Knot reroute", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
      '   CustomFunctionName="Start"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_0 I1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="K2Node_IfThenElse_0"',
      '   CustomProperties Pin (PinId=I1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
      '   CustomProperties Pin (PinId=I2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_Knot_0 K1,))',
      '   CustomProperties Pin (PinId=I3,PinName="else",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_1 C2,))',
      '   CustomProperties Pin (PinId=I4,PinName="Condition",PinType.PinCategory="bool")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Knot Name="K2Node_Knot_0"',
      '   CustomProperties Pin (PinId=K1,PinName="InputPin",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_0 I2,))',
      '   CustomProperties Pin (PinId=K2,PinName="OutputPin",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_0 C1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_0"',
      '   FunctionReference=(MemberName="DoOnTrue")',
      '   CustomProperties Pin (PinId=C1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_Knot_0 K2,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_1"',
      '   FunctionReference=(MemberName="DoOnFalse")',
      '   CustomProperties Pin (PinId=C2,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_0 I3,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const notes = generateReviewNotes(r);
    const unconnected = notes.filter((n) => /^Unconnected output/.test(n.label));
    expect(unconnected).toEqual([]);
  });

  it("does not flag branches whose outputs join at a shared downstream target", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
      '   CustomFunctionName="Start"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_0 I1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="K2Node_IfThenElse_0"',
      '   CustomProperties Pin (PinId=I1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
      '   CustomProperties Pin (PinId=I2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_1 J1,))',
      '   CustomProperties Pin (PinId=I3,PinName="else",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_0 C1,))',
      '   CustomProperties Pin (PinId=I4,PinName="Condition",PinType.PinCategory="bool")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="K2Node_IfThenElse_1"',
      '   CustomProperties Pin (PinId=J1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_0 I2,K2Node_CallFunction_0 C1b,))',
      '   CustomProperties Pin (PinId=J2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_2 C2,))',
      '   CustomProperties Pin (PinId=J3,PinName="else",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_2 C2,))',
      '   CustomProperties Pin (PinId=J4,PinName="Condition",PinType.PinCategory="bool")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_0"',
      '   FunctionReference=(MemberName="Detour")',
      '   CustomProperties Pin (PinId=C1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_0 I3,))',
      '   CustomProperties Pin (PinId=C1b,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_1 J1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_2"',
      '   FunctionReference=(MemberName="Converged")',
      '   CustomProperties Pin (PinId=C2,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_IfThenElse_1 J2,K2Node_IfThenElse_1 J3,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const notes = generateReviewNotes(r);
    const unconnected = notes.filter((n) => /^Unconnected output/.test(n.label));
    expect(unconnected).toEqual([]);
  });
});

describe("Delegate binding nodes", () => {
  const cases = [
    ["K2Node_AddDelegate", "Bind Event to OnDoorOpened"],
    ["K2Node_RemoveDelegate", "Unbind Event from OnDoorOpened"],
    ["K2Node_ClearDelegate", "Unbind all Events from OnDoorOpened"],
    ["K2Node_AssignDelegate", "Assign OnDoorOpened"],
  ];
  for (const [cls, expected] of cases) {
    it("titles " + cls + " using the dispatcher name from DelegateReference", () => {
      const payload = [
        'Begin Object Class=/Script/BlueprintGraph.' + cls + ' Name="' + cls + '_0"',
        '   DelegateReference=(MemberName="OnDoorOpened",bSelfContext=True)',
        '   CustomProperties Pin (PinId=D1,PinName="execute",PinType.PinCategory="exec")',
        '   CustomProperties Pin (PinId=D2,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
        'End Object',
      ].join("\n");
      const r = parseBlueprint(payload);
      expect(r.byName.get(cls + "_0").friendly).toBe(expected);
    });
  }
});

describe("DoOnce / MultiGate / Select", () => {
  it("titles K2Node_DoOnce as 'Do Once'", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_DoOnce Name="K2Node_DoOnce_0"',
      '   CustomProperties Pin (PinId=D1,PinName="Start",PinType.PinCategory="exec")',
      '   CustomProperties Pin (PinId=D2,PinName="Reset",PinType.PinCategory="exec")',
      '   CustomProperties Pin (PinId=D3,PinName="Completed",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    expect(r.byName.get("K2Node_DoOnce_0").friendly).toBe("Do Once");
  });

  it("titles K2Node_MultiGate as 'MultiGate' and treats it as branch-like so multi-out connectors are labeled", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CustomEvent Name="K2Node_CustomEvent_0"',
      '   CustomFunctionName="Start"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_MultiGate_0 M1,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_MultiGate Name="K2Node_MultiGate_0"',
      '   CustomProperties Pin (PinId=M1,PinName="Enter",PinType.PinCategory="exec",LinkedTo=(K2Node_CustomEvent_0 E1,))',
      '   CustomProperties Pin (PinId=M2,PinName="Out 0",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(K2Node_CallFunction_0 C1,))',
      '   CustomProperties Pin (PinId=M3,PinName="Out 1",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="K2Node_CallFunction_0"',
      '   FunctionReference=(MemberName="DoFirst")',
      '   CustomProperties Pin (PinId=C1,PinName="execute",PinType.PinCategory="exec",LinkedTo=(K2Node_MultiGate_0 M2,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    expect(r.byName.get("K2Node_MultiGate_0").friendly).toBe("MultiGate");
    const ascii = renderASCII(r, { showDataPins: false });
    expect(ascii).toMatch(/├── Out 0/);
    // The unwired Out 1 should be surfaced as a labeled unconnected branch.
    expect(ascii).toMatch(/Out 1[\s\S]*\(unconnected\)/);
  });

  it("titles K2Node_Select with the SelectionEnum name when present", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Select Name="K2Node_Select_0"',
      '   SelectionEnum=/Script/CoreUObject.Enum\'"/Game/Enums/E_Difficulty.E_Difficulty"\'',
      '   CustomProperties Pin (PinId=S1,PinName="Index",PinType.PinCategory="byte")',
      '   CustomProperties Pin (PinId=S2,PinName="Return Value",Direction="EGPD_Output",PinType.PinCategory="int")',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    expect(r.byName.get("K2Node_Select_0").friendly).toBe("Select on E_Difficulty");
  });

  it("falls back to plain 'Select' when no SelectionEnum is present", () => {
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Select Name="K2Node_Select_0"',
      '   CustomProperties Pin (PinId=S1,PinName="Index",PinType.PinCategory="int")',
      '   CustomProperties Pin (PinId=S2,PinName="Return Value",Direction="EGPD_Output",PinType.PinCategory="int")',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    expect(r.byName.get("K2Node_Select_0").friendly).toBe("Select");
  });
});

describe("Inline literal operands in comparisons and enum nodes", () => {
  // A Branch driven by (SearchState == Idle OR SearchState == Patrolling). The
  // OR feeds two K2Node_EnumEquality nodes, each comparing a SearchState getter
  // against an inline enumerator literal on its B pin. A Switch on the same enum
  // supplies the display-name table.
  const ENUM_EQ_PAYLOAD = [
    'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
    '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(Branch BR_IN,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="Branch"',
    '   CustomProperties Pin (PinId=BR_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
    '   CustomProperties Pin (PinId=BR_C,PinName="Condition",PinType.PinCategory="bool",LinkedTo=(OrNode OR_OUT,))',
    '   CustomProperties Pin (PinId=BR_T,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
    '   CustomProperties Pin (PinId=BR_E,PinName="else",Direction="EGPD_Output",PinType.PinCategory="exec")',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_PromotableOperator Name="OrNode"',
    '   FunctionReference=(MemberName="BooleanOR")',
    '   CustomProperties Pin (PinId=OR_A,PinName="A",PinType.PinCategory="bool",LinkedTo=(EqA EQA_OUT,))',
    '   CustomProperties Pin (PinId=OR_B,PinName="B",PinType.PinCategory="bool",LinkedTo=(EqB EQB_OUT,))',
    '   CustomProperties Pin (PinId=OR_OUT,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="bool",LinkedTo=(Branch BR_C,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_EnumEquality Name="EqA"',
    '   CustomProperties Pin (PinId=EQA_A,PinName="A",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\',LinkedTo=(GetState GS_OUT,))',
    '   CustomProperties Pin (PinId=EQA_B,PinName="B",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\',DefaultValue="NewEnumerator0")',
    '   CustomProperties Pin (PinId=EQA_OUT,PinName="bResult",Direction="EGPD_Output",PinType.PinCategory="bool",LinkedTo=(OrNode OR_A,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_EnumEquality Name="EqB"',
    '   CustomProperties Pin (PinId=EQB_A,PinName="A",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\',LinkedTo=(GetState GS_OUT,))',
    '   CustomProperties Pin (PinId=EQB_B,PinName="B",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\',DefaultValue="NewEnumerator1")',
    '   CustomProperties Pin (PinId=EQB_OUT,PinName="bResult",Direction="EGPD_Output",PinType.PinCategory="bool",LinkedTo=(OrNode OR_B,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetState"',
    '   VariableReference=(MemberName="SearchState")',
    '   CustomProperties Pin (PinId=GS_OUT,PinName="SearchState",Direction="EGPD_Output",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\',LinkedTo=(EqA EQA_A,EqB EQB_A,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_SwitchEnum Name="Switch"',
    '   Enum=Enum\'"/Game/AI/E_SearchState.E_SearchState"\'',
    '   EnumEntries(0)="NewEnumerator0"',
    '   EnumEntries(1)="NewEnumerator1"',
    '   EnumFriendlyNames(0)=NSLOCTEXT("", "", "Idle")',
    '   EnumFriendlyNames(1)=NSLOCTEXT("", "", "Patrolling")',
    '   CustomProperties Pin (PinId=SW_IN,PinName="Selection",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\')',
    'End Object',
  ].join("\n");

  it("renders enum equality operands instead of the bare class name", () => {
    const r = parseBlueprint(ENUM_EQ_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).not.toMatch(/EnumEquality/);
    expect(ascii).toMatch(/SearchState == Idle/);
    // Second operand may be clipped by the subline width cap; assert on the
    // comparison head that always survives truncation.
    expect(ascii).toMatch(/OR SearchState ==/);
  });

  it("surfaces a numeric literal stored only as AutogeneratedDefaultValue", () => {
    // UE drops DefaultValue when the typed value equals the pin's generated
    // default, serializing AutogeneratedDefaultValue instead. The literal 0 on
    // the comparison's B pin must still appear inline rather than as '?'.
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(Branch BR_IN,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="Branch"',
      '   CustomProperties Pin (PinId=BR_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
      '   CustomProperties Pin (PinId=BR_C,PinName="Condition",PinType.PinCategory="bool",LinkedTo=(Gt GT_OUT,))',
      '   CustomProperties Pin (PinId=BR_T,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_PromotableOperator Name="Gt"',
      '   FunctionReference=(MemberName="Greater_DoubleDouble")',
      '   CustomProperties Pin (PinId=GT_A,PinName="A",PinType.PinCategory="real",LinkedTo=(GetR GR_OUT,))',
      '   CustomProperties Pin (PinId=GT_B,PinName="B",PinType.PinCategory="real",AutogeneratedDefaultValue="0")',
      '   CustomProperties Pin (PinId=GT_OUT,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="bool",LinkedTo=(Branch BR_C,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetR"',
      '   VariableReference=(MemberName="AggroRadius")',
      '   CustomProperties Pin (PinId=GR_OUT,PinName="AggroRadius",Direction="EGPD_Output",PinType.PinCategory="real",LinkedTo=(Gt GT_A,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/AggroRadius > 0/);
    expect(ascii).not.toMatch(/AggroRadius > \?/);
  });

  it("renders operands when a math op is a plain KismetMathLibrary CallFunction", () => {
    // UE serializes the common operators (Multiply_FloatFloat, Greater_..., etc.)
    // as plain K2Node_CallFunction nodes, not only the Promotable/Commutative
    // classes. SET Damage = BaseDamage * 2.5 where the 2.5 is a constant typed
    // directly into the multiply's B pin. Both the variable and the inline
    // constant must show instead of a bare "Multiply Float Float()" label.
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(SetD SD_IN,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableSet Name="SetD"',
      '   VariableReference=(MemberName="Damage")',
      '   CustomProperties Pin (PinId=SD_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
      '   CustomProperties Pin (PinId=SD_V,PinName="Damage",PinType.PinCategory="real",LinkedTo=(Mul MUL_OUT,))',
      '   CustomProperties Pin (PinId=SD_OUT,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="Mul"',
      '   FunctionReference=(MemberName="Multiply_FloatFloat",MemberParent=Class\'"/Script/Engine.KismetMathLibrary"\')',
      '   CustomProperties Pin (PinId=MUL_A,PinName="A",PinType.PinCategory="real",LinkedTo=(GetB GB_OUT,))',
      '   CustomProperties Pin (PinId=MUL_B,PinName="B",PinType.PinCategory="real",DefaultValue="2.5")',
      '   CustomProperties Pin (PinId=MUL_OUT,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="real",LinkedTo=(SetD SD_V,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetB"',
      '   VariableReference=(MemberName="BaseDamage")',
      '   CustomProperties Pin (PinId=GB_OUT,PinName="BaseDamage",Direction="EGPD_Output",PinType.PinCategory="real",LinkedTo=(Mul MUL_A,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/BaseDamage \* 2\.5/);
    expect(ascii).not.toMatch(/Multiply Float Float\(\)/);
  });

  it("resolves an enum operand left at its default (no serialized literal)", () => {
    // When an enum comparison targets the enum's zeroth member (e.g. Idle), UE
    // omits both DefaultValue and AutogeneratedDefaultValue on the operand pin.
    // The operand must still resolve to the default member via the enum table
    // rather than rendering "?".
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(Branch BR_IN,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="Branch"',
      '   CustomProperties Pin (PinId=BR_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
      '   CustomProperties Pin (PinId=BR_C,PinName="Condition",PinType.PinCategory="bool",LinkedTo=(Eq EQ_OUT,))',
      '   CustomProperties Pin (PinId=BR_T,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_EnumEquality Name="Eq"',
      '   CustomProperties Pin (PinId=EQ_A,PinName="A",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\',LinkedTo=(GetState GS_OUT,))',
      '   CustomProperties Pin (PinId=EQ_B,PinName="B",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\')',
      '   CustomProperties Pin (PinId=EQ_OUT,PinName="bResult",Direction="EGPD_Output",PinType.PinCategory="bool",LinkedTo=(Branch BR_C,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetState"',
      '   VariableReference=(MemberName="SearchState")',
      '   CustomProperties Pin (PinId=GS_OUT,PinName="SearchState",Direction="EGPD_Output",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\',LinkedTo=(Eq EQ_A,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_SwitchEnum Name="Switch"',
      '   Enum=Enum\'"/Game/AI/E_SearchState.E_SearchState"\'',
      '   EnumEntries(0)="NewEnumerator0"',
      '   EnumFriendlyNames(0)=NSLOCTEXT("", "", "Idle")',
      '   CustomProperties Pin (PinId=SW_IN,PinName="Selection",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_SearchState.E_SearchState"\')',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/SearchState == Idle/);
    expect(ascii).not.toMatch(/SearchState == \?/);
  });

  it("resolves an enum SET value via a table carried by a non-Switch node", () => {
    // The montage enum has no Switch in the paste; its display table rides on a
    // Select-on-enum node. The registry must pick that up so the SET resolves.
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(SetM SM_IN,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableSet Name="SetM"',
      '   VariableReference=(MemberName="CurrentMontage")',
      '   CustomProperties Pin (PinId=SM_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
      '   CustomProperties Pin (PinId=SM_V,PinName="CurrentMontage",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_Montage.E_Montage"\',DefaultValue="NewEnumerator15")',
      '   CustomProperties Pin (PinId=SM_OUT,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Select Name="Sel"',
      '   SelectionEnum=Enum\'"/Game/AI/E_Montage.E_Montage"\'',
      '   EnumEntries(15)="NewEnumerator15"',
      '   EnumFriendlyNames(15)=NSLOCTEXT("", "", "Reload")',
      '   CustomProperties Pin (PinId=SEL_IDX,PinName="Index",PinType.PinCategory="byte",PinType.PinSubCategoryObject=Enum\'"/Game/AI/E_Montage.E_Montage"\')',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    expect(r.enumRegistry.has("E_Montage")).toBe(true);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/CurrentMontage: Reload/);
    expect(ascii).not.toMatch(/NewEnumerator15/);
  });
});

describe("Operand source and target annotation", () => {
  // A faction guard: Self.FactionAffiliation != Cast(ArrayElem).FactionAffiliation.
  // The comparison is a promotable NotEqual whose operands are two member-gets of
  // the same variable read off different actors (own self vs a cast result).
  const FACTION_PAYLOAD = [
    'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
    '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(Branch BR_IN,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_IfThenElse Name="Branch"',
    '   CustomProperties Pin (PinId=BR_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
    '   CustomProperties Pin (PinId=BR_C,PinName="Condition",PinType.PinCategory="bool",LinkedTo=(Ne NE_OUT,))',
    '   CustomProperties Pin (PinId=BR_T,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_PromotableOperator Name="Ne"',
    '   OperationName="NotEqual"',
    '   FunctionReference=(MemberName="NotEqual_ByteByte")',
    '   CustomProperties Pin (PinId=NE_A,PinName="A",PinType.PinCategory="byte",LinkedTo=(GetSelfFac GSF_OUT,))',
    '   CustomProperties Pin (PinId=NE_B,PinName="B",PinType.PinCategory="byte",LinkedTo=(GetOtherFac GOF_OUT,))',
    '   CustomProperties Pin (PinId=NE_OUT,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="bool",LinkedTo=(Branch BR_C,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetSelfFac"',
    '   VariableReference=(MemberName="FactionAffiliation",bSelfContext=True)',
    '   CustomProperties Pin (PinId=GSF_SELF,PinName="self",PinType.PinCategory="object")',
    '   CustomProperties Pin (PinId=GSF_OUT,PinName="FactionAffiliation",Direction="EGPD_Output",PinType.PinCategory="byte",LinkedTo=(Ne NE_A,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetOtherFac"',
    '   VariableReference=(MemberName="FactionAffiliation")',
    '   CustomProperties Pin (PinId=GOF_SELF,PinName="self",PinType.PinCategory="object",LinkedTo=(CastNode CAST_OUT,))',
    '   CustomProperties Pin (PinId=GOF_OUT,PinName="FactionAffiliation",Direction="EGPD_Output",PinType.PinCategory="byte",LinkedTo=(Ne NE_B,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_DynamicCast Name="CastNode"',
    '   TargetType=Class\'"/Game/AI/BP_EnemyChar.BP_EnemyChar_C"\'',
    '   CustomProperties Pin (PinId=CAST_IN,PinName="Object",PinType.PinCategory="object",LinkedTo=(GetElem GE_OUT,))',
    '   CustomProperties Pin (PinId=CAST_OUT,PinName="AsBP Enemy Char",Direction="EGPD_Output",PinType.PinCategory="object",LinkedTo=(GetOtherFac GOF_SELF,))',
    'End Object',
    'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetElem"',
    '   VariableReference=(MemberName="ArrayElem")',
    '   CustomProperties Pin (PinId=GE_OUT,PinName="ArrayElem",Direction="EGPD_Output",PinType.PinCategory="object",LinkedTo=(CastNode CAST_IN,))',
    'End Object',
  ].join("\n");

  it("resolves the promotable operator and annotates each operand's source", () => {
    const r = parseBlueprint(FACTION_PAYLOAD);
    const ascii = renderASCII(r, { showDataPins: true });
    // Operator resolves from the bare OperationName instead of leaking "NotEqual".
    expect(ascii).toMatch(/!=/);
    expect(ascii).not.toMatch(/NotEqual/);
    // Self side and cast-of-array-element side are distinguishable.
    expect(ascii).toMatch(/Self\.FactionAffiliation != Cast\(ArrayElem\)/);
  });

  it("annotates the actor source feeding each spatial-node vector pin", () => {
    // LineTraceSingle with Start off Self and End off TargetActor, both via
    // GetActorLocation. The two endpoints must name distinct actor sources.
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(Trace TR_IN,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="Trace"',
      '   FunctionReference=(MemberName="LineTraceSingle",MemberParent=Class\'"/Script/Engine.KismetSystemLibrary"\')',
      '   CustomProperties Pin (PinId=TR_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
      '   CustomProperties Pin (PinId=TR_START,PinName="Start",PinType.PinCategory="struct",LinkedTo=(LocSelf LS_OUT,))',
      '   CustomProperties Pin (PinId=TR_END,PinName="End",PinType.PinCategory="struct",LinkedTo=(LocTgt LT_OUT,))',
      '   CustomProperties Pin (PinId=TR_THEN,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="LocSelf"',
      '   FunctionReference=(MemberName="K2_GetActorLocation",MemberParent=Class\'"/Script/Engine.Actor"\')',
      '   CustomProperties Pin (PinId=LS_SELF,PinName="self",PinType.PinCategory="object")',
      '   CustomProperties Pin (PinId=LS_OUT,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(Trace TR_START,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_CallFunction Name="LocTgt"',
      '   FunctionReference=(MemberName="K2_GetActorLocation",MemberParent=Class\'"/Script/Engine.Actor"\')',
      '   CustomProperties Pin (PinId=LT_SELF,PinName="self",PinType.PinCategory="object",LinkedTo=(GetTgt GT_OUT,))',
      '   CustomProperties Pin (PinId=LT_OUT,PinName="ReturnValue",Direction="EGPD_Output",PinType.PinCategory="struct",LinkedTo=(Trace TR_END,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetTgt"',
      '   VariableReference=(MemberName="TargetActor")',
      '   CustomProperties Pin (PinId=GT_OUT,PinName="TargetActor",Direction="EGPD_Output",PinType.PinCategory="object",LinkedTo=(LocTgt LT_SELF,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/Start: <- Self\.K2 Get Actor Location\(\)/);
    expect(ascii).toMatch(/End: <- TargetActor\.K2 Get Actor Location\(\)/);
  });

  it("leaves a plain local variable get unannotated (no spurious Self. prefix)", () => {
    // A get with no self pin is a local/temp read, not a member access; it must
    // not pick up a target-context prefix.
    const payload = [
      'Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="Evt"',
      '   CustomProperties Pin (PinId=E1,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec",LinkedTo=(SetX SX_IN,))',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableSet Name="SetX"',
      '   VariableReference=(MemberName="Counter")',
      '   CustomProperties Pin (PinId=SX_IN,PinName="execute",PinType.PinCategory="exec",LinkedTo=(Evt E1,))',
      '   CustomProperties Pin (PinId=SX_V,PinName="Counter",PinType.PinCategory="int",LinkedTo=(GetLocal GL_OUT,))',
      '   CustomProperties Pin (PinId=SX_OUT,PinName="then",Direction="EGPD_Output",PinType.PinCategory="exec")',
      'End Object',
      'Begin Object Class=/Script/BlueprintGraph.K2Node_VariableGet Name="GetLocal"',
      '   VariableReference=(MemberName="LoopIndex")',
      '   CustomProperties Pin (PinId=GL_OUT,PinName="LoopIndex",Direction="EGPD_Output",PinType.PinCategory="int",LinkedTo=(SetX SX_V,))',
      'End Object',
    ].join("\n");
    const r = parseBlueprint(payload);
    const ascii = renderASCII(r, { showDataPins: true });
    expect(ascii).toMatch(/Counter: <- LoopIndex/);
    expect(ascii).not.toMatch(/Self\.LoopIndex/);
  });
});
