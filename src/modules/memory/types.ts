export type ContextMessage = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type StoredMessage = Readonly<{
  id: bigint;
  role: string;
  author: string;
  text: string;
}>;

export type NewMessage = Readonly<{
  conversationId: string;
  externalId: string;
  role: "user" | "assistant";
  author: string;
  text: string;
  sentAt: Date;
}>;

export type Summary = Readonly<{
  text: string;
  throughId: bigint;
  version: number;
}>;

export interface MemoryStore {
  append(message: NewMessage): Promise<void>;
  context(
    conversationId: string,
    beforeExternalId: string,
  ): Promise<{
    summary: Summary;
    messages: StoredMessage[];
  }>;
  pending(conversationId: string): Promise<{
    summary: Summary;
    messages: StoredMessage[];
  }>;
  saveSummary(
    conversationId: string,
    previous: Summary,
    text: string,
    throughId: bigint,
  ): Promise<void>;
  reset(conversationId: string): Promise<void>;
  prune(before: Date): Promise<void>;
}

export type Summarize = (previous: string, messages: readonly ContextMessage[]) => Promise<string>;
