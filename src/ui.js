// ============================================================================
// ui.js — Color tokens, responsive style factory, and small hooks.
//
// This is the pure presentation slice of the original Banishment editor's
// shared.js, carried over verbatim. No storage, no API, no localStorage —
// the standalone tool is a stateless paste/export converter.
// ============================================================================

import { useState, useEffect, useCallback } from "react";

// -- HOOKS ------------------------------------------------------------------

export function useIsMobile(bp = 768) {
  const [m, setM] = useState(typeof window !== "undefined" ? window.innerWidth < bp : false);
  useEffect(() => { const c = () => setM(window.innerWidth < bp); window.addEventListener("resize", c); return () => window.removeEventListener("resize", c); }, [bp]);
  return m;
}

export function useNotification() {
  const [n, setN] = useState(null);
  // Warnings stay visible longer than success/error so users can read them.
  const notify = useCallback((msg, type = "info") => {
    setN({ msg, type });
    setTimeout(() => setN(null), type === "warning" ? 5000 : 3000);
  }, []);
  return [n, notify];
}

export function notificationBg(type) {
  if (type === "error") return "#5a2020";
  if (type === "success") return "#1a4a2a";
  if (type === "warning") return "#3a3000";
  return "#2a3a4a";
}

// -- FILE HELPERS -----------------------------------------------------------

export function downloadFile(c, f, t) { const b = new Blob([c],{type:t}); const u = URL.createObjectURL(b); const a = document.createElement("a"); a.href=u; a.download=f; a.click(); URL.revokeObjectURL(u); }

// -- COLORS & TOKENS --------------------------------------------------------

export const C = {
  bg:"#12151c", bgPanel:"#14171f", bgSection:"#1a1e28", bgInput:"#0d0f14",
  border:"#2a2e38", borderLight:"#22262e", borderFocus:"#4a5060",
  text:"#c8ccd4", textMuted:"#888", textDim:"#666", textDimmer:"#555", textDark:"#444",
  accent:"#7a9ec4", accentBorder:"#2a3a4a", accentBg:"#1a2a3a",
  green:"#6ab08a", greenBg:"#1a3a2a", greenBorder:"#2a4a3a",
  yellow:"#ccaa44", yellowBg:"#3a3a1a", yellowBorder:"#5a5a2a",
  red:"#a04040", redBg:"#5a2020", redBorder:"#5a2020",
  purple:"#bb66dd", purpleBg:"#3a1a4a", json:"#8a9a6a",
  warningBg:"#2a2200", warningBorder:"#443300",
};

export const FONT = "'JetBrains Mono','Cascadia Code','Fira Code',monospace";

// -- RESPONSIVE STYLE FACTORY -----------------------------------------------

export function getStyles(m) {
  const p = m ? "10px" : "6px 8px";
  const fs = m ? "14px" : "12px";
  const fss = m ? "13px" : "11px";
  const fst = m ? "12px" : "10px";
  const fsl = m ? "11px" : "10px";
  const th = m ? "44px" : "auto";

  return {
    header: m
      ? { display:"flex",alignItems:"center",padding:"10px 12px",background:C.bgSection,borderBottom:`1px solid ${C.border}`,flexShrink:0,gap:"8px",flexWrap:"wrap" }
      : { display:"flex",alignItems:"center",padding:"6px 16px",background:C.bgSection,borderBottom:`1px solid ${C.border}`,flexShrink:0,gap:"4px" },
    headerLeft: { display:"flex",alignItems:"center",gap:"8px" },
    headerRight:{ display:"flex",alignItems:"center",gap:m?"6px":"4px",flexWrap:"wrap",flex:1,justifyContent:"flex-end" },
    subtitle:   { color:C.textMuted,fontSize:m?"11px":"10px",textTransform:"uppercase",letterSpacing:"1px" },
    tabBtn:     { background:"transparent",border:`1px solid ${C.border}`,color:C.textMuted,padding:m?"8px 12px":"4px 10px",borderRadius:"3px",cursor:"pointer",fontSize:m?"12px":"11px",fontFamily:"inherit",minHeight:th },
    tabActive:  { background:C.accentBg,borderColor:C.accent,color:C.accent,fontWeight:700 },
    actionBtn:  { background:"transparent",border:`1px solid ${C.border}`,color:C.textMuted,padding:m?"8px 10px":"3px 10px",borderRadius:"3px",cursor:"pointer",fontSize:m?"12px":"10px",fontFamily:"inherit",whiteSpace:"nowrap",minHeight:th },
    exportBtn:  { borderColor:C.accentBorder,color:C.accent },
    divider:    { color:C.textDark,padding:"0 2px" },
    notification:{ padding:m?"10px 16px":"6px 16px",fontSize:m?"13px":"11px",borderBottom:`1px solid ${C.border}`,flexShrink:0 },
    warningBar: { display:"flex",gap:"12px",padding:m?"8px 12px":"4px 16px",background:C.warningBg,borderBottom:`1px solid ${C.warningBorder}`,flexShrink:0,flexWrap:"wrap" },
    warningItem:{ color:C.yellow,fontSize:m?"12px":"10px" },
    errorBar:   { display:"flex",gap:"12px",padding:m?"8px 12px":"4px 16px",background:C.redBg,borderBottom:`1px solid ${C.redBorder}`,flexShrink:0,flexWrap:"wrap" },
    errorItem:  { color:"#ff8888",fontSize:m?"12px":"10px",fontWeight:600 },

    input:        { width:"100%",background:C.bgInput,border:`1px solid ${C.border}`,color:C.text,padding:p,borderRadius:"3px",fontSize:fs,fontFamily:"inherit",boxSizing:"border-box",minHeight:th },
    checkLabel:   { color:C.textMuted,fontSize:m?"14px":"11px",display:"flex",alignItems:"center",gap:m?"8px":"5px",cursor:"pointer",whiteSpace:"nowrap",minHeight:th },

    jsonContainer:{ flex:1,overflow:"hidden",display:"flex",flexDirection:"column" },
    jsonToolbar:  { display:"flex",gap:"8px",padding:m?"8px 12px":"8px 16px",background:C.bgSection,borderBottom:`1px solid ${C.border}`,flexShrink:0 },
    jsonPre:      { flex:1,overflowY:"auto",margin:0,padding:m?"12px":"16px",background:C.bgInput,color:C.json,fontSize:m?"12px":"11px",lineHeight:"1.4",fontFamily:"inherit",paddingBottom:m?"70px":"16px" },

    bottomBar:    { display:"flex",alignItems:"center",justifyContent:"space-around",padding:"6px 8px",paddingBottom:"max(6px, env(safe-area-inset-bottom))",paddingLeft:"max(8px, env(safe-area-inset-left))",paddingRight:"max(8px, env(safe-area-inset-right))",background:"#0d0f14",borderTop:`1px solid ${C.border}`,flexShrink:0,gap:"4px" },
    bottomBtn:    { display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",background:"transparent",border:"none",color:C.textMuted,padding:"4px 6px",cursor:"pointer",fontSize:"10px",fontFamily:"inherit",minHeight:"44px",minWidth:"48px",gap:"2px",borderRadius:"4px" },
    bottomBtnActive:{ color:C.accent,background:C.accentBg+"44" },
    bottomBtnIcon:  { fontSize:"18px",lineHeight:"1" },
    bottomBtnLabel: { fontSize:"9px",letterSpacing:"0.3px" },

    moreOverlay:  { position:"fixed",inset:0,background:"rgba(0,0,0,0.6)",zIndex:900,display:"flex",flexDirection:"column",justifyContent:"flex-end" },
    moreMenu:     { background:C.bgSection,borderTop:`1px solid ${C.border}`,borderRadius:"12px 12px 0 0",padding:"8px 0",paddingBottom:"max(8px, env(safe-area-inset-bottom))" },
    moreMenuItem: { display:"flex",alignItems:"center",gap:"12px",padding:"14px 20px",color:C.text,fontSize:"14px",fontFamily:"inherit",background:"transparent",border:"none",cursor:"pointer",width:"100%",textAlign:"left" },
    moreMenuIcon: { fontSize:"18px",width:"24px",textAlign:"center" },
    moreMenuDivider:{ height:"1px",background:C.border,margin:"4px 16px" },
  };
}
