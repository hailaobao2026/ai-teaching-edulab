import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "edulab-db-test-")), "db.json");
fs.writeFileSync(dbFile, JSON.stringify({ users: [], sessions: [], jobs: [], lessons: [], assets: [], config: {} }));
process.env.USE_MYSQL = "false";
process.env.MEMORY_DB_FILE = dbFile;
process.env.SEED_DEMO_ACCOUNTS = "false";
process.env.SESSION_TTL_HOURS = "1";
const db = await import("../db.js");

const user = await db.createUser({
  email: "student@example.com",
  nickname: "学生",
  passwordHash: db.hashPassword("secret123"),
  role: "student"
});

test("db - job mapping and cancellation are consistent", async () => {
  const created = await db.createJob({ userId: user.id, skillId: "edu-solid-geometry", problemType: "cube" });
  assert.equal((await db.getJob(created.id)).userId, user.id);
  await db.claimQueuedJob();
  assert.equal((await db.cancelJob(created.id)).status, "cancelled");
  await db.completeJob(created.id, "lesson_should_not_attach");
  assert.equal((await db.getJob(created.id)).status, "cancelled");
});

test("db - anonymous lesson listing only returns approved public lessons", async () => {
  await db.createLesson({ userId: user.id, skillId: "s", problemType: "p", title: "private", htmlPath: "/tmp/private" });
  const draft = await db.createLesson({ userId: user.id, skillId: "s", problemType: "p", title: "draft", htmlPath: "/tmp/draft" });
  await db.updateLesson(draft.id, { visibility: "public" });
  const approved = await db.createLesson({ userId: user.id, skillId: "s", problemType: "p", title: "approved", htmlPath: "/tmp/approved" });
  await db.updateLesson(approved.id, { visibility: "public", publishStatus: "approved" });
  assert.deepEqual((await db.listLessons({ isAdmin: false })).map(lesson => lesson.title), ["approved"]);
});

test("db - failed jobs can be retried", async () => {
  const created = await db.createJob({ userId: user.id, skillId: "edu-solid-geometry", problemType: "cube" });
  await db.claimQueuedJob();
  await db.failJob(created.id, "test failure");
  assert.equal((await db.retryJob(created.id)).status, "queued");
});

test("db - expired sessions are rejected", async () => {
  const token = await db.createSession(user.id);
  const data = JSON.parse(fs.readFileSync(dbFile, "utf8"));
  data.sessions.find(session => session.token === token).created_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(dbFile, JSON.stringify(data));
  assert.equal(await db.getSessionUser(token), null);
});

after(() => fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }));
