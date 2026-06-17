// ============================================================================
// blueprintEngine.js — Barrel re-export for the blueprint pipeline.
//
// The pipeline lives in ./blueprint/* now, split by stage:
//   - blueprint/common.js   shared helpers (string + graph predicates)
//   - blueprint/parser.js   text → node graph, enum registry
//   - blueprint/renderer.js node graph → ASCII flow diagram
//   - blueprint/metadata.js node graph → function signature/calls/refs
//   - blueprint/markdown.js review notes + final markdown export
//
// Consumers (BlueprintEditor, tests) import from here, so the split is
// invisible at the API boundary.
// ============================================================================

export { parseBlueprint } from "./blueprint/parser.js";
export { renderASCII } from "./blueprint/renderer.js";
export { extractFunctionMetadata } from "./blueprint/metadata.js";
export { generateReviewNotes, generateMarkdown, deriveFilenameBase } from "./blueprint/markdown.js";
