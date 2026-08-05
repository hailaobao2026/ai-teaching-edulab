import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "edulab-m2-"));
const dbFile = path.join(tmpRoot, "memory.json");
const molFile = path.join(tmpRoot, "molecule-extensions.json");
process.env.USE_MYSQL = "false";
process.env.MEMORY_DB_FILE = dbFile;
process.env.MOLECULE_EXTENSIONS_FILE = molFile;
process.env.SESSION_TTL_HOURS = "1";

const {
  staticCheckMolecule,
  normalizeMoleculeDefinition,
  upsertMoleculeExtension,
  listActiveMoleculeExtensions,
  writeTempExtensionsFile
} = await import("../services/ai/chem/moleculeStore.js");
const { collectSpeciesFromSpec, missingSpecies } = await import("../services/ai/chem/moleculeExtender.js");
const { validateChemSpec, renderChemSpec, selfcheckMolecule } = await import("../services/ai/chem/validateRender.js");

const so2 = {
  id: "SO2",
  formula: "SO₂",
  latex: "\\text{SO}_2",
  name: "二氧化硫",
  name_en: "sulfur dioxide",
  color: "yellow",
  atoms: [
    { slot: "A", el: "S", pos: [0, 0, 0] },
    { slot: "Oa", el: "O", pos: [1.1, 0.7, 0] },
    { slot: "Ob", el: "O", pos: [-1.1, 0.7, 0] }
  ],
  bonds: [
    { a: "A", b: "Oa", order: 2 },
    { a: "A", b: "Ob", order: 2 }
  ]
};

test("m2 molecule - static check and normalize", () => {
  const check = staticCheckMolecule(so2);
  assert.equal(check.ok, true, check.errors?.join("; "));
  const n = normalizeMoleculeDefinition(so2, "SO2");
  assert.equal(n.id, "SO2");
  assert.equal(n.atoms.length, 3);
});

test("m2 molecule - selfcheck python load", async () => {
  const workDir = path.join(tmpRoot, "self");
  const r = await selfcheckMolecule(so2, { workDir });
  assert.equal(r.ok, true, r.error);
});

test("m2 molecule - persist extension and validate/render with SO2", async () => {
  upsertMoleculeExtension(so2);
  const list = listActiveMoleculeExtensions();
  assert.ok(list.some(m => m.id === "SO2"));

  const workDir = path.join(tmpRoot, "work");
  const extFile = writeTempExtensionsFile(list, workDir);
  // simple identity-ish map not needed; use S + O2 -> SO2 style if possible with atom map
  const spec = {
    meta: {
      title: "二氧化硫形成（测试）",
      subtitle: "M2",
      language: "zh-CN",
      category: "inorganic",
      accent: "yellow",
      engine: "morph"
    },
    conditions: { text: "点燃", exothermic: true, flame: true },
    reactants: [
      { species: "S", count: 1 },
      { species: "O2", count: 1 }
    ],
    products: [
      { species: "SO2", count: 1 }
    ],
    atom_map: [
      // S may be missing builtin - use only SO2+O2 won't work. Inject S as mono as well
    ],
    steps: [
      { title: "1", html: "a" },
      { title: "2", html: "b" },
      { title: "3", html: "c" }
    ]
  };

  // also add mono S
  upsertMoleculeExtension({
    id: "S",
    formula: "S",
    latex: "\\text{S}",
    name: "硫",
    name_en: "sulfur",
    color: "yellow",
    atoms: [{ slot: "X", el: "S", pos: [0, 0, 0] }],
    bonds: []
  });
  const all = listActiveMoleculeExtensions();
  const ext2 = writeTempExtensionsFile(all, workDir);
  spec.atom_map = [
    ["S#1.X", "SO2#1.A"],
    ["O2#1.Oa", "SO2#1.Oa"],
    ["O2#1.Ob", "SO2#1.Ob"]
  ];

  const validated = await validateChemSpec(spec, { workDir, extensionsFile: ext2 });
  assert.equal(validated.ok, true, validated.error);
  const out = path.join(workDir, "out.html");
  const rendered = await renderChemSpec(spec, out, { workDir, extensionsFile: ext2 });
  assert.equal(rendered.ok, true, rendered.error);
  assert.ok(fs.existsSync(out));
  assert.ok(fs.statSync(out).size > 1000);
});

test("m2 molecule - missing species detection", () => {
  const spec = {
    reactants: [{ species: "HCl", count: 1 }],
    products: [{ species: "H2O", count: 1 }],
    atom_map: [["HCl#1.H", "H2O#1.Ha"]]
  };
  const miss = missingSpecies(spec);
  assert.ok(miss.includes("HCl"));
  assert.ok(!miss.includes("H2O"));
  assert.deepEqual(collectSpeciesFromSpec(spec).sort(), ["H2O", "HCl"].sort());
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
