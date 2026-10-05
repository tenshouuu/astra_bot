import type { DialogueTurn } from "@app/modules/memory/types";
type Dialogue = { expiresAt: number; turns: DialogueTurn[] };

export function createDialogues(now: () => number = Date.now) {
  const active = new Map<string, Dialogue>();
  function get(scope: string): Dialogue | undefined {
    const dialogue = active.get(scope);
    if (dialogue && dialogue.expiresAt <= now()) {
      active.delete(scope);
      return undefined;
    }
    return dialogue;
  }
  function append(dialogue: Dialogue, turn: DialogueTurn) {
    dialogue.turns.push({ ...turn, text: [...turn.text].slice(0, 600).join("") });
    dialogue.turns = dialogue.turns.slice(-6);
  }
  return {
    get,
    observe(scope: string, turn: DialogueTurn) {
      const dialogue = get(scope);
      if (dialogue) append(dialogue, turn);
    },
    answered(scope: string, question: DialogueTurn, answer: string) {
      for (const key of active.keys()) get(key);
      let dialogue = get(scope);
      if (!dialogue) {
        dialogue = { expiresAt: 0, turns: [] };
        append(dialogue, question);
      }
      append(dialogue, { authorId: null, text: answer });
      dialogue.expiresAt = now() + 120_000;
      active.delete(scope);
      active.set(scope, dialogue);
      if (active.size > 64) active.delete(active.keys().next().value!);
    },
    clear(scope: string) {
      active.delete(scope);
    },
    close() {
      active.clear();
    },
  };
}
