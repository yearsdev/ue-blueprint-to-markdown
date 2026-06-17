// ============================================================================
// blueprint/markdown.js — Review notes + final markdown export +
// filename derivation. Top of the pipeline: composes the metadata block,
// flow diagram, node inventory, review notes, and (optionally) raw paste
// into a single documentation-ready document.
// ============================================================================

import {
  isExecPin, findOrphanNodes, isBranchLike, isAsyncNode, isLatentCallFunction,
} from "./common.js";
import { extractFunctionMetadata, generateFunctionMetadataMarkdown } from "./metadata.js";

// -- Review notes -----------------------------------------------------------
// Auto-flag patterns that have historically caused silent failures.

export function generateReviewNotes(parseResult) {
  const notes = [];

  const orphans = findOrphanNodes(parseResult.nodes);
  for (const o of orphans) {
    notes.push({
      nodeName: o.name,
      label: "Orphan: " + o.friendly,
      text: "This node has outgoing exec but no incoming connection. It will never execute. Likely leftover from a refactor, or an upstream node that should be wired to it.",
    });
  }

  for (const node of parseResult.nodes) {
    if (!isBranchLike(node)) continue;
    const unconnected = node.pins.filter((p) =>
      isExecPin(p) && p.Direction === "EGPD_Output" && p.LinkedTo.length === 0
    );
    if (unconnected.length === 0) continue;
    const pinLabels = unconnected.map((p) => p.PinFriendlyName || p.PinName).join(", ");
    notes.push({
      nodeName: node.name,
      label: "Unconnected output(s) on " + node.friendly,
      text: "Output exec pin(s) with no LinkedTo: " + pinLabels + ". If these cases are intended to be no-ops, fine; otherwise wire them up.",
    });
  }

  for (const node of parseResult.nodes) {
    if (node.friendly === "ForEachLoop" || node.friendly === "ForEachLoopWithBreak" ||
        node.friendly === "ForLoop" || node.friendly === "ForLoopWithBreak") {
      notes.push({
        nodeName: node.name,
        label: node.friendly,
        text: "Verify per-call logic (rewards, dispatch, return nodes) is wired to the Completed pin, not nested in the Loop Body.",
      });
    }
    if (node.nodeClass === "K2Node_SpawnActorFromClass") {
      notes.push({
        nodeName: node.name,
        label: "SpawnActor From Class",
        text: 'Confirm Collision Handling Override is set to "Always Spawn, Ignore Collisions". Default fails silently when the spawn point overlaps geometry.',
      });
    }
    if (node.friendly && /^Set Timer/i.test(node.friendly)) {
      notes.push({
        nodeName: node.name,
        label: node.friendly,
        text: "If using Set Timer by Event, target must be a Custom Event on the Actor Component's Event Graph (not a function).",
      });
    }
    if (node.friendly && /^Bind Event/i.test(node.friendly)) {
      notes.push({
        nodeName: node.name,
        label: node.friendly,
        text: 'Confirm the bound event was generated via "Create a Matching Event" from the delegate pin. Hand-crafted callbacks with mismatched signatures fail silently.',
      });
    }
    if (node.nodeClass === "K2Node_Timeline") {
      notes.push({
        nodeName: node.name,
        label: node.friendly,
        text: "If this Timeline drives a Lerp, confirm Lerp A reads a cached starting position variable. Live Get Relative Location reads cause compounding drift across cycles.",
      });
    }
    if (node.nodeClass === "K2Node_EnhancedInputAction") {
      notes.push({
        nodeName: node.name,
        label: node.friendly,
        text: "Confirm the owning IMC is added via EnhancedInputLocalPlayerSubsystem.AddMappingContext on possess. Without an active mapping context the trigger exec pins never fire.",
      });
    }
    if (isAsyncNode(node)) {
      notes.push({
        nodeName: node.name,
        label: "Async action: " + node.friendly,
        text: "Async node — confirm the failure / cancel completion pins are handled (or explicitly left unwired). Silent failure on these branches is the most common cause of 'nothing happened' bugs.",
      });
    }
    if (isLatentCallFunction(node)) {
      notes.push({
        nodeName: node.name,
        label: "Latent: " + node.friendly,
        text: "Latent UFUNCTION (hidden LatentInfo pin). Valid only on event graphs / non-pure functions — pasting this into a pure or function-result graph won't compile.",
      });
    }
  }
  return notes;
}

// -- Final markdown export --------------------------------------------------

export function generateMarkdown(parseResult, ascii, opts) {
  const lines = [];
  const title = (opts.name && opts.name.trim()) ? opts.name.trim() : "Blueprint Diagram";
  const timestamp = opts.timestamp || new Date().toISOString();

  lines.push("# " + title);
  lines.push("");
  lines.push("> Exported " + timestamp + " from Banishment Editor");
  lines.push("");

  const meta = extractFunctionMetadata(parseResult);
  const metaBlock = generateFunctionMetadataMarkdown(meta);
  if (metaBlock.trim().length > 0) {
    lines.push(metaBlock);
    lines.push("");
  }

  lines.push("## Flow");
  lines.push("");
  lines.push("```");
  lines.push(ascii);
  lines.push("```");
  lines.push("");

  // Node inventory.
  const counts = {};
  for (const n of parseResult.nodes) counts[n.friendly] = (counts[n.friendly] || 0) + 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length > 0) {
    lines.push("## Node Inventory");
    lines.push("");
    lines.push("| Type | Count |");
    lines.push("|------|-------|");
    for (const [t, c] of sorted) lines.push("| " + t + " | " + c + " |");
    lines.push("| **Total** | **" + parseResult.nodes.length + "** |");
    lines.push("");
  }

  // Review notes.
  const notes = generateReviewNotes(parseResult);
  if (notes.length > 0) {
    lines.push("## Review Notes");
    lines.push("");
    for (const note of notes) {
      lines.push("- [ ] **" + note.label + "** (`" + note.nodeName + "`) - " + note.text);
    }
    lines.push("");
  }

  if (opts.includeRaw && opts.rawInput) {
    lines.push("<details>");
    lines.push("<summary>Raw Blueprint paste</summary>");
    lines.push("");
    lines.push("```");
    lines.push(opts.rawInput);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

// -- Filename derivation ----------------------------------------------------

function sanitizeFilenamePart(s) {
  return s.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
}

export function deriveFilenameBase(parseResult, currentName) {
  if (currentName && currentName.trim()) return sanitizeFilenamePart(currentName.trim());
  if (parseResult) {
    const meta = extractFunctionMetadata(parseResult);
    const parts = [];
    if (meta.component) parts.push(meta.component);
    if (meta.functionName) parts.push(meta.functionName);
    if (parts.length > 0) return sanitizeFilenamePart(parts.join("."));
  }
  return "diagram";
}
