export type Observation = Readonly<{
  updateId: number;
  chatId: bigint;
  userId: bigint;
  messageId: number;
  topicId?: number;
  text: string;
  replyText: string;
  authorLabel: string;
  isBot: boolean;
  sentAt: Date;
}>;

export type ReviewCase = Observation & {
  id: string;
  firstSeenAt: Date;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  status: string;
  attempts: number;
  availableAt: Date;
  category: string | null;
  reason: string | null;
  notificationMessageId: number | null;
  decidedBy: bigint | null;
  decidedAt: Date | null;
  action?: string;
  requestedBy?: bigint | null;
};

export type Classification = Readonly<{
  category: "clean" | "spam" | "advertising" | "suspicious" | "community_event";
  reason: string;
}>;

export type Evidence = Readonly<{
  text: string;
  replyText: string;
  isBot: boolean;
  firstSeenAt: string;
  observedMessageCount: number;
  previousMessages: readonly string[];
  exactRepeats: number;
}>;

export type Classify = (evidence: Evidence) => Promise<Classification>;

export type CaseChange = Partial<
  Pick<
    ReviewCase,
    | "category"
    | "reason"
    | "notificationMessageId"
    | "decidedBy"
    | "decidedAt"
    | "availableAt"
    | "action"
    | "requestedBy"
  >
>;

export interface ModerationStore {
  observe(input: Observation): Promise<void>;
  queued(limit: number): Promise<ReviewCase[]>;
  claimAnalysis(id: string): Promise<boolean>;
  history(item: ReviewCase): Promise<string[]>;
  get(id: string): Promise<ReviewCase | null>;
  isCurrent(item: ReviewCase): Promise<boolean>;
  hasOpenReview(item: ReviewCase): Promise<boolean>;
  transition(id: string, from: string, to: string, change?: CaseChange): Promise<boolean>;
  recover(): Promise<void>;
  prune(): Promise<void>;
  search(
    chatId: bigint,
    topicId: number | undefined,
    query: string,
    userId: bigint | null,
  ): Promise<
    {
      messageId: number;
      userId: bigint;
      text: string;
      sentAt: Date;
    }[]
  >;
  source(
    chatId: bigint,
    topicId: number | undefined,
    messageId: number,
  ): Promise<ReviewCase | null>;
}

export const REVIEW_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_QUEUED_CASES = 64;
