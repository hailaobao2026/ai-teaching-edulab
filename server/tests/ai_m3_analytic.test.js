import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "edulab-m3-"));
const dbFile = path.join(tmpRoot, "memory.json");
process.env.USE_MYSQL = "false";
process.env.MEMORY_DB_FILE = dbFile;
process.env.SESSION_TTL_HOURS = "1";

const { matchKnownAnalyticProblem } = await import("../services/ai/analytic/knownProblems.js");
const { normalizeAnalyticSpec, extractJsonObject } = await import("../services/ai/analytic/llmSpec.js");
const { validateAnalyticSpec, renderAnalyticSpec } = await import("../services/ai/analytic/validateRender.js");
const { isAnalyticAiJob, runAnalyticAiPipeline } = await import("../services/ai/analytic/pipeline.js");
const { isChemAiJob } = await import("../services/ai/chem/pipeline.js");

const sampleSpec = {
  lesson: {
    language: "zh-CN",
    title: "椭圆演示",
    problem: "<p>椭圆 $\\dfrac{x^2}{4}+\\dfrac{y^2}{3}=1$</p>",
    answerLabel: "标准方程",
    answer: "$\\dfrac{x^2}{4}+\\dfrac{y^2}{3}=1$"
  },
  steps: [
    { title: "写出方程", content: "<p>由 $a^2=4,b^2=3$ 得标准方程。</p>" },
    { title: "结论", content: "<p>答案如上。</p>" }
  ],
  board: {
    view: { xRange: [-4, 4], yRange: [-3, 3] },
    conics: [
      { name: "C", kind: "ellipse", a: 2, b: 1.732, center: [0, 0], color: "curve", label: "C" }
    ],
    points: {
      F: { xy: [1, 0], color: "point", label: "F" }
    },
    param: { name: "t", label: "参数", min: 0, max: 180, step: 1, value: 45, standard: 45 },
    derived: [],
    readouts: [],
    legend: [{ color: "curve", text: "椭圆 C" }]
  }
};

test("m3 analytic - known problem matcher", () => {
  assert.equal(matchKnownAnalyticProblem("求椭圆上向量数量积的取值范围"), "ellipse_dot_range");
  assert.equal(matchKnownAnalyticProblem("双曲线离心率的取值范围"), "hyperbola_ecc_range");
  assert.equal(matchKnownAnalyticProblem("完全无关的内容xyz"), null);
});

test("m3 analytic - normalize and extract json", () => {
  const raw = "```json\n" + JSON.stringify({ lesson: { title: "t" }, steps: [], board: {} }) + "\n```";
  const obj = extractJsonObject(raw);
  const spec = normalizeAnalyticSpec(obj);
  assert.equal(spec.lesson.language, "zh-CN");
  assert.ok(spec.steps.length >= 2);
  assert.ok(spec.board.conics.length >= 1);
});

test("m3 analytic - validate/render sample spec", async () => {
  const workDir = path.join(tmpRoot, "work");
  const validated = await validateAnalyticSpec(sampleSpec, { workDir });
  assert.equal(validated.ok, true, validated.error);
  const out = path.join(workDir, "out.html");
  const rendered = await renderAnalyticSpec(sampleSpec, out, { workDir });
  assert.equal(rendered.ok, true, rendered.error);
  assert.ok(fs.existsSync(out));
  const html = fs.readFileSync(out, "utf8");
  assert.ok(html.includes("LESSON") || html.includes("lesson") || html.length > 1000);
  assert.ok(fs.statSync(out).size > 1000);
});

test("m3 analytic - pipeline known fast path without LLM", async () => {
  const workDir = path.join(tmpRoot, "pipe");
  const outputPath = path.join(workDir, "lesson.html");
  const result = await runAnalyticAiPipeline({
    kind: "ai",
    skillHint: "edu-analytic-geometry",
    inputMode: "text",
    sourceText: "请演示椭圆数量积取值范围",
    title: "M3 known"
  }, { outputPath, workDir });
  assert.equal(result.aiMeta.route, "known_registry");
  assert.equal(result.problemType, "ellipse_dot_range");
  assert.ok(fs.existsSync(outputPath));
  assert.ok(fs.statSync(outputPath).size > 1000);
});

test("m3 analytic - routing helpers", () => {
  assert.equal(isAnalyticAiJob({ kind: "ai", skillHint: "edu-analytic-geometry" }), true);
  assert.equal(isAnalyticAiJob({ kind: "ai", skillHint: "edu-chem-reaction" }), false);
  assert.equal(isChemAiJob({ kind: "ai", skillHint: "edu-analytic-geometry" }), false);
  assert.equal(isChemAiJob({ kind: "ai", skillHint: "edu-chem-reaction" }), true);
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
