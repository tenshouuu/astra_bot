import type { ContextMessage, StoredMessage } from "@app/modules/memory/types";

// UTF-8 bytes give a conservative, model-independent size limit.
export const HISTORY_BYTES = 12_000;
export const SUMMARY_BYTES = 3000;
export const MESSAGE_BYTES = 8000;
export const SUMMARY_INPUT_BYTES = 16_000;

export function limitText(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  let size = 0;

  for (const character of text) {
    size += Buffer.byteLength(character);
    if (size > bytes) break;
    result += character;
  }

  return result;
}

export function contextMessage(message: StoredMessage): ContextMessage {
  const author = limitText(message.author, 512);
  let text = limitText(message.text, MESSAGE_BYTES);
  let content = JSON.stringify({ author, text });

  // JSON escaping also counts toward the budget (for example, control characters).
  while (Buffer.byteLength(content) > MESSAGE_BYTES) {
    const smallerSize =
      Math.floor((Buffer.byteLength(text) * MESSAGE_BYTES) / Buffer.byteLength(content)) - 1;
    text = limitText(text, Math.max(0, smallerSize));
    content = JSON.stringify({ author, text });
  }

  return { role: message.role === "assistant" ? "assistant" : "user", content };
}

export function recentMessages(messages: readonly StoredMessage[]): ContextMessage[] {
  const result: ContextMessage[] = [];
  let remaining = HISTORY_BYTES;

  for (const message of [...messages].reverse()) {
    const item = contextMessage(message);
    const bytes = Buffer.byteLength(item.content);
    if (bytes > remaining) break;
    result.unshift(item);
    remaining -= bytes;
  }

  return result;
}
