export type AssistantTool = Readonly<{
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}>;

export type AssistantRuntime = Readonly<{
  tools: readonly AssistantTool[];
  requestContext: Record<string, unknown>;
  execute(name: string, args: unknown): Promise<unknown>;
  authorizeResponse?(): Promise<boolean>;
}>;
