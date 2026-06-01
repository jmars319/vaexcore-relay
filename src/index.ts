import type { RelayEnv } from "./env";
import { handleRequest } from "./routes/router";
import { processOutboundRetryQueue } from "./routes/chat";

export {
  outboundRetryPersistence,
  outboundSendPersistence,
  processOutboundRetryQueue,
} from "./routes/chat";
export { readBoundedText } from "./http";

export default {
  async fetch(
    request: Request,
    env: RelayEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  async scheduled(
    _controller: ScheduledController,
    env: RelayEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(processOutboundRetryQueue(env));
  },
};
