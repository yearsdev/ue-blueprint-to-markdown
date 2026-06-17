// ============================================================================
// App.jsx — UE Blueprint → Markdown
//
// Paste Unreal Engine Blueprint (or material graph) copy/paste text, get an
// annotated ASCII flow diagram plus a documentation-ready markdown export.
//
// Stateless: no storage, no library, no backend. Everything runs in the
// browser. The parse/render/export engine is carried over verbatim from the
// Banishment content editor (src/blueprint/*, src/material/*).
// ============================================================================

import { useState, useRef, useMemo, useEffect } from "react";
import {
  useIsMobile, getStyles, useNotification, notificationBg, C, downloadFile,
} from "./ui.js";
import {
  parseBlueprint, renderASCII, generateMarkdown,
  generateReviewNotes, extractFunctionMetadata, deriveFilenameBase,
} from "./blueprintEngine.js";
import {
  parseMaterial, detectGraphType, renderMaterialASCII,
  extractMaterialMetadata, generateMaterialReviewNotes,
  generateMaterialMarkdown, deriveMaterialFilenameBase,
} from "./materialEngine.js";

// One pasted graph is either a Blueprint event graph or a material graph; the
// two share this UI but run different engines. Pick the engine set once from
// the detected type so the parse/render/export call sites stay uniform.
const BLUEPRINT_ENGINE = {
  parse: parseBlueprint, render: renderASCII, notes: generateReviewNotes,
  meta: extractFunctionMetadata, markdown: generateMarkdown, filename: deriveFilenameBase,
};
const MATERIAL_ENGINE = {
  parse: parseMaterial, render: renderMaterialASCII, notes: generateMaterialReviewNotes,
  meta: extractMaterialMetadata, markdown: generateMaterialMarkdown, filename: deriveMaterialFilenameBase,
};
function engineFor(text) {
  return detectGraphType(text) === "material" ? MATERIAL_ENGINE : BLUEPRINT_ENGINE;
}

const ACCENT = "#4a8ab8"; // Sky blue

// Robust clipboard helper. The modern API path is fine on HTTPS; the
// execCommand fallback covers sandboxed embeds and the rare browser quirk.
async function robustCopy(text) {
  if (!text) return "failed";
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function" && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return "clipboard";
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:none;outline:none;opacity:0";
    document.body.appendChild(ta);
    const prev = document.activeElement;
    ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand && document.execCommand("copy");
    document.body.removeChild(ta);
    if (prev && typeof prev.focus === "function") { try { prev.focus(); } catch (_) { /* ignore */ } }
    return ok ? "execCommand" : "failed";
  } catch (e) {
    return "failed";
  }
}

export default function App() {
  const mobile = useIsMobile();
  const S = getStyles(mobile);
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [showDataPins, setShowDataPins] = useState(true);
  const [includeRaw, setIncludeRaw] = useState(false);
  const [view, setView] = useState("editor");
  const [notification, notify] = useNotification();
  const [showMore, setShowMore] = useState(false);
  const [parseError, setParseError] = useState(null);
  const [showWarnings, setShowWarnings] = useState(false);
  const fileInputRef = useRef(null);

  // Parse + render. Memoized on input + toggles so typing in the name field
  // doesn't re-parse. The parser runs <50ms for typical pastes.
  const graphType = useMemo(() => detectGraphType(input), [input]);
  const engine = useMemo(() => engineFor(input), [input]);

  const { parsed, ascii, reviewNotes, metadata } = useMemo(() => {
    if (!input.trim()) return { parsed: null, ascii: "", reviewNotes: [], metadata: null };
    try {
      const p = engine.parse(input);
      const a = engine.render(p, { showDataPins });
      const notes = engine.notes(p);
      const meta = engine.meta(p);
      return { parsed: p, ascii: a, reviewNotes: notes, metadata: meta };
    } catch (err) {
      console.warn("Graph parse failed:", err);
      return { parsed: null, ascii: "", reviewNotes: [], metadata: null };
    }
  }, [input, showDataPins, engine]);

  // Surface parse errors as an error bar rather than silently dropping them.
  useEffect(() => {
    if (input.trim() && !parsed && !parseError) {
      setParseError("Parse failed - check that the paste begins with `Begin Object Class=...`");
    } else if (parsed && parseError) {
      setParseError(null);
    }
  }, [input, parsed, parseError]);

  // Auto-suggest the export filename when the name field is blank.
  const suggestedName = useMemo(() => {
    if (!parsed) return "";
    return engine.filename(parsed, "");
  }, [parsed, engine]);

  const update = (v) => { setInput(v); setShowWarnings(false); };
  const updateName = (v) => { setName(v); setShowWarnings(false); };

  const newDoc = () => {
    setInput(""); setName("");
    setShowWarnings(false); setParseError(null);
    notify("Cleared", "success");
  };

  const buildMd = () => {
    if (!parsed || !ascii) return null;
    return engine.markdown(parsed, ascii, {
      name: (name && name.trim()) || suggestedName || "untitled",
      timestamp: new Date().toISOString(),
      includeRaw,
      rawInput: input,
    });
  };

  const copyAscii = async () => {
    if (!ascii) return;
    const r = await robustCopy(ascii);
    notify(r === "failed" ? "Copy failed" : "ASCII copied", r === "failed" ? "error" : "success");
  };

  const copyMd = async () => {
    const md = buildMd();
    if (!md) return;
    const r = await robustCopy(md);
    notify(r === "failed" ? "Copy failed" : "Markdown copied", r === "failed" ? "error" : "success");
  };

  const exportTxt = () => {
    if (!ascii) return;
    const fname = engine.filename(parsed, name) + ".txt";
    downloadFile(ascii, fname, "text/plain;charset=utf-8");
    notify("Downloaded " + fname, "success");
  };

  const exportMd = () => {
    const md = buildMd();
    if (!md) return;
    const fname = engine.filename(parsed, name) + ".md";
    downloadFile(md, fname, "text/markdown;charset=utf-8");
    notify("Downloaded " + fname, "success");
  };

  const importPaste = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = (ev) => { setInput(ev.target.result); notify("Imported", "success"); };
    r.readAsText(f);
    e.target.value = "";
  };

  // Styles specific to this view - paste/output split, identity strip.
  const splitStyle = mobile
    ? { display: "flex", flexDirection: "column", flex: 1, overflow: "hidden", gap: "8px", padding: "8px" }
    : { display: "flex", flex: 1, overflow: "hidden", gap: "8px", padding: "8px" };

  const paneStyle = (extra = {}) => ({
    flex: 1, minHeight: mobile ? "200px" : "auto",
    display: "flex", flexDirection: "column",
    background: C.bgPanel, border: `1px solid ${C.border}`, borderRadius: "4px",
    overflow: "hidden", ...extra,
  });

  const paneHeader = {
    padding: mobile ? "8px 10px" : "6px 10px",
    background: C.bgSection, borderBottom: `1px solid ${C.border}`,
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: mobile ? "11px" : "10px", color: C.textMuted,
    textTransform: "uppercase", letterSpacing: "1px",
    flexShrink: 0,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", background: C.bg, color: C.text, fontFamily: "'JetBrains Mono','Cascadia Code','Fira Code',monospace" }}>
      <input ref={fileInputRef} type="file" accept=".txt,.bp" style={{ display: "none" }} onChange={importPaste} />

      {notification && (
        <div style={{...S.notification, background: notificationBg(notification.type)}}>{notification.msg}</div>
      )}

      {showMore && (
        <div style={S.moreOverlay} onClick={() => setShowMore(false)}>
          <div style={S.moreMenu} onClick={(e) => e.stopPropagation()}>
            <button style={S.moreMenuItem} onClick={() => { newDoc(); setShowMore(false); }}>
              <span style={S.moreMenuIcon}>+</span>New Diagram
            </button>
            <div style={S.moreMenuDivider} />
            <button style={S.moreMenuItem} onClick={() => { fileInputRef.current?.click(); setShowMore(false); }}>
              <span style={S.moreMenuIcon}>↓</span>Import Paste
            </button>
            <button style={S.moreMenuItem} onClick={() => { copyAscii(); setShowMore(false); }}>
              <span style={S.moreMenuIcon}>⎘</span>Copy ASCII
            </button>
            <button style={S.moreMenuItem} onClick={() => { copyMd(); setShowMore(false); }}>
              <span style={S.moreMenuIcon}>⎘</span>Copy Markdown
            </button>
            <button style={S.moreMenuItem} onClick={() => { exportTxt(); setShowMore(false); }}>
              <span style={S.moreMenuIcon}>↑</span>Export .txt
            </button>
            <button style={S.moreMenuItem} onClick={() => { exportMd(); setShowMore(false); }}>
              <span style={S.moreMenuIcon}>↑</span>Export .md
            </button>
          </div>
        </div>
      )}

      {!mobile && (
        <div style={S.header}>
          <div style={S.headerLeft}>
            <span style={{ ...S.subtitle, color: ACCENT, fontWeight: 700, fontSize: "12px", letterSpacing: "1px" }}>
              UE BLUEPRINT → MARKDOWN
            </span>
          </div>
          <div style={S.headerRight}>
            <button style={{ ...S.tabBtn, ...(view === "editor" ? S.tabActive : {}) }} onClick={() => setView("editor")}>Editor</button>
            <button style={{ ...S.tabBtn, ...(view === "markdown" ? S.tabActive : {}) }} onClick={() => setView("markdown")}>Markdown</button>
            <span style={S.divider}>|</span>
            <button style={S.actionBtn} onClick={newDoc}>New</button>
            <button style={S.actionBtn} onClick={() => fileInputRef.current?.click()}>Import</button>
            <button style={S.actionBtn} onClick={copyAscii}>Copy ASCII</button>
            <button style={S.actionBtn} onClick={copyMd}>Copy MD</button>
            <button style={{ ...S.actionBtn, ...S.exportBtn }} onClick={exportTxt}>.txt</button>
            <button style={{ ...S.actionBtn, ...S.exportBtn }} onClick={exportMd}>.md</button>
          </div>
        </div>
      )}

      {parseError && view === "editor" && (
        <div style={S.errorBar}><span style={S.errorItem}>{parseError}</span></div>
      )}
      {reviewNotes.length > 0 && view === "editor" && showWarnings && (
        <div style={S.warningBar}>
          {reviewNotes.slice(0, 4).map((n, i) => (
            <span key={i} style={S.warningItem} title={n.text}>
              {n.label}
            </span>
          ))}
          {reviewNotes.length > 4 && (
            <span style={S.warningItem}>+{reviewNotes.length - 4} more</span>
          )}
        </div>
      )}

      {/* Identity strip - name + toggles, always visible above the split */}
      <div style={{
        display: "flex", flexWrap: "wrap", gap: mobile ? "8px" : "10px",
        padding: mobile ? "8px 10px" : "8px 12px",
        background: C.bgSection, borderBottom: `1px solid ${C.border}`,
        alignItems: "center", flexShrink: 0,
      }}>
        <div style={{ flex: mobile ? "1 1 100%" : "1 1 auto", minWidth: mobile ? "100%" : "300px" }}>
          <input
            style={S.input}
            value={name}
            onChange={(e) => updateName(e.target.value)}
            placeholder={suggestedName ? `(auto: ${suggestedName})` : "Diagram name (e.g. AC_QuestManager.TurnInQuest)"}
          />
        </div>
        <label style={{ ...S.checkLabel, whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={showDataPins} onChange={(e) => setShowDataPins(e.target.checked)} />
          Show data pins
        </label>
        <label style={{ ...S.checkLabel, whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} />
          Embed raw in .md
        </label>
        {parsed && (
          <span style={{ color: C.textDim, fontSize: mobile ? "11px" : "10px", marginLeft: "auto" }}>
            {graphType === "material" ? "material · " : ""}{parsed.nodes.length} nodes
            {metadata && (() => {
              const r = metadata.variableRefs;
              const n = (r ? r.self.size + r.local.size + r.external.size : 0);
              return n > 0 ? ` · ${n} var${n === 1 ? "" : "s"}` : "";
            })()}
          </span>
        )}
      </div>

      {view === "editor" && (
        <div style={splitStyle}>
          <div style={paneStyle()}>
            <div style={paneHeader}>
              <span>{input.trim() ? (graphType === "material" ? "Material Paste" : "Blueprint Paste") : "Paste"}</span>
              <span>{input ? input.length.toLocaleString() + " chars" : "empty"}</span>
            </div>
            <textarea
              value={input}
              onChange={(e) => update(e.target.value)}
              placeholder="Right-click selected nodes in the UE Blueprint editor > Copy. Paste here."
              spellCheck={false}
              style={{
                flex: 1, background: C.bgInput, color: C.text, border: "none",
                padding: mobile ? "10px" : "12px", fontFamily: "inherit",
                fontSize: mobile ? "12px" : "11px", resize: "none", outline: "none",
                lineHeight: "1.5",
              }}
            />
          </div>
          <div style={paneStyle()}>
            <div style={paneHeader}>
              <span>ASCII Diagram</span>
              <span>{ascii ? ascii.split("\n").length + " lines" : "idle"}</span>
            </div>
            <pre style={{
              flex: 1, margin: 0, padding: mobile ? "10px" : "12px",
              background: C.bgInput, color: C.text,
              fontFamily: "Menlo, Consolas, 'Courier New', monospace",
              fontSize: mobile ? "11px" : "11px",
              lineHeight: 1, whiteSpace: "pre", overflow: "auto",
              paddingBottom: mobile ? "70px" : "12px",
            }}>{ascii || (
              <span style={{ color: C.textDark, fontStyle: "italic" }}>
                waiting for input...
              </span>
            )}</pre>
          </div>
        </div>
      )}

      {view === "markdown" && (
        <div style={S.jsonContainer}>
          <div style={S.jsonToolbar}>
            <button style={{ ...S.actionBtn, ...S.exportBtn }} onClick={copyMd}>Copy</button>
            <button style={{ ...S.actionBtn, ...S.exportBtn }} onClick={exportMd}>Download .md</button>
          </div>
          <pre style={{ ...S.jsonPre, lineHeight: 1, fontFamily: "Menlo, Consolas, 'Courier New', monospace" }}>{buildMd() || "// paste a Blueprint to see the markdown export"}</pre>
        </div>
      )}

      {mobile && (
        <div style={S.bottomBar}>
          <button style={{ ...S.bottomBtn, ...(view === "editor" ? S.bottomBtnActive : {}) }} onClick={() => setView("editor")}>
            <span style={S.bottomBtnIcon}>✎</span><span style={S.bottomBtnLabel}>Editor</span>
          </button>
          <button style={{ ...S.bottomBtn, ...(view === "markdown" ? S.bottomBtnActive : {}) }} onClick={() => setView("markdown")}>
            <span style={S.bottomBtnIcon}>≡</span><span style={S.bottomBtnLabel}>Markdown</span>
          </button>
          <button style={S.bottomBtn} onClick={() => fileInputRef.current?.click()}>
            <span style={S.bottomBtnIcon}>↓</span><span style={S.bottomBtnLabel}>Import</span>
          </button>
          <button style={S.bottomBtn} onClick={() => setShowMore(true)}>
            <span style={S.bottomBtnIcon}>⋯</span><span style={S.bottomBtnLabel}>More</span>
          </button>
        </div>
      )}
    </div>
  );
}
