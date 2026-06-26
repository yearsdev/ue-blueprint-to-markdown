import { describe, it, expect } from "vitest";
import {
  parseDataTable, looksLikeDataTable, renderDataTableASCII,
  extractDataTableMetadata, generateDataTableReviewNotes,
  generateDataTableMarkdown, deriveDataTableFilenameBase,
} from "../datatableEngine.js";
import { detectGraphType } from "../materialEngine.js";

// The exact row from the feature request: a spell row with two NSLOCTEXT fields
// (namespace carries the owning DT asset name + a GUID), floats padded to six
// decimals, bools, and None object refs.
const SPELL_ROW =
  '(SpellID="Lesser_Heal",SpellName=NSLOCTEXT("DT_NPCSpells_New [D8ED5DE5BE39E446394B4328B29D6617]", "Lesser_Heal_SpellName", "Lesser Heal"),' +
  'SpellDescription=NSLOCTEXT("DT_NPCSpells_New [D8ED5DE5BE39E446394B4328B29D6617]", "Lesser_Heal_SpellDescription", "A weak restorative, used by priests and shamans to mend their allies."),' +
  'SpellType="Heal",EffectType="",DamageType="Magic",Duration=0.000000,Magnitude=40.000000,ResistModifier=1.000000,' +
  'IsCurable=False,IsDispellable=False,BreaksOnDamage=False,CastTime=3.000000,RecastTime=25.000000,Range=200.000000,' +
  'CastVFX=None,ImpactVFX=None,ResistVFX=None,CastSound=None,ImpactSound=None,ResistSound=None)';

describe("detectGraphType / looksLikeDataTable", () => {
  it("routes a UStruct row literal to the datatable engine", () => {
    expect(looksLikeDataTable(SPELL_ROW)).toBe(true);
    expect(detectGraphType(SPELL_ROW)).toBe("datatable");
  });

  it("does not misclassify Blueprint or material pastes", () => {
    expect(looksLikeDataTable('Begin Object Class=/Script/BlueprintGraph.K2Node_Event Name="X"')).toBe(false);
    expect(detectGraphType('Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="M"\nMaterialExpression="/Script/Engine.MaterialExpressionAdd\'A\'"')).toBe("material");
    expect(looksLikeDataTable("")).toBe(false);
  });
});

describe("parseDataTable", () => {
  it("parses fields, normalizes floats, and resolves NSLOCTEXT to display text", () => {
    const p = parseDataTable(SPELL_ROW);
    expect(p.rows).toHaveLength(1);
    const row = p.rows[0];
    expect(row.fieldMap.get("SpellID")).toBe("Lesser_Heal");
    expect(row.fieldMap.get("SpellName")).toBe("Lesser Heal");
    expect(row.fieldMap.get("SpellDescription")).toBe(
      "A weak restorative, used by priests and shamans to mend their allies."
    );
    expect(row.fieldMap.get("EffectType")).toBe("");
    expect(row.fieldMap.get("IsCurable")).toBe("False");
    expect(row.fieldMap.get("CastVFX")).toBe("None");
  });

  it("derives the row name from an Id field and the asset name from the loc namespace", () => {
    const p = parseDataTable(SPELL_ROW);
    expect(p.rows[0].name).toBe("Lesser_Heal");
    expect(p.structName).toBe("DT_NPCSpells_New");
    expect(deriveDataTableFilenameBase(p, "")).toBe("DT_NPCSpells_New");
  });

  it("parses nested struct and array values", () => {
    const p = parseDataTable('(Tint=(R=1.000000,G=0.500000,B=0.000000,A=1.000000),Tags=("a","b"))');
    expect(p.rows[0].fieldMap.get("Tint")).toEqual({
      kind: "struct",
      entries: [
        { key: "R", value: "1.000000" },
        { key: "G", value: "0.500000" },
        { key: "B", value: "0.000000" },
        { key: "A", value: "1.000000" },
      ],
    });
    expect(p.rows[0].fieldMap.get("Tags")).toEqual({ kind: "array", items: ["a", "b"] });
  });

  it("parses multiple rows with leading row names", () => {
    const text = 'Lesser_Heal,(SpellID="Lesser_Heal",Magnitude=40.000000)\nGreater_Heal,(SpellID="Greater_Heal",Magnitude=80.000000)';
    const p = parseDataTable(text);
    expect(p.rows.map((r) => r.name)).toEqual(["Lesser_Heal", "Greater_Heal"]);
    expect(p.fields).toEqual(["SpellID", "Magnitude"]);
  });
});

describe("render + markdown", () => {
  it("renders an aligned key/value block with normalized floats", () => {
    const p = parseDataTable(SPELL_ROW);
    const ascii = renderDataTableASCII(p);
    expect(ascii).toContain("● Lesser_Heal");
    expect(ascii).toMatch(/SpellName\s+Lesser Heal/);
    expect(ascii).toMatch(/Magnitude\s+40\n/);
    expect(ascii).toMatch(/Duration\s+0\n/);
    expect(ascii).toMatch(/EffectType\s+—/);
  });

  it("single row -> vertical Field|Value markdown table", () => {
    const p = parseDataTable(SPELL_ROW);
    const md = generateDataTableMarkdown(p, renderDataTableASCII(p), { name: "DT_NPCSpells_New" });
    expect(md).toContain("# DT_NPCSpells_New");
    expect(md).toContain("| Field | Value |");
    expect(md).toContain("| SpellName | Lesser Heal |");
    expect(md).toContain("| Magnitude | 40 |");
  });

  it("many rows -> columnar markdown table, one line per record", () => {
    const text = 'Lesser_Heal,(SpellID="Lesser_Heal",Magnitude=40.000000)\nGreater_Heal,(SpellID="Greater_Heal",Magnitude=80.000000)';
    const p = parseDataTable(text);
    const md = generateDataTableMarkdown(p, renderDataTableASCII(p), {});
    expect(md).toContain("| Row | SpellID | Magnitude |");
    expect(md).toContain("| Lesser_Heal | Lesser_Heal | 40 |");
    expect(md).toContain("| Greater_Heal | Greater_Heal | 80 |");
  });

  it("flags rows with missing fields", () => {
    const text = '(SpellID="A",Magnitude=1.000000)\n(SpellID="B")';
    const p = parseDataTable(text);
    const notes = generateDataTableReviewNotes(p);
    expect(notes.some((n) => /missing fields/.test(n.label))).toBe(true);
  });

  it("exposes row count through metadata", () => {
    const p = parseDataTable(SPELL_ROW);
    expect(extractDataTableMetadata(p).rowCount).toBe(1);
  });
});
