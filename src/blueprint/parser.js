// ============================================================================
// blueprint/parser.js — UE Blueprint copy/paste text → node graph.
// Walks Begin Object / End Object blocks with depth tracking (nested blocks
// like CustomEvent's UserDefinedPins must not be misread as top-level nodes),
// parses each pin's properties (handling commas inside parens and quoted
// strings), and resolves LinkedTo pin IDs to pin names so downstream
// consumers don't have to. Also builds an enum registry from any
// Switch on Enum nodes so display labels can be resolved later.
// ============================================================================

import {
  matchField, extractQuoted, humanize, isAsyncNode, isLatentCallFunction,
  isImpureVariableGet, splitTopLevelBlocks, parsePinLine, PIN_REGEX,
} from "./common.js";

// Pull the last asset/class identifier out of a UE object-reference value like
//   InputAction'"/Game/Input/IA_Jump.IA_Jump"'   or
//   "/Script/EnhancedInput.InputAction'/Game/Input/IA_Jump.IA_Jump'"
// The asset name is always the segment after the final '.' or '/'.
function extractAssetName(value) {
  if (!value) return null;
  const cleaned = value.replace(/['"]/g, "").trim();
  const m = cleaned.match(/([A-Za-z0-9_]+)$/);
  return m ? m[1] : null;
}

function friendlyNameFor(node) {
  const cls = node.nodeClass;
  const block = node.raw;

  if (cls === "K2Node_IfThenElse") return "Branch";
  if (cls === "K2Node_ExecutionSequence") return "Sequence";
  if (cls === "K2Node_Knot") return "Reroute";
  if (cls === "K2Node_Self") return "Self";

  if (cls === "K2Node_EnhancedInputAction") {
    const ia = matchField(block, "InputAction");
    const name = extractAssetName(ia);
    return name ? "Enhanced Input: " + name : "Enhanced Input Action";
  }
  if (cls === "K2Node_InputAction") {
    const m = block.match(/InputActionName="?([^",\n)]+)"?/);
    return m ? "Input Action: " + m[1] : "Input Action";
  }
  if (cls === "K2Node_InputKey") {
    const m = block.match(/InputKey=\(KeyName="?([^",\n)]+)"?/);
    return m ? "Input Key: " + m[1] : "Input Key";
  }
  if (cls === "K2Node_InputAxisEvent" || cls === "K2Node_InputAxisKeyEvent") {
    const m = block.match(/(?:InputAxisName|AxisKey)=\(?(?:KeyName=)?"?([^",\n)]+)"?/);
    return m ? "Input Axis: " + m[1] : "Input Axis";
  }
  if (cls === "K2Node_InputTouch") return "Input Touch";

  if (cls === "K2Node_LoadAsset") return "Async Load Asset";
  if (cls === "K2Node_LoadAssetClass") return "Async Load Asset Class";
  if (cls === "K2Node_LatentGameplayTaskCall" || cls === "K2Node_LatentAbilityCall") {
    const proxy = matchField(block, "ProxyFactoryFunctionName");
    const name = proxy ? extractQuoted(proxy) : null;
    return name ? humanize(name) : "Ability Task";
  }
  if (isAsyncNode(node)) {
    // Generic async catch-all: prefer the ProxyFactoryFunctionName (the static
    // factory that returns the BlueprintAsyncActionBase) over the ProxyClass,
    // since the factory's name is what shows up on the Blueprint palette.
    const proxy = matchField(block, "ProxyFactoryFunctionName");
    if (proxy) {
      const name = extractQuoted(proxy);
      if (name) return humanize(name);
    }
    const proxyCls = matchField(block, "ProxyClass");
    const clsName = extractAssetName(proxyCls);
    return clsName ? humanize(clsName) : "Async Action";
  }

  if (cls === "K2Node_Event") {
    const ref = matchField(block, "EventReference");
    if (ref) {
      const m = ref.match(/MemberName="?([^",)]+)"?/);
      if (m) {
        let n = m[1];
        if (n.startsWith("Receive")) n = n.slice(7);
        return "Event " + humanize(n);
      }
    }
    return "Event";
  }

  if (cls === "K2Node_CustomEvent") {
    const fn = matchField(block, "CustomFunctionName");
    return "Custom Event: " + extractQuoted(fn || "?");
  }

  if (cls === "K2Node_ComponentBoundEvent" || cls === "K2Node_ActorBoundEvent") {
    // UE displays these as "<humanized delegate> (<owner variable>)" — e.g.
    // "On Component Begin Overlap (CollisionComponent)". Without this branch
    // the generic fallback returns the bare class name, which doesn't match
    // anything the user can see in the editor.
    const delegate = matchField(block, "DelegatePropertyName");
    const delegateName = delegate ? humanize(extractQuoted(delegate)) : "Bound Event";
    const ownerField = cls === "K2Node_ComponentBoundEvent" ? "ComponentPropertyName" : "EventOwner";
    const owner = matchField(block, ownerField);
    const ownerName = owner ? extractQuoted(owner).replace(/^.*[\.\/:]/, "").replace(/['"_]+$/, "") : "";
    return ownerName ? delegateName + " (" + ownerName + ")" : delegateName;
  }

  if (cls === "K2Node_CallFunction") {
    const ref = matchField(block, "FunctionReference");
    const latentPrefix = isLatentCallFunction(node) ? "(latent) " : "";
    if (ref) {
      const m = ref.match(/MemberName="?([^",)]+)"?/);
      if (m) return latentPrefix + humanize(m[1]);
    }
    return latentPrefix + "Call Function";
  }

  if (cls === "K2Node_CallArrayFunction") {
    // KismetArrayLibrary call. Surface the specific operation (Array_Add,
    // Array_RemoveIndex, Array_Length, ...) instead of a generic header so a
    // graph with multiple array ops can be audited per operation.
    const ref = matchField(block, "FunctionReference");
    if (ref) {
      const m = ref.match(/MemberName="?([^",)]+)"?/);
      if (m) return humanize(m[1]);
    }
    return "CallArrayFunction";
  }

  if (cls === "K2Node_VariableGet") {
    // An impure ("Convert to Validated Get") VariableGet sits on the exec
    // chain. Without flagging it in the title, it reads identically to a pure
    // get — the user has no way to tell from the diagram that the get is
    // gating execution.
    const prefix = isImpureVariableGet(node) ? "Validated Get: " : "Get ";
    const ref = matchField(block, "VariableReference");
    if (ref) {
      const m = ref.match(/MemberName="?([^",)]+)"?/);
      if (m) return prefix + m[1];
    }
    return prefix + "Variable";
  }
  if (cls === "K2Node_VariableSet") {
    const ref = matchField(block, "VariableReference");
    if (ref) {
      const m = ref.match(/MemberName="?([^",)]+)"?/);
      if (m) return "SET " + m[1];
    }
    return "Set Variable";
  }

  if (cls === "K2Node_DynamicCast") {
    const target = matchField(block, "TargetType");
    if (target) {
      const m = target.match(/[\.\/]([A-Za-z0-9_]+)['"]?$/) || target.match(/([A-Za-z0-9_]+)['"]?$/);
      if (m) return "Cast To " + m[1];
    }
    return "Cast";
  }

  if (cls === "K2Node_MacroInstance") {
    const ref = matchField(block, "MacroGraphReference");
    if (ref) {
      // The value looks like:
      //   (MacroGraph="/Script/Engine.EdGraph'/Engine/...:ForEachLoop'",GraphBlueprint=...)
      // We want the name after the last ':'.
      const m = ref.match(/:([A-Za-z0-9_]+)['"]/);
      if (m) return m[1];
    }
    return "Macro";
  }

  if (cls.startsWith("K2Node_Switch_")) return "Switch on " + cls.replace("K2Node_Switch_", "");
  if (cls === "K2Node_SwitchEnum") return "Switch on Enum";
  if (cls === "K2Node_SwitchInteger") return "Switch on Int";
  if (cls === "K2Node_SwitchString") return "Switch on String";
  if (cls === "K2Node_SwitchName") return "Switch on Name";

  if (cls === "K2Node_FunctionEntry") {
    const fn = matchField(block, "FunctionReference");
    if (fn) {
      const m = fn.match(/MemberName="?([^",)]+)"?/);
      if (m) return "Function Entry: " + m[1];
    }
    return "Function Entry";
  }
  if (cls === "K2Node_FunctionResult") return "Return Node";

  if (cls === "K2Node_SpawnActorFromClass") return "Spawn Actor From Class";
  if (cls === "K2Node_CreateDelegate") return "Create Event";
  if (cls === "K2Node_Composite") {
    // BoundGraph value looks like: EdGraph'"K2Node_Composite_4:MyCollapsedRegion"'
    // The user-facing name is the segment after the final ':'.
    const bg = matchField(block, "BoundGraph");
    if (bg) {
      const m = bg.match(/:([A-Za-z0-9_]+)['"]/);
      if (m) return "Collapsed: " + m[1];
    }
    return "Collapsed Graph";
  }
  if (cls === "K2Node_Tunnel") {
    // Entry tunnels drive the inner exec flow (exec OUT); exit tunnels receive
    // it (exec IN). Only meaningful when someone pastes from inside a collapsed
    // graph — in the outer view a tunnel never appears.
    const hasExecOut = node.pins.some((p) => p.PinCategory === "exec" && p.Direction === "EGPD_Output");
    return hasExecOut ? "Collapsed Entry" : "Collapsed Exit";
  }
  if (cls === "K2Node_CallDelegate") {
    const ref = matchField(block, "DelegateReference");
    if (ref) {
      const m = ref.match(/MemberName="?([^",)]+)"?/);
      if (m) return "Call " + m[1];
    }
    return "CallDelegate";
  }
  // Delegate binding nodes all extend K2Node_BaseMCDelegate and share the
  // DelegateReference field. Match UE editor labels so the diagram reads the
  // same as what the user sees in the graph.
  if (cls === "K2Node_AddDelegate" || cls === "K2Node_RemoveDelegate" ||
      cls === "K2Node_ClearDelegate" || cls === "K2Node_AssignDelegate") {
    const ref = matchField(block, "DelegateReference");
    const m = ref ? ref.match(/MemberName="?([^",)]+)"?/) : null;
    const name = m ? m[1] : null;
    const prefix =
      cls === "K2Node_AddDelegate" ? "Bind Event to " :
      cls === "K2Node_RemoveDelegate" ? "Unbind Event from " :
      cls === "K2Node_ClearDelegate" ? "Unbind all Events from " :
      "Assign ";
    if (name) return prefix + name;
    return prefix.trim().replace(/\s+$/, "");
  }
  if (cls === "K2Node_DoOnce") return "Do Once";
  if (cls === "K2Node_MultiGate") return "MultiGate";
  if (cls === "K2Node_Select") {
    // Selects by enum carry SelectionEnum=/Script/...EnumName'. Selects by int
    // / bool don't have it; render as plain "Select" in that case.
    const enumField = matchField(block, "SelectionEnum");
    if (enumField) {
      const name = extractEnumName(enumField);
      if (name) return "Select on " + name;
    }
    return "Select";
  }
  if (cls === "K2Node_Timeline") {
    const tn = matchField(block, "TimelineName");
    return "Timeline: " + extractQuoted(tn || "?");
  }
  if (cls === "K2Node_CommutativeAssociativeBinaryOperator") return "Math Op";
  if (cls === "K2Node_MakeArray") return "Make Array";
  if (cls === "K2Node_GetArrayItem") return "Get Array Item";
  if (cls === "K2Node_PromotableOperator") {
    const ref = matchField(block, "FunctionReference");
    if (ref) {
      const m = ref.match(/MemberName="?([^",)]+)"?/);
      if (m) return humanize(m[1]);
    }
    return "Op";
  }

  return cls.replace(/^K2Node_/, "").replace(/_/g, " ");
}

export function parseBlueprint(text) {
  const blocks = splitTopLevelBlocks(text);
  const nodes = [];
  for (const block of blocks) {
    const firstLine = block.split("\n")[0];
    const headerMatch = firstLine.match(/Class=([^\s]+)\s+Name="([^"]+)"/);
    if (!headerMatch) continue;
    const node = {
      raw: block,
      rawClass: headerMatch[1],
      nodeClass: headerMatch[1].split(".").pop(),
      name: headerMatch[2],
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

    node.friendly = friendlyNameFor(node);
    nodes.push(node);
  }

  const byName = new Map();
  for (const n of nodes) byName.set(n.name, n);

  // Resolve link target pin IDs to pin names so the renderer doesn't have to.
  for (const n of nodes) {
    for (const p of n.pins) {
      for (const link of p.LinkedTo) {
        const target = byName.get(link.nodeName);
        if (target) {
          const targetPin = target.pins.find((tp) => tp.PinId === link.pinId);
          if (targetPin) link.pinName = targetPin.PinName;
        }
      }
    }
  }

  // Build an enum registry from every node that serializes the enum's display
  // table. Switch on Enum is the common source, but Select on Enum and other
  // nodes embed the same EnumEntries (internal names like "NewEnumerator0") and
  // EnumFriendlyNames (display names like "Integrity") arrays. Scanning all of
  // them (not just SwitchEnum) means a SET or Select value can resolve to its
  // readable label even when no Switch on that enum is present in the paste.
  // The internal name's trailing digits encode the underlying integer ID. We
  // key the registry by enum name (last segment of the asset path) so it can be
  // looked up from data pin types elsewhere.
  const enumRegistry = new Map();
  for (const n of nodes) {
    if (!/^\s*EnumFriendlyNames\(\d+\)=/m.test(n.raw)) continue;
    const enumName = enumNameForNode(n);
    if (!enumName || enumRegistry.has(enumName)) continue;
    enumRegistry.set(enumName, parseEnumMap(n.raw));
  }

  return { nodes, byName, enumRegistry };
}

// -- Enum helpers (used by parseBlueprint and by the renderer) ---------------

export function parseEnumMap(rawBlock) {
  const lines = rawBlock.split(/\r?\n/);
  const entries = new Map();
  const friendlies = new Map();
  for (const line of lines) {
    let m = line.match(/^\s*EnumEntries\((\d+)\)="([^"]*)"/);
    if (m) { entries.set(parseInt(m[1], 10), m[2]); continue; }
    m = line.match(/^\s*EnumFriendlyNames\((\d+)\)=(.+)$/);
    if (m) {
      const val = m[2].trim();
      const fm = val.match(/"([^"]*)"\s*\)\s*$/);
      friendlies.set(parseInt(m[1], 10), fm ? fm[1] : val.replace(/^["']|["']$/g, ""));
    }
  }
  const result = new Map();
  for (const [idx, entryName] of entries) {
    const idMatch = entryName.match(/(\d+)$/);
    const id = idMatch ? parseInt(idMatch[1], 10) : null;
    result.set(entryName, { id, friendly: friendlies.get(idx) || null });
  }
  return result;
}

export function extractEnumName(value) {
  if (!value) return null;
  const m = value.match(/([A-Za-z0-9_]+)[^A-Za-z0-9_]*$/);
  return m ? m[1] : null;
}

// Identify which enum a node's embedded display table belongs to. Switch on
// Enum names it via Enum=, Select on Enum via SelectionEnum=; fall back to the
// first data pin's PinSubCategoryObject for any other table-carrying node.
function enumNameForNode(node) {
  const field = matchField(node.raw, "Enum") || matchField(node.raw, "SelectionEnum");
  if (field) {
    const name = extractEnumName(field);
    if (name) return name;
  }
  const enumPin = node.pins.find((p) => p.PinCategory === "byte" && p.PinSubCategoryObject);
  return enumPin ? extractEnumName(enumPin.PinSubCategoryObject) : null;
}

// The literal a pin carries: the explicit DefaultValue when set, otherwise the
// AutogeneratedDefaultValue UE falls back to when a typed value matches the pin
// type's generated default. Returns null when neither is meaningful.
export function pinLiteralValue(pin) {
  if (pin.DefaultValue !== null && pin.DefaultValue !== undefined && pin.DefaultValue !== "") {
    return pin.DefaultValue;
  }
  if (pin.AutogeneratedDefaultValue !== null && pin.AutogeneratedDefaultValue !== undefined &&
      pin.AutogeneratedDefaultValue !== "") {
    return pin.AutogeneratedDefaultValue;
  }
  return null;
}

export function formatEnumLabel(entryName, info) {
  if (!info) return entryName;
  const display = info.friendly || entryName;
  return info.id !== null ? display + " (ID " + info.id + ")" : display;
}

export function resolveEnumDefault(pin, enumRegistry) {
  if (!enumRegistry || pin.PinCategory !== "byte" || !pin.PinSubCategoryObject) return null;
  const enumName = extractEnumName(pin.PinSubCategoryObject);
  if (!enumName) return null;
  const map = enumRegistry.get(enumName);
  if (!map) return null;
  const literal = pinLiteralValue(pin);
  return literal !== null ? (map.get(literal) || null) : null;
}
