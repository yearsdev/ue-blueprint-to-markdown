// ============================================================================
// materialEngine.js - Barrel re-export for the material graph pipeline.
//
// Parallels blueprintEngine.js. The material pipeline reuses the blueprint
// low-level parsers (block + pin walking, in blueprint/common.js) but renders a
// pure data DAG backward from the Material Output instead of an execution flow:
//   - material/parser.js    text -> node graph (+ detectGraphType router)
//   - material/renderer.js  node graph -> ASCII expression tree
//   - material/analysis.js  metadata, review notes, markdown export
// ============================================================================

export { parseMaterial, detectGraphType } from "./material/parser.js";
export { renderMaterialASCII } from "./material/renderer.js";
export {
  extractMaterialMetadata, generateMaterialReviewNotes,
  generateMaterialMarkdown, deriveMaterialFilenameBase,
} from "./material/analysis.js";
