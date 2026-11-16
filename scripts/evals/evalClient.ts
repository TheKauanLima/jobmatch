/**
 * The one Anthropic client factory for manual eval scripts (scripts/evals/*).
 * Per docs/ARCHITECTURE.md §13.5.2 "Client construction and SDK telemetry"
 * items 1b and 3, every client here is built with:
 *  - `openTelemetry: false`: no SDK tracing, whatever the env says;
 *  - `logLevel: "warn"`: `ANTHROPIC_LOG=debug` can't make the SDK log request
 *    bodies.
 * Never pass a custom `logger`, and never `withOptions({ logLevel })` with
 * debug/info. lib/claude/client.test.ts constructs this factory and asserts
 * both options on the resolved client.
 *
 * App code never uses this; it uses lib/claude/client.ts#getClaudeClient.
 */

import Anthropic from "@anthropic-ai/sdk";

export type EvalClientOptions = {
  apiKey: string;
  maxRetries: number;
  /** Only for local, network-free checks (a fake fetch). */
  fetch?: typeof fetch;
};

export function createEvalClient(opts: EvalClientOptions): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    maxRetries: opts.maxRetries,
    fetch: opts.fetch, // undefined -> the SDK default
    openTelemetry: false,
    logLevel: "warn",
  });
}
