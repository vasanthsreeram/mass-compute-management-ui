import { handleRequest, tickMeter } from "./api";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(tickMeter(env));
  },
} satisfies ExportedHandler<Env>;
