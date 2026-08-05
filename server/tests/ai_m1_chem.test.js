import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "edulab-m1-"));
const dbFile = path.join(tmpRoot, "memory.json");
process.env.USE_MYSQL = "false";
process.env.MEMORY_DB_FILE = dbFile;
process.env.SESSION_TTL_HOURS = "1";

const { matchKnownChemReaction } = await import("../services/ai/chem/knownReactions.js");
const { normalizeChemSpec, extractJsonObject } = await import("../services/ai/chem/llmSpec.js");
const { validateChemSpec, renderChemSpec } = await import("../services/ai/chem/validateRender.js");
const { isChemAiJob, runChemAiPipeline } = await import("../services/ai/chem/pipeline.js");

test("m1 chem - known reaction matcher", () => {
  assert.equal(matchKnownChemReaction("请演示甲烷燃烧"), "combustion_ch4");
  assert.equal(matchKnownChemReaction("电解水实验"), "electrolysis_water");
  assert.equal(matchKnownChemReaction("完全不相关的内容xyz"), null);
});

test("m1 chem - json extract and normalize", () => {
  const raw = "```json\n{\"meta\":{\"title\":\"t\"},\"reactants\":[],\"products\":[],\"atom_map\":[]}\n```";
  const obj = extractJsonObject(raw);
  const spec = normalizeChemSpec(obj);
  assert.equal(spec.meta.engine, "morph");
  assert.equal(spec.steps.length, 3);
});

test("m1 chem - validate/render methane-like spec via kernel", async () => {
  const spec = {
    meta: {
      title: "甲烷的燃烧",
      subtitle: "测试",
      language: "zh-CN",
      category: "junior",
      accent: "amber",
      engine: "morph"
    },
    conditions: { text: "点燃", exothermic: true, flame: true },
    reactants: [
      { species: "CH4", count: 1, pos: [-4.0, 0.2, 0] },
      { species: "O2", count: 2 }
    ],
    products: [
      { species: "CO2", count: 1, pos: [-2.7, 1.1, 0] },
      { species: "H2O", count: 2 }
    ],
    atom_map: [
      ["CH4#1.C", "CO2#1.Y"],
      ["O2#1.Oa", "CO2#1.Xa"], ["O2#1.Ob", "CO2#1.Xb"],
      ["O2#2.Oa", "H2O#1.A"], ["O2#2.Ob", "H2O#2.A"],
      ["CH4#1.H1", "H2O#1.Ha"], ["CH4#1.H2", "H2O#1.Hb"],
      ["CH4#1.H3", "H2O#2.Ha"], ["CH4#1.H4", "H2O#2.Hb"]
    ],
    steps: [
      { title: "1", html: "a" },
      { title: "2", html: "b" },
      { title: "3", html: "c" }
    ]
  };
  const workDir = path.join(tmpRoot, "work");
  const validated = await validateChemSpec(spec, { workDir });
  assert.equal(validated.ok, true, validated.error);
  const out = path.join(workDir, "out.html");
  const rendered = await renderChemSpec(spec, out, { workDir });
  assert.equal(rendered.ok, true, rendered.error);
  assert.ok(fs.existsSync(out));
  assert.ok(fs.readFileSync(out, "utf8").includes("REACTION") || fs.statSync(out).size > 1000);
});

test("m1 chem - pipeline known fast path without LLM", async () => {
  const workDir = path.join(tmpRoot, "pipe");
  const outputPath = path.join(workDir, "lesson.html");
  const result = await runChemAiPipeline({
    kind: "ai",
    inputMode: "text",
    sourceText: "请生成甲烷燃烧的微观演示",
    skillHint: "edu-chem-reaction",
    title: ""
  }, { outputPath, workDir, onProgress: async () => {} });
  assert.equal(result.problemType, "combustion_ch4");
  assert.equal(result.aiMeta.route, "known_registry");
  assert.ok(fs.existsSync(outputPath));
});

test("m1 chem - isChemAiJob routing", () => {
  assert.equal(isChemAiJob({ kind: "ai", skillHint: "edu-chem-reaction" }), true);
  assert.equal(isChemAiJob({ kind: "ai", skillHint: "edu-analytic-geometry" }), false);
  assert.equal(isChemAiJob({ kind: "ai", skillHint: "" }), false);
  assert.equal(isChemAiJob({ kind: "ai", skillHint: "auto" }), false);
  assert.equal(isChemAiJob({ kind: "fixed" }), false);
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
