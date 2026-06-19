// ============================================================================
// blueprint/renderer.js — ASCII flow diagram renderer.
// Walks exec flow forward from each entry node, emits boxes with join
// detection so shared subtrees render once with anchor references.
// ============================================================================

import {
  matchField, isExecPin, findEntryNodes, findOrphanNodes, isBranchLike, isExecutableNode,
} from "./common.js";
import {
  parseEnumMap, formatEnumLabel, resolveEnumDefault, pinLiteralValue, extractEnumName,
} from "./parser.js";

// -- Knot / reroute compression ---------------------------------------------

function resolveThroughKnots(targetName, targetPinName, byName, visited = new Set()) {
  const node = byName.get(targetName);
  if (!node) return { nodeName: targetName, pinName: targetPinName };
  if (node.nodeClass !== "K2Node_Knot") return { nodeName: targetName, pinName: targetPinName };
  if (visited.has(targetName)) return { nodeName: targetName, pinName: targetPinName };
  visited.add(targetName);

  const enteredOutput = node.pins.find((p) => p.Direction === "EGPD_Output" && p.PinName === targetPinName);
  const otherSidePin = node.pins.find((p) =>
    enteredOutput ? p.Direction === "EGPD_Input" : p.Direction === "EGPD_Output"
  );
  if (!otherSidePin || otherSidePin.LinkedTo.length === 0) {
    return { nodeName: targetName, pinName: targetPinName };
  }
  const next = otherSidePin.LinkedTo[0];
  return resolveThroughKnots(next.nodeName, next.pinName, byName, visited);
}

// resolveThroughKnots collapses a reroute to a SINGLE downstream target by
// following LinkedTo[0]. That's correct for backward DATA resolution — a data
// input pin has exactly one source — but wrong for FORWARD EXEC traversal: a
// reroute sitting on an exec line can fan its output out to several downstream
// inputs (a hub driving N nodes from one wire), and following only the first
// silently severs every other branch from the walk. Those nodes are never
// visited and never drawn — the omission the render warning now surfaces.
//
// This variant expands a knot into ALL of its downstream targets, recursing
// through chained reroutes. The shared `seen` set de-dupes so a diamond of
// reroutes that converges again yields one entry per real target; the shared
// `visited` set guards cyclic reroute loops (and is safe across sibling
// branches because the first visit to a knot already expands all of its
// targets, so a later branch hitting the same knot loses nothing).
function resolveExecThroughKnots(
  targetName, targetPinName, byName, visited = new Set(), out = [], seen = new Set()
) {
  const pushUnique = (nodeName, pinName) => {
    const key = nodeName + "::" + pinName;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ nodeName, pinName });
  };
  const node = byName.get(targetName);
  if (!node || node.nodeClass !== "K2Node_Knot") {
    pushUnique(targetName, targetPinName);
    return out;
  }
  if (visited.has(targetName)) return out;
  visited.add(targetName);

  const enteredOutput = node.pins.find((p) => p.Direction === "EGPD_Output" && p.PinName === targetPinName);
  const otherSidePin = node.pins.find((p) =>
    enteredOutput ? p.Direction === "EGPD_Input" : p.Direction === "EGPD_Output"
  );
  if (!otherSidePin || otherSidePin.LinkedTo.length === 0) {
    // A dangling reroute resolves to the knot itself; the caller (which filters
    // unknown targets) drops it, matching the single-target resolver's behavior.
    pushUnique(targetName, targetPinName);
    return out;
  }
  for (const link of otherSidePin.LinkedTo) {
    resolveExecThroughKnots(link.nodeName, link.pinName, byName, visited, out, seen);
  }
  return out;
}

// -- Exec graph analysis -----------------------------------------------------

function computeIncomingExecCounts(parseResult) {
  const counts = new Map();
  const predecessors = new Map();
  for (const node of parseResult.nodes) {
    if (node.nodeClass === "K2Node_Knot") continue;
    for (const pin of node.pins) {
      if (!isExecPin(pin)) continue;
      if (pin.Direction !== "EGPD_Output") continue;
      // Expand through reroutes to every downstream target so a fan-out reroute
      // contributes a predecessor edge to each node it actually drives — without
      // this, join detection undercounts and a converging branch can be missed.
      for (const link of pin.LinkedTo) {
        for (const resolved of resolveExecThroughKnots(link.nodeName, link.pinName, parseResult.byName)) {
          const target = resolved.nodeName;
          if (!predecessors.has(target)) predecessors.set(target, new Set());
          // Encode source + target pin so the join header can disambiguate two
          // wires that hit different input pins on a multi-entry target (e.g. one
          // wire to ForEachLoopWithBreak.execute and another to BreakLoop).
          predecessors.get(target).add(node.name + "::" + pin.PinName + "::" + resolved.pinName);
        }
      }
    }
  }
  for (const [target, preds] of predecessors) counts.set(target, preds.size);
  return { counts, predecessors };
}

function getOutgoingExecLinks(node, byName, includeUnconnected) {
  const out = [];
  for (const p of node.pins) {
    if (!isExecPin(p)) continue;
    if (p.Direction !== "EGPD_Output") continue;
    if (p.LinkedTo.length === 0) {
      if (includeUnconnected) {
        out.push({ pinName: p.PinName, friendlyName: p.PinFriendlyName, target: null });
      }
      continue;
    }
    // One exec output can drive several inputs (directly or fanned out through a
    // reroute), so expand every wire into all of its real downstream targets.
    // Following only the first would drop the rest of the branch from the walk.
    for (const link of p.LinkedTo) {
      for (const target of resolveExecThroughKnots(link.nodeName, link.pinName, byName)) {
        out.push({ pinName: p.PinName, friendlyName: p.PinFriendlyName, target });
      }
    }
  }
  return out;
}

// When a target node has more than one exec input (ForEachLoopWithBreak's
// BreakLoop, multi-entry macros, etc.), an unlabeled connector hides which
// entry pin is actually being driven. Return a label for the hit pin in that
// case so the diagram surfaces the distinction; return null when the target
// only has a single exec-in (the conventional case where no label adds info).
function getTargetExecPinLabel(targetNode, targetPinName) {
  if (!targetNode || !targetPinName) return null;
  const execInputs = targetNode.pins.filter(
    (p) => isExecPin(p) && p.Direction === "EGPD_Input"
  );
  if (execInputs.length <= 1) return null;
  const hit = execInputs.find((p) => p.PinName === targetPinName);
  if (!hit) return null;
  return hit.PinFriendlyName || hit.PinName;
}

// -- Data input description -------------------------------------------------

function getDataInputs(node, byName, enumRegistry) {
  const out = [];
  for (const p of node.pins) {
    if (isExecPin(p)) continue;
    if (p.Direction !== "EGPD_Input") continue;
    if (p.LinkedTo.length > 0) {
      const link = p.LinkedTo[0];
      const resolved = resolveThroughKnots(link.nodeName, link.pinName, byName);
      const sourceNode = byName.get(resolved.nodeName);
      const display = describeDataSource(sourceNode, resolved.pinName, byName, 0, enumRegistry);
      const entry = { name: p.PinName, value: "<- " + display };
      // When the proximate source is a pure constructor, attach its input
      // bindings so the consumer can surface the wires that fan into it.
      // Without this, those wires have no render slot anywhere in the export.
      if (isMakeNode(sourceNode)) {
        const bindings = describeMakeNodeBindings(sourceNode, byName, enumRegistry);
        if (bindings.length > 0) entry.bindings = bindings;
      }
      out.push(entry);
    } else if (p.DefaultValue !== null && p.DefaultValue !== "" && p.DefaultValue !== "0" && p.DefaultValue !== "None") {
      const enumInfo = resolveEnumDefault(p, enumRegistry);
      const value = enumInfo ? formatEnumLabel(p.DefaultValue, enumInfo) : p.DefaultValue;
      out.push({ name: p.PinName, value });
    }
  }
  return out;
}

const OPERATOR_SYMBOLS = {
  BooleanOR: "OR", BooleanAND: "AND", Boolean_OR: "OR", Boolean_AND: "AND", Boolean_NOT: "NOT",
  Multiply_DoubleDouble: "*", Multiply_IntInt: "*", Multiply_FloatFloat: "*", Multiply: "*",
  Add_DoubleDouble: "+", Add_IntInt: "+", Add_FloatFloat: "+", Add: "+",
  Subtract_DoubleDouble: "-", Subtract_IntInt: "-", Subtract_FloatFloat: "-", Subtract: "-",
  Divide_DoubleDouble: "/", Divide_IntInt: "/", Divide: "/",
  EqualEqual_DoubleDouble: "==", EqualEqual_IntInt: "==", EqualEqual_NameName: "==", EqualEqual_StringString: "==",
  EqualEqual_ByteByte: "==", EqualEqual_BoolBool: "==", EqualEqual_ObjectObject: "==",
  NotEqual_DoubleDouble: "!=", NotEqual_IntInt: "!=", NotEqual_NameName: "!=", NotEqual_StringString: "!=",
  NotEqual_ByteByte: "!=", NotEqual_BoolBool: "!=", NotEqual_ObjectObject: "!=",
  Greater_DoubleDouble: ">", Greater_IntInt: ">",
  Less_DoubleDouble: "<", Less_IntInt: "<",
  GreaterEqual_DoubleDouble: ">=", GreaterEqual_IntInt: ">=",
  LessEqual_DoubleDouble: "<=", LessEqual_IntInt: "<=",
  // Bare forms: K2Node_PromotableOperator stores the operation as OperationName
  // ("NotEqual", "Greater", ...) rather than a typed KismetMathLibrary member.
  EqualEqual: "==", NotEqual: "!=", Greater: ">", Less: "<",
  GreaterEqual: ">=", LessEqual: "<=", And: "AND", Or: "OR", Not: "NOT",
};

// UE serializes the common math/comparison/boolean operators (Multiply_FloatFloat,
// Greater_DoubleDouble, BooleanAND, ...) as plain KismetMathLibrary CallFunction
// nodes, NOT only as the Promotable/Commutative node classes. Detect that form by
// matching the called member against OPERATOR_SYMBOLS so it can render as "A * B"
// with both operands resolved. Without this an inline literal typed into an
// operand (e.g. the 2.5 in BaseDamage * 2.5) disappears behind a bare
// "Multiply Float Float()" call label.
function isOperatorCallFunction(node) {
  if (node.nodeClass !== "K2Node_CallFunction") return false;
  const ref = matchField(node.raw, "FunctionReference");
  if (!ref) return false;
  const m = ref.match(/MemberName="?([^",)]+)"?/);
  return !!(m && OPERATOR_SYMBOLS[m[1]]);
}

// The actor/object a node reads through. Function calls and member-variable
// gets carry a "self" (Target) pin: when it's wired, the operand reads off that
// source; when it's left default, it reads off the owning blueprint (Self).
// Returns null — no annotation — when the node has no self pin at all (a plain
// local variable), or when the self pin targets a class default object: that is
// a static library call (KismetMathLibrary.FClamp, ...) with no instance, so a
// "Self." prefix would be misleading.
function describeTargetContext(node, byName, depth, enumRegistry) {
  const selfPin = node.pins.find(
    (p) => p.PinName === "self" && p.Direction === "EGPD_Input" && !isExecPin(p)
  );
  if (!selfPin) return null;
  if (selfPin.LinkedTo.length === 0) return selfPin.DefaultObject ? null : "Self";
  const link = selfPin.LinkedTo[0];
  const resolved = resolveThroughKnots(link.nodeName, link.pinName, byName);
  return describeDataSource(byName.get(resolved.nodeName), resolved.pinName, byName, depth + 1, enumRegistry);
}

function describeDataSource(node, pinName, byName, depth, enumRegistry) {
  if (!node) return "?";
  // Expansion depth guard. Set high enough to walk a realistic operand chain to
  // its leaves (e.g. FClamp(ResistMod * Caster - Self.Toll * 0.15, 0, 0.85) is 5
  // levels deep) without dropping the inline constants that live at the bottom.
  // The subline width cap in renderChain is what keeps the resulting string from
  // running away; this guard only backstops pathological / cyclic graphs.
  if (depth > 8) return (node.friendly || "?").replace(/^(?:Validated Get: |Get |SET )/, "");

  // Function parameters, event outputs and tunnel/macro boundary pins read by
  // their pin name (the parameter, e.g. "CasterToll"), not the node's verbose
  // friendly ("Function Entry: CheckDebuffSpellResistance"). Without this every
  // parameter reference bloats the expression until the real operands (and their
  // literals) get clipped by the subline width cap.
  if (node.nodeClass === "K2Node_FunctionEntry" || node.nodeClass === "K2Node_CustomEvent" ||
      node.nodeClass === "K2Node_Event" || node.nodeClass === "K2Node_Tunnel") {
    const srcPin = node.pins.find((p) => p.PinName === pinName && p.Direction === "EGPD_Output");
    const label = srcPin && srcPin.PinFriendlyName
      ? srcPin.PinFriendlyName
      : pinName.replace(/_\d+_[A-F0-9]+$/i, "");
    if (label) return label;
  }

  if (node.nodeClass === "K2Node_VariableGet") {
    const name = node.friendly.replace(/^(?:Validated Get: |Get )/, "");
    const ctx = describeTargetContext(node, byName, depth, enumRegistry);
    return ctx ? ctx + "." + name : name;
  }
  if (node.nodeClass === "K2Node_VariableSet") return node.friendly.replace(/^SET /, "");

  if (node.nodeClass === "K2Node_BreakStruct") {
    // Return the proximate node identity (Break Struct) with the field as
    // parenthetical context. The previous form returned only the field name,
    // which produced unreadable rows like "Quantity: <- Quantity" and made the
    // Break Struct node effectively invisible in the export.
    const sourcePin = node.pins.find((p) => p.PinName === pinName);
    const fieldLabel = sourcePin && sourcePin.PinFriendlyName
      ? sourcePin.PinFriendlyName
      : pinName.replace(/_\d+_[A-F0-9]+$/i, "");
    return "Break Struct (" + fieldLabel + ")";
  }

  if (node.nodeClass === "K2Node_CommutativeAssociativeBinaryOperator" ||
      node.nodeClass === "K2Node_PromotableOperator") {
    return describeBinaryOp(node, byName, depth, enumRegistry);
  }

  if (node.nodeClass === "K2Node_EnumEquality" || node.nodeClass === "K2Node_EnumInequality") {
    return describeEnumEquality(node, byName, depth, enumRegistry);
  }

  if (node.nodeClass === "K2Node_EnumLiteral") {
    // The literal value sits on the input pin named "Enum" as a DefaultValue.
    const valuePin = node.pins.find((p) => p.PinName === "Enum" && p.Direction === "EGPD_Input");
    if (valuePin && valuePin.DefaultValue) {
      const enumInfo = resolveEnumDefault(valuePin, enumRegistry);
      if (enumInfo) return formatEnumLabel(valuePin.DefaultValue, enumInfo);
      return valuePin.DefaultValue;
    }
    return node.friendly;
  }
  if (node.nodeClass === "K2Node_CallFunction") {
    // Math/comparison/boolean ops wired in as a data source read as "A * B"
    // with their operands (variables and inline constants) resolved, rather
    // than a bare "Multiply Float Float()" that hides what's being combined.
    if (isOperatorCallFunction(node)) return describeBinaryOp(node, byName, depth, enumRegistry);
    const ctx = describeTargetContext(node, byName, depth, enumRegistry);
    const args = describeCallArguments(node, byName, depth, enumRegistry);
    return (ctx ? ctx + "." : "") + node.friendly + "(" + args.join(", ") + ")";
  }
  if (node.nodeClass === "K2Node_DynamicCast") {
    // Show what's being cast (e.g. Cast To Enemy(ArrayElem)) so a cast feeding a
    // member access or comparison operand names its object source.
    const objPin = node.pins.find(
      (p) => p.PinName === "Object" && p.Direction === "EGPD_Input" && !isExecPin(p)
    );
    if (objPin && objPin.LinkedTo.length > 0) {
      const link = objPin.LinkedTo[0];
      const resolved = resolveThroughKnots(link.nodeName, link.pinName, byName);
      const objSrc = describeDataSource(byName.get(resolved.nodeName), resolved.pinName, byName, depth + 1, enumRegistry);
      return node.friendly + "(" + objSrc + ")";
    }
    return node.friendly;
  }
  if (node.nodeClass === "K2Node_Self") return "Self";
  if (node.nodeClass === "K2Node_MakeStruct") return "Make Struct";
  if (node.nodeClass === "K2Node_MakeArray") return "Make Array";
  if (node.nodeClass === "K2Node_Knot") return "(reroute)";
  return node.friendly;
}

// Pure constructor nodes (MakeStruct, MakeArray) have no exec pins and so
// never render as flow boxes — without expansion, any wire fanning out into
// their inputs is invisible in the export. Returns the list of bindings as
// individual lines so the consumer that references the Make can show each
// wire as its own indented subline. Vertical layout (rather than inline
// parens) keeps the consumer-side 56-char cap from clipping mid-binding.
function describeMakeNodeBindings(node, byName, enumRegistry) {
  const inputs = node.pins.filter(
    (p) => !isExecPin(p) && p.Direction === "EGPD_Input" && p.PinName !== "self"
  );
  const bindings = [];
  for (const p of inputs) {
    const fieldLabel = p.PinFriendlyName || p.PinName.replace(/_\d+_[A-F0-9]+$/i, "");
    if (p.LinkedTo.length > 0) {
      const link = p.LinkedTo[0];
      const resolved = resolveThroughKnots(link.nodeName, link.pinName, byName);
      const src = byName.get(resolved.nodeName);
      // depth=1 here so a Make-of-Make collapses to bare "Make Struct" rather
      // than recursing into another expansion that we have no rendering slot
      // for.
      const value = describeDataSource(src, resolved.pinName, byName, 1, enumRegistry);
      bindings.push(fieldLabel + " ← " + value);
    } else if (p.DefaultValue !== null && p.DefaultValue !== undefined &&
               p.DefaultValue !== "" && p.DefaultValue !== "0" && p.DefaultValue !== "None") {
      const enumInfo = resolveEnumDefault(p, enumRegistry);
      const value = enumInfo ? formatEnumLabel(p.DefaultValue, enumInfo) : p.DefaultValue;
      bindings.push(fieldLabel + "=" + value);
    }
  }
  return bindings;
}

function isMakeNode(node) {
  return node && (node.nodeClass === "K2Node_MakeStruct" || node.nodeClass === "K2Node_MakeArray");
}

// An enum operand left at its default carries NO DefaultValue and NO
// AutogeneratedDefaultValue in the paste — UE omits the literal for the enum's
// zeroth member. That member is the value the comparison actually uses at
// runtime (e.g. SearchState == Idle, where Idle is index 0), so resolve it from
// the enum's display table instead of rendering "?". Returns null when the pin
// isn't an enum or no table for that enum was found in the paste.
function resolveImplicitEnumDefault(pin, enumRegistry) {
  if (!enumRegistry || pin.PinCategory !== "byte" || !pin.PinSubCategoryObject) return null;
  const enumName = extractEnumName(pin.PinSubCategoryObject);
  if (!enumName) return null;
  const map = enumRegistry.get(enumName);
  if (!map || map.size === 0) return null;
  // The registry preserves declaration order, so the first entry is the zeroth
  // enumerator — the implicit default of an unset enum pin.
  const [entryName, info] = map.entries().next().value;
  return formatEnumLabel(entryName, info);
}

// Whether a data-input pin contributes anything to an operand/argument list:
// a wire, an inline literal, or (for an enum) the implicit zeroth-member
// default. Pins that have none of these (e.g. a hidden ErrorTolerance pin on a
// comparison node) carry no information and must be skipped — otherwise they
// render as a spurious "?" operand, e.g. "A >= B >= ?".
function operandHasValue(pin, enumRegistry) {
  if (pin.LinkedTo.length > 0) return true;
  if (pinLiteralValue(pin) !== null) return true;
  return resolveImplicitEnumDefault(pin, enumRegistry) !== null;
}

// Tidy a serialized numeric literal for display: UE writes floats with a fixed
// six-decimal tail ("0.150000", "1.000000"), which is both noisy and long
// enough to push a nested expression past the subline width cap. Trim trailing
// zeros (keeping one after the point) so "0.150000" -> "0.15", "1.000000" ->
// "1.0". Integers and non-numeric tokens (names, bools, enums) pass through
// untouched.
function formatNumericLiteral(value) {
  if (typeof value !== "string" || !/^-?\d+\.\d+$/.test(value)) return value;
  const trimmed = value.replace(/0+$/, "");
  return trimmed.endsWith(".") ? trimmed + "0" : trimmed;
}

// Resolve one operand of a comparison/math/equality node: follow the wire if
// connected, otherwise show the inline literal (numeric or enum). Reads the
// effective literal via pinLiteralValue so a constant UE serialized only as
// AutogeneratedDefaultValue (e.g. a 0 wired into a comparison) isn't dropped.
function describeOperand(pin, byName, depth, enumRegistry) {
  if (pin.LinkedTo.length > 0) {
    const link = pin.LinkedTo[0];
    const resolved = resolveThroughKnots(link.nodeName, link.pinName, byName);
    const sourceNode = byName.get(resolved.nodeName);
    return describeDataSource(sourceNode, resolved.pinName, byName, depth + 1, enumRegistry);
  }
  const literal = pinLiteralValue(pin);
  if (literal === null) return resolveImplicitEnumDefault(pin, enumRegistry) || "?";
  const enumInfo = resolveEnumDefault(pin, enumRegistry);
  return enumInfo ? formatEnumLabel(literal, enumInfo) : formatNumericLiteral(literal);
}

// Enum comparison nodes (Equal/Not Equal on an enum) carry operands A and B,
// where B is typically an inline enumerator literal. Render "A == B" with both
// sides resolved to their readable labels instead of the bare class name.
function describeEnumEquality(node, byName, depth, enumRegistry) {
  const symbol = node.nodeClass === "K2Node_EnumInequality" ? "!=" : "==";
  const a = node.pins.find((p) => p.PinName === "A" && p.Direction === "EGPD_Input");
  const b = node.pins.find((p) => p.PinName === "B" && p.Direction === "EGPD_Input");
  const lhs = a ? describeOperand(a, byName, depth, enumRegistry) : "?";
  const rhs = b ? describeOperand(b, byName, depth, enumRegistry) : "?";
  return lhs + " " + symbol + " " + rhs;
}

// Resolve the visible arguments of a non-operator function call (FClamp,
// RandomFloatInRange, ...) so the call renders as "FClamp(Value, 0.0, 0.85)"
// with both wired inputs and inline literals, instead of a bare "FClamp()" that
// silently discards the operands — and, worse, severs the whole subtree feeding
// a wired input from the export. Skips the "self"/Target pin (already shown as
// the call's context) and any pin carrying no information: an unwired pin with
// no literal (e.g. a hidden ErrorTolerance pin) would only render as a noisy "?".
function describeCallArguments(node, byName, depth, enumRegistry) {
  const args = [];
  for (const p of node.pins) {
    if (isExecPin(p)) continue;
    if (p.Direction !== "EGPD_Input") continue;
    if (p.PinName === "self") continue;
    if (!operandHasValue(p, enumRegistry)) continue;
    args.push(describeOperand(p, byName, depth, enumRegistry));
  }
  return args;
}

// Whether a node renders as an infix binary expression ("A op B"). When such a
// node feeds an operand of an enclosing operator, its rendered form must be
// wrapped in parentheses so the export reflects the actual node nesting rather
// than leaving the reader to reconstruct it from infix precedence — UE's graph
// has no precedence, only wires, so "A * B - C" is genuinely ambiguous as text.
function isBinaryOpNode(node) {
  if (!node) return false;
  return (
    node.nodeClass === "K2Node_CommutativeAssociativeBinaryOperator" ||
    node.nodeClass === "K2Node_PromotableOperator" ||
    node.nodeClass === "K2Node_EnumEquality" ||
    node.nodeClass === "K2Node_EnumInequality" ||
    isOperatorCallFunction(node)
  );
}

// Resolve one operand of a binary op, parenthesizing it when its source is
// itself a binary op so nesting is explicit: "(A * B) - (C * D)", not the
// precedence-dependent "A * B - C * D". Only the wired-source case can nest;
// inline literals and leaf variables never need wrapping.
function describeBinaryOperand(pin, byName, depth, enumRegistry) {
  const rendered = describeOperand(pin, byName, depth, enumRegistry);
  if (pin.LinkedTo.length > 0) {
    const link = pin.LinkedTo[0];
    const resolved = resolveThroughKnots(link.nodeName, link.pinName, byName);
    if (isBinaryOpNode(byName.get(resolved.nodeName))) return "(" + rendered + ")";
  }
  return rendered;
}

function describeBinaryOp(node, byName, depth, enumRegistry) {
  const inputs = node.pins
    .filter((p) => p.Direction === "EGPD_Input" && !isExecPin(p) && p.PinName !== "self" &&
      operandHasValue(p, enumRegistry))
    .map((p) => describeBinaryOperand(p, byName, depth, enumRegistry));

  let symbol = null;
  const fnRef = matchField(node.raw, "FunctionReference");
  if (fnRef) {
    const m = fnRef.match(/MemberName="?([^",)]+)"?/);
    if (m && OPERATOR_SYMBOLS[m[1]]) symbol = OPERATOR_SYMBOLS[m[1]];
  }
  if (!symbol) {
    const opName = matchField(node.raw, "OperationName");
    if (opName) {
      const cleaned = opName.replace(/"/g, "").trim();
      symbol = OPERATOR_SYMBOLS[cleaned] || cleaned;
    }
  }
  if (!symbol) symbol = node.friendly;
  return inputs.join(" " + symbol + " ");
}

// Max characters for a data-pin subline inside a flow box before it's clipped
// with an ellipsis. Generous enough to keep a fully-resolved nested expression
// (a clamp/lerp of a math chain with its inline constants) intact — these are
// documentation exports rendered inside a fenced code block, so width is cheap
// and dropping a literal is not. Box width auto-fits the longest subline.
const SUBLINE_MAX = 120;

// -- Box drawing helpers ----------------------------------------------------

function boxLines(title, sublines, minWidth = 28) {
  let inner = Math.max(minWidth, title.length + 4, ...sublines.map((s) => s.length + 4));
  // Force odd inner so total width is odd and Math.floor(width/2) lands on a
  // true center column - otherwise the down-connector sits 0.5 cells off-center.
  if (inner % 2 === 0) inner += 1;
  const horiz = "─".repeat(inner);
  const pad = (s) => "│ " + s + " ".repeat(inner - s.length - 2) + " │";
  const lines = ["┌" + horiz + "┐"];
  lines.push(pad(title));
  for (const sl of sublines) lines.push(pad(sl));
  lines.push("└" + horiz + "┘");
  return { lines, width: inner + 2 };
}

function connectorDown(width, indent) {
  const pad = " ".repeat(indent);
  const mid = Math.floor(width / 2);
  const innerPad = " ".repeat(mid);
  return [pad + innerPad + "│", pad + innerPad + "↓"];
}

function labeledConnectorDown(width, label, indent) {
  const pad = " ".repeat(indent);
  const mid = Math.floor(width / 2);
  const innerPad = " ".repeat(mid);
  return [pad + innerPad + "│", pad + innerPad + "├── " + label, pad + innerPad + "↓"];
}

// -- Main renderer ----------------------------------------------------------

function sortExecOutputs(node, outs) {
  if (node.nodeClass === "K2Node_IfThenElse") {
    const order = ["then", "else"];
    return [...outs].sort((a, b) => order.indexOf(a.pinName) - order.indexOf(b.pinName));
  }
  if (node.friendly === "ForEachLoop" || node.friendly === "ForEachLoopWithBreak" ||
      node.friendly === "ForLoop" || node.friendly === "ForLoopWithBreak") {
    const order = ["LoopBody", "Completed"];
    return [...outs].sort((a, b) => order.indexOf(a.pinName) - order.indexOf(b.pinName));
  }
  if (node.nodeClass === "K2Node_ExecutionSequence") {
    return [...outs].sort((a, b) => a.pinName.localeCompare(b.pinName, undefined, { numeric: true }));
  }
  if (node.nodeClass === "K2Node_EnhancedInputAction") {
    // Match the order the UE editor uses on the node body so the diagram reads
    // top-to-bottom in the same shape as the source graph.
    const order = ["Triggered", "Started", "Ongoing", "Canceled", "Cancelled", "Completed"];
    return [...outs].sort((a, b) => {
      const ai = order.indexOf(a.pinName); const bi = order.indexOf(b.pinName);
      const aRank = ai === -1 ? 999 : ai;
      const bRank = bi === -1 ? 999 : bi;
      return aRank - bRank;
    });
  }
  return outs;
}

function labelForExecPin(node, out) {
  if (node.nodeClass === "K2Node_IfThenElse") {
    return out.pinName === "then" ? "TRUE" : (out.pinName === "else" ? "FALSE" : out.pinName);
  }
  if (node.friendly === "ForEachLoop" || node.friendly === "ForLoop") {
    if (out.pinName === "LoopBody") return "Loop Body";
    if (out.pinName === "Completed") return "Completed";
  }
  if (node.nodeClass === "K2Node_SwitchEnum") {
    if (!node._enumMap) node._enumMap = parseEnumMap(node.raw);
    const info = node._enumMap.get(out.pinName);
    if (info) return formatEnumLabel(out.pinName, info);
  }
  return out.friendlyName || out.pinName;
}

function assignAnchorId(node, ctx) {
  if (ctx.anchorIds.has(node.name)) return ctx.anchorIds.get(node.name);
  const id = "join " + (ctx.anchorIds.size + 1);
  ctx.anchorIds.set(node.name, id);
  return id;
}

function renderChain(node, byName, ctx, visited, indent = 0) {
  const lines = [];
  if (visited.has(node.name)) {
    lines.push(" ".repeat(indent) + "↳ (loops back to " + node.friendly + ")");
    return lines;
  }
  visited.add(node.name);
  // Record that this node was actually placed as a box. ctx.drawnNodes persists
  // across every walk (entries, join bodies, orphans) so the final diff against
  // the inventory's executable-node set catches anything the traversal skipped.
  ctx.drawnNodes.add(node.name);

  const title = node.friendly;
  const sublines = [];
  if (ctx.showDataPins) {
    // Return nodes carry the function's final computed expression(s) — the one
    // place where clipping a formula mid-term defeats the whole point of the
    // export (the reader can no longer verify the result from the text). Render
    // them in full regardless of width; everywhere else the cap keeps boxes from
    // running away on an incidental deep chain.
    const noClip = node.nodeClass === "K2Node_FunctionResult";
    const clip = (s) => (!noClip && s.length > SUBLINE_MAX ? s.slice(0, SUBLINE_MAX - 3) + "..." : s);
    const inputs = getDataInputs(node, byName, ctx.enumRegistry);
    for (const di of inputs) {
      sublines.push(di.name + ": " + clip(di.value));
      if (di.bindings) {
        for (const b of di.bindings) sublines.push("    " + clip(b));
      }
    }
  }

  const isForEach = node.friendly === "ForEachLoop" || node.friendly === "ForEachLoopWithBreak";
  const { lines: boxL, width } = boxLines(title, sublines);
  for (const l of boxL) lines.push(" ".repeat(indent) + l);

  const showAllOutputs = isBranchLike(node);
  const outs = getOutgoingExecLinks(node, byName, showAllOutputs);

  if (outs.length === 0) return lines;

  // Splice a ┴ into the box's bottom edge so the downward connector visually
  // attaches. For single-output flows the child sits at the parent's indent, so
  // center on the parent. For branching the children are indented (subIndent),
  // so align with the indented child's center instead - otherwise the pipe
  // lands well to the left of the child it points into.
  const isSingleOut = outs.length === 1 && !showAllOutputs;
  const subIndent = indent + 4;
  const connectorIndent = isSingleOut ? indent : subIndent;
  const junctionCol = connectorIndent + Math.floor(width / 2);
  const bottomIdx = lines.length - 1;
  const bottomLine = lines[bottomIdx];
  lines[bottomIdx] = bottomLine.slice(0, junctionCol) + "┴" + bottomLine.slice(junctionCol + 1);

  if (isForEach) {
    lines.push(" ".repeat(indent) + "   [!] ForEachLoop: confirm logic on Completed pin, not Loop Body");
  }

  if (isSingleOut) {
    const out = outs[0];
    if (!out.target) {
      lines.push(...connectorDown(width, indent));
      lines.push(" ".repeat(indent + 4) + "(unconnected)");
      return lines;
    }
    const next = byName.get(out.target.nodeName);
    if (!next) return lines;
    const targetLabel = getTargetExecPinLabel(next, out.target.pinName);
    const drawConnector = () => {
      if (targetLabel) {
        lines.push(...labeledConnectorDown(width, "into: " + targetLabel, indent));
      } else {
        lines.push(...connectorDown(width, indent));
      }
    };
    const incoming = ctx.incomingCounts.get(out.target.nodeName) || 0;
    if (incoming >= 2) {
      drawConnector();
      const anchorId = assignAnchorId(next, ctx);
      const suffix = targetLabel ? "." + targetLabel : "";
      lines.push(" ".repeat(indent + 4) + "→ continues at [" + anchorId + ": " + next.friendly + suffix + "]");
      ctx.joinQueue.set(next.name, next);
      return lines;
    }
    drawConnector();
    const sub = renderChain(next, byName, ctx, visited, indent);
    lines.push(...sub);
    return lines;
  }

  const sortedOuts = sortExecOutputs(node, outs);
  for (let i = 0; i < sortedOuts.length; i++) {
    const out = sortedOuts[i];
    let label = labelForExecPin(node, out);

    if (!out.target) {
      lines.push(...labeledConnectorDown(width, label, subIndent));
      lines.push(" ".repeat(subIndent) + "(unconnected)");
      if (i < sortedOuts.length - 1) lines.push(" ".repeat(indent));
      continue;
    }

    const next = byName.get(out.target.nodeName);
    if (!next) {
      lines.push(...labeledConnectorDown(width, label, subIndent));
      lines.push(" ".repeat(subIndent) + "(unconnected)");
      if (i < sortedOuts.length - 1) lines.push(" ".repeat(indent));
      continue;
    }

    const targetLabel = getTargetExecPinLabel(next, out.target.pinName);
    if (targetLabel) label += " → into: " + targetLabel;
    lines.push(...labeledConnectorDown(width, label, subIndent));

    const incoming = ctx.incomingCounts.get(out.target.nodeName) || 0;
    if (incoming >= 2) {
      const anchorId = assignAnchorId(next, ctx);
      const suffix = targetLabel ? "." + targetLabel : "";
      lines.push(" ".repeat(subIndent) + "→ continues at [" + anchorId + ": " + next.friendly + suffix + "]");
      ctx.joinQueue.set(next.name, next);
    } else {
      const sub = renderChain(next, byName, ctx, new Set(visited), subIndent);
      lines.push(...sub);
    }
    if (i < sortedOuts.length - 1) lines.push(" ".repeat(indent));
  }
  return lines;
}

function renderJoinHeader(node, ctx, predecessors, byName) {
  const anchorId = assignAnchorId(node, ctx);
  const preds = predecessors.get(node.name) || new Set();
  const friendlySources = new Map();
  for (const p of preds) {
    const [srcName, srcPin, tgtPin] = p.split("::");
    const srcNode = byName.get(srcName);
    if (!srcNode) continue;
    let label = srcNode.friendly;
    if (isBranchLike(srcNode) && srcPin) {
      const pin = srcNode.pins.find((pp) => pp.PinName === srcPin);
      const pinLabel = pin && pin.PinFriendlyName ? pin.PinFriendlyName : srcPin;
      label = srcNode.friendly + " (" + pinLabel + ")";
    }
    const targetLabel = getTargetExecPinLabel(node, tgtPin);
    if (targetLabel) label += " → " + targetLabel;
    friendlySources.set(label, (friendlySources.get(label) || 0) + 1);
  }
  const sources = Array.from(friendlySources.entries())
    .map(([label, count]) => count > 1 ? label + " ×" + count : label)
    .join(", ");
  return (
    "═════ [" + anchorId + "] joined from " + preds.size + " paths ═════\n" +
    "   from: " + sources
  );
}

// Cap the explicit node list so a graph with a large gap doesn't bury the rest
// of the export under a wall of names. The headline count is always exact.
const UNDRAWN_LIST_CAP = 25;

// Build the banner that flags executable nodes the inventory counted but the
// exec-graph walk never placed. The point is to convert a silent omission — a
// node that quietly vanishes from the diagram — into a loud, greppable flag at
// the top of the export, with enough identity (friendly, class, internal name)
// to find each missing node in the source paste.
function buildUndrawnWarning(undrawn) {
  const head =
    "⚠️  RENDER WARNING: " + undrawn.length + " executable node(s) were counted in the\n" +
    "    inventory but never drawn in the flow below. The exec-graph walk did not\n" +
    "    reach them — this is a silent omission (suspect reroute fan-out or a\n" +
    "    converging join). Investigate these nodes:";
  const shown = undrawn.slice(0, UNDRAWN_LIST_CAP);
  const rows = shown.map((n) => "      - " + n.friendly + " (" + n.nodeClass + ") [" + n.name + "]");
  if (undrawn.length > shown.length) {
    rows.push("      … and " + (undrawn.length - shown.length) + " more");
  }
  return [head, ...rows].join("\n");
}

export function renderASCII(parseResult, opts) {
  const { nodes, byName } = parseResult;
  const entries = findEntryNodes(nodes);
  const orphans = findOrphanNodes(nodes);
  const { counts: incomingCounts, predecessors } = computeIncomingExecCounts(parseResult);

  if (entries.length === 0 && orphans.length === 0) {
    if (nodes.length === 0) return "(no nodes parsed)";
    return "(no entry or orphan nodes - paste includes " + nodes.length + " node(s) but no exec flow)";
  }

  const ctx = {
    showDataPins: opts.showDataPins,
    incomingCounts,
    predecessors,
    joinQueue: new Map(),
    anchorIds: new Map(),
    enumRegistry: parseResult.enumRegistry,
    drawnNodes: new Set(),
  };

  const entrySections = [];
  for (const entry of entries) {
    const chain = renderChain(entry, byName, ctx, new Set(), 0);
    entrySections.push(chain.join("\n"));
  }

  const orphanSections = [];
  for (const o of orphans) {
    const body = renderChain(o, byName, ctx, new Set(), 0);
    orphanSections.push(body.join("\n"));
  }

  const joinSections = [];
  const processed = new Set();
  while (ctx.joinQueue.size > processed.size) {
    for (const [nodeName, node] of ctx.joinQueue) {
      if (processed.has(nodeName)) continue;
      processed.add(nodeName);
      const header = renderJoinHeader(node, ctx, predecessors, byName);
      const body = renderChain(node, byName, ctx, new Set(), 0);
      joinSections.push(header + "\n" + body.join("\n"));
    }
  }

  const sections = [...entrySections];
  if (joinSections.length > 0) sections.push(joinSections.join("\n\n"));
  if (orphanSections.length > 0) {
    sections.push(
      "─── orphan nodes (no incoming exec; review whether these should be wired up or removed) ───\n\n" +
      orphanSections.join("\n\n")
    );
  }

  const body = sections.join("\n\n" + "═".repeat(40) + "\n\n");

  // Diff what the walk placed against every executable node the inventory
  // counts. Anything counted but undrawn is a node the diagram silently lost;
  // flag it at the very top so the omission is impossible to miss.
  const undrawn = nodes.filter((n) => isExecutableNode(n) && !ctx.drawnNodes.has(n.name));
  if (undrawn.length > 0) {
    return buildUndrawnWarning(undrawn) + "\n\n" + "═".repeat(40) + "\n\n" + body;
  }
  return body;
}
