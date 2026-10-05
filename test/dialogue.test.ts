import assert from "node:assert/strict";
import { test } from "node:test";
import { createDialogues } from "@app/modules/telegram/dialogue";

void test("dialogues bound text/history/scopes and expire without renewal by human messages", () => {
  let now = 0;
  const dialogues = createDialogues(() => now);
  dialogues.answered("a", { authorId: 1, text: "Hello" }, "Reply");
  for (let i = 0; i < 20; i++) dialogues.observe("a", { authorId: 2, text: "😀".repeat(700) });
  assert.equal(dialogues.get("a")!.turns.length, 6);
  assert.equal([...dialogues.get("a")!.turns[0]!.text].length, 600);
  now = 119_999;
  dialogues.observe("a", { authorId: 3, text: "Human discussion" });
  now++;
  assert.equal(dialogues.get("a"), undefined);
  for (let i = 0; i < 65; i++)
    dialogues.answered(String(i), { authorId: 1, text: "Hello" }, "Reply");
  assert.equal(dialogues.get("0"), undefined);
  assert.ok(dialogues.get("64"));
  dialogues.clear("64");
  assert.equal(dialogues.get("64"), undefined);
  dialogues.close();
  assert.equal(dialogues.get("63"), undefined);
});
