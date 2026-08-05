import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dbFile = path.join(os.tmpdir(), `edulab-ai-m0-${process.pid}-${Date.now()}.json`);
process.env.USE_MYSQL = "false";
process.env.MEMORY_DB_FILE = dbFile;
process.env.SESSION_TTL_HOURS = "1";
process.env.AI_QUOTA_STUDENT = "2";
process.env.AI_ENABLED = "true";

const db = await import("../db.js");
const { getQuotaStatus, consumeAiQuota } = await import("../services/ai/quota.js");
const { getSub2ApiConfig, healthCheck } = await import("../services/llm/sub2apiClient.js");
const { sanitizeHtml } = await import("../services/ai/sanitize.js");
const { saveImageAsset } = await import("../services/ai/image/recognize.js");

const user = await db.createUser({
  email: "ai-student@example.com",
  nickname: "AI学生",
  passwordHash: db.hashPassword("secret123"),
  role: "student"
});

test("ai m0 - createJob stores kind/inputMode/sourceText", async () => {
  const job = await db.createJob({
    userId: user.id,
    skillId: "edu-chem-reaction",
    problemType: "ai_dynamic",
    kind: "ai",
    inputMode: "text",
    sourceText: "甲烷燃烧",
    skillHint: "edu-chem-reaction",
    idempotencyKey: "idem-1",
    aiMeta: { provider: "sub2api" }
  });
  assert.equal(job.kind, "ai");
  assert.equal(job.inputMode, "text");
  assert.equal(job.sourceText, "甲烷燃烧");
  assert.equal(job.idempotencyKey, "idem-1");
  const again = await db.findJobByIdempotencyKey(user.id, "idem-1");
  assert.equal(again.id, job.id);
});

test("ai m0 - atomic AI job creation deduplicates and charges once", async () => {
  const atomicUser = await db.createUser({
    email: "atomic@example.com",
    nickname: "原子用户",
    passwordHash: db.hashPassword("secret123"),
    role: "student"
  });
  const fields = {
    userId: atomicUser.id,
    quotaLimit: 10,
    usageDate: "2099-01-01",
    skillId: "edu-chem-reaction",
    problemType: "ai_dynamic",
    inputMode: "text",
    sourceText: "水的电解",
    skillHint: "edu-chem-reaction",
    idempotencyKey: "atomic-1"
  };
  const results = await Promise.all([db.createAiJob(fields), db.createAiJob(fields)]);
  assert.equal(results[0].job.id, results[1].job.id);
  assert.equal(results.filter(result => result.reused).length, 1);
  assert.equal(await db.getAiDailyUsage(atomicUser.id, "2099-01-01"), 1);
});

test("ai m0 - quota increments and enforces limit", async () => {
  const before = await getQuotaStatus(user);
  assert.equal(before.limit, 2);
  const q1 = await consumeAiQuota(user);
  assert.equal(q1.used, 1);
  const q2 = await consumeAiQuota(user);
  assert.equal(q2.used, 2);
  await assert.rejects(() => consumeAiQuota(user), err => err.code === "QUOTA_EXCEEDED");
});

test("ai m0 - image draft lifecycle", async () => {
  const draft = await db.createAiImageDraft({
    userId: user.id,
    skillHint: "edu-analytic-geometry",
    editable: { problemText: "椭圆题" },
    warnings: ["m0"]
  });
  assert.equal(draft.status, "pending_confirm");
  const updated = await db.updateAiImageDraft(draft.id, {
    assetPath: "server/uploads/ai-images/draft.png",
    editable: { problemText: "椭圆题", equation: "x^2/4+y^2/3=1" },
    status: "confirmed",
    confirmedJobId: "job_x"
  });
  assert.equal(updated.status, "confirmed");
  assert.equal(updated.editable.equation, "x^2/4+y^2/3=1");
  assert.equal(updated.confirmedJobId, "job_x");
});

test("ai m0 - sanitizes generated HTML and validates image signatures", () => {
  const safe = sanitizeHtml('<p>Hello</p><script>alert(1)</script><img src=x onerror=alert(2)>');
  assert.equal(safe, '<p>Hello</p>alert(1)');

  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  const assetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "edulab-image-"));
  process.env.AI_IMAGE_UPLOAD_ROOT = assetRoot;
  assert.throws(() => saveImageAsset({ draftId: "bad", base64: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }), /格式与 MIME/);
  const saved = saveImageAsset({ draftId: "ok", base64: png.toString("base64"), mimeType: "image/png" });
  assert.equal(saved.mimeType, "image/png");
  assert.equal(fs.existsSync(saved.absPath), true);
  fs.rmSync(assetRoot, { recursive: true, force: true });
  delete process.env.AI_IMAGE_UPLOAD_ROOT;
});

test("ai m0 - sub2api config and unconfigured health", async () => {
  const cfg = getSub2ApiConfig({ baseUrl: "", apiKey: "" });
  assert.equal(cfg.configured, false);
  const health = await healthCheck({ baseUrl: "", apiKey: "" });
  assert.equal(health.ok, false);
  assert.equal(health.code, "SUB2API_NOT_CONFIGURED");
});

after(() => { try { fs.unlinkSync(dbFile); } catch {} try { fs.unlinkSync(`${dbFile}.lock`); } catch {} });
