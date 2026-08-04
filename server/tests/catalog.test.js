import { test } from "node:test";
import assert from "node:assert";
import { validateRegisterPayload, normalizeRole, ROLES, isAdmin } from "../services/rbac.js";
import { listSkills, getSkill, getProblemType, skillsInstalled } from "../services/skillCatalog.js";

test("rbac - normalizeRole", () => {
  assert.equal(normalizeRole("admin"), ROLES.ADMIN);
  assert.equal(normalizeRole("teacher"), ROLES.TEACHER);
  assert.equal(normalizeRole("student"), ROLES.STUDENT);
  assert.equal(normalizeRole("unknown"), ROLES.STUDENT);
  assert.equal(normalizeRole(""), ROLES.STUDENT);
});

test("rbac - isAdmin", () => {
  assert.equal(isAdmin({ role: "admin" }), true);
  assert.equal(isAdmin({ role: "teacher" }), false);
  assert.equal(isAdmin(null), false);
});

test("rbac - validateRegisterPayload", () => {
  const valid = validateRegisterPayload({ email: "a@b.com", password: "123456", nickname: "Test" });
  assert.equal(valid.errors.length, 0);
  assert.equal(valid.email, "a@b.com");

  const invalid = validateRegisterPayload({ email: "bad", password: "123", nickname: "" });
  assert.ok(invalid.errors.length >= 2);
});

test("catalog - listSkills returns 3 skills", () => {
  const skills = listSkills();
  assert.equal(skills.length, 3);
  assert.ok(skills.some(s => s.id === "edu-solid-geometry"));
  assert.ok(skills.some(s => s.id === "edu-analytic-geometry"));
  assert.ok(skills.some(s => s.id === "edu-chem-reaction"));
});

test("catalog - problem types count", () => {
  const solid = getSkill("edu-solid-geometry");
  assert.equal(solid.problemTypes.length, 3);
  const analytic = getSkill("edu-analytic-geometry");
  assert.equal(analytic.problemTypes.length, 6);
  const chem = getSkill("edu-chem-reaction");
  assert.equal(chem.problemTypes.length, 6);
});

test("catalog - getProblemType", () => {
  assert.ok(getProblemType("edu-solid-geometry", "cube"));
  assert.ok(getProblemType("edu-analytic-geometry", "ellipse_dot_range"));
  assert.ok(getProblemType("edu-chem-reaction", "combustion_ch4"));
  assert.equal(getProblemType("edu-solid-geometry", "nonexistent"), null);
  assert.equal(getProblemType("nonexistent", "cube"), null);
});

test("catalog - skillsInstalled", () => {
  assert.equal(typeof skillsInstalled(), "boolean");
});
