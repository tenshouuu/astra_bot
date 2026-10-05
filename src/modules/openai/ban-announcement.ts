import OpenAI from "openai";
import type { AppConfig } from "@app/config/env";
import type { ResponsesClient } from "@app/modules/openai/api";
import { characterInstructions } from "@app/modules/openai/character";

export function createBanAnnouncement(
  config: Pick<AppConfig, "openaiApiKey" | "openaiModel">,
  client: ResponsesClient = new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 0 }),
): () => Promise<string> {
  let active = 0;
  return async () => {
    if (active >= 2) throw new Error("Ban announcement capacity reached");
    active++;
    try {
      const response = await client.responses.create(
        {
          model: config.openaiModel,
          instructions: `${characterInstructions}
Сейчас ты пишешь короткую реплику в группу после уже выполненного действия.
Достоверный факт: владелец подтвердил постоянный бан одного участника,
Telegram подтвердил бан с удалением только сообщений этого участника в этой группе.
Напиши по-русски 1–2 живых разговорных предложения, не более 300 символов.
Дай понять, что с этим разобралась, и мягко верни внимание к общению.
Не перечисляй действия как системный отчёт. Формулируй свободно, без канцелярита,
заготовленных лозунгов, злорадства, нравоучений и шуток за счёт человека.
Не называй имён, не упоминай владельца, не выдумывай причины бана или тему разговора.
Не называй участника спамером или мошенником. Не утверждай, что весь чат очищен.
Никаких ссылок, упоминаний, разметки, описаний жестов или дополнительных пояснений.
Верни только готовую реплику.`,
          input: "Сформулируй реплику для чата после подтверждённого бана.",
          store: false,
          max_output_tokens: 1024,
        },
        { timeout: 10_000, maxRetries: 0 },
      );
      const text = response.output_text.trim();
      if (response.status !== "completed" || !text || [...text].length > 300) {
        throw new Error("Invalid ban announcement");
      }
      return text;
    } finally {
      active--;
    }
  };
}
