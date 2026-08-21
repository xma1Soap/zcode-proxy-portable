/**
 * OpenAI-format route handlers: /v1/chat/completions + /v1/models.
 * @see .omo/plans/zcode-proxy.md Task 7
 */
import { proxyRequest, type ProxyHandlerOptions } from "../proxy/handler.js";
import { MODELS } from "../provider/models.js";
import type { OpenAIModelList } from "../translator/types.js";
import type { ProxyConfig } from "../config/types.js";

/** Handle POST /v1/chat/completions — forward OpenAI-compatible chat requests upstream. */
export async function handleChatCompletions(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  return proxyRequest(req, "openai", opts);
}

/** Handle GET /v1/models — prefer config.models when set (start-plan whitelist). */
export function handleListModels(config?: Pick<ProxyConfig, "models">): Response {
  const ids = config?.models?.length ? config.models : MODELS.map((m) => m.id);
  const list: OpenAIModelList = {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model" as const,
      owned_by: "zcode-proxy",
    })),
  };
  return new Response(JSON.stringify(list), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
