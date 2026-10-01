import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import {
  auditMarkdownLinks,
  auditPathReferences,
  sourceComments,
} from "../scripts/audit-agents.mjs";

const root = path.resolve(import.meta.dirname, "..");
const markdown = path.join(root, "README.md");
const source = path.join(root, "scripts/audit-agents.mjs");

test("Markdown inline paths include runtime, test, and database directories", () => {
  for (const directory of ["src", "test", "prisma"]) {
    const findings = auditPathReferences(
      markdown,
      new Set(),
      true,
      `Current source: \`${directory}/missing-audit-fixture.ts\``,
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0].line, 1);
  }
  assert.deepEqual(auditPathReferences(markdown, new Set(), true, "`src/app.ts`"), []);
});

test("source comment extraction excludes literals and preserves line numbers", () => {
  const input = [
    'const text = "// src/missing-string.ts 😀";',
    "const template = `/* src/missing-template.ts */`;",
    "const pattern = /https?:\\/\\//;",
    "// See src/missing-comment.ts",
    "/* See [context](../AGENT_CONTEXT.md) */",
  ].join("\n");
  const comments = sourceComments(input);
  assert.ok(!comments.includes("missing-string"));
  assert.ok(!comments.includes("missing-template"));
  assert.match(comments, /missing-comment/);
  const findings = auditPathReferences(source, new Set(), false, comments, true);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
  assert.deepEqual(auditMarkdownLinks(source, root, comments), []);
});

test("comment links validate relative targets and heading anchors", () => {
  const comments = sourceComments(
    [
      "// [Missing](../missing-audit-fixture.md)",
      "// [Bad anchor](../README.md#missing-audit-heading)",
      "// [Existing](../README.md#commands)",
      "// [External](https://example.com/documentation)",
    ].join("\n"),
  );
  const findings = auditMarkdownLinks(source, root, comments);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((finding) => finding.line),
    [1, 2],
  );
});
