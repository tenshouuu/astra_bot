import type { Api } from "grammy";
import type { AppConfig } from "@app/config/env";
import { configuredChatIds } from "@app/modules/telegram/access";

export async function resolveOwnerId(
  config: AppConfig,
  api: Pick<Api, "getChatAdministrators">,
): Promise<number> {
  const username = config.ownerUsername.trim().replace(/^@/, "").toLowerCase();
  const ids = configuredChatIds(config);
  const chats: readonly (number | string)[] = ids.length
    ? ids
    : [`@${config.allowedChatUsername!.trim().replace(/^@/, "")}`];
  const owners = new Set<number>();
  for (const chat of chats) {
    const administrators = await api.getChatAdministrators(chat);
    for (const { user } of administrators) {
      if (!user.is_bot && user.username?.toLowerCase() === username) {
        if (!Number.isSafeInteger(user.id) || user.id <= 0)
          throw new Error("Invalid owner identity");
        owners.add(user.id);
      }
    }
  }
  if (owners.size !== 1) {
    throw new Error("OWNER_USERNAME must identify one administrator in the allowed groups");
  }
  return [...owners][0]!;
}
