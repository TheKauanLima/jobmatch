/**
 * The single seam that turns a zod output schema into the structured-output
 * wire format, per docs/ARCHITECTURE.md §13.5.2 "Decision on `enum`" item 2.
 *
 * `buildOutputFormat(schema)` is a deliberate pass-through over the pinned
 * SDK helper: `{ type: 'json_schema', schema: zodOutputFormat(schema).schema }`
 * and nothing else. There is no wire-schema post-processing of our own.
 *
 * Why it exists anyway:
 *  - It is the ONLY importer of `zodOutputFormat` in the codebase (a grep test
 *    in outputSchemas.test.ts enforces this). `buildStructuredParams` (sync)
 *    and `lib/claude/batches.ts` (M2.2) both call it, so sync/batch parity is
 *    structural.
 *  - It is the one place an SDK schema regression would be fixed, and the one
 *    thing the wire-schema snapshots and enum guards exercise.
 *
 * What the pinned SDK (1.8.0) emits, which the tests treat as normative:
 *  - `enum` kept on every enum path, as `{ enum: [...] }` with no sibling `type`;
 *  - nullable enums as `anyOf: [{ $ref -> { enum } }, { type: 'null' }]`;
 *  - numeric ranges, string lengths, `maxItems` and `minItems` > 1 moved into
 *    `description` (not enforced server-side; `validateX` re-checks them);
 *  - `additionalProperties: false` and full `required` on every object.
 *
 * Only the `schema` goes on the wire. The helper's `parse` function is not
 * used (see the client.ts docstring for why we parse ourselves).
 */

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

/**
 * Structurally identical to both `Anthropic.JSONOutputFormat` and
 * `Anthropic.Beta.Messages.BetaJSONOutputFormat`, so the same value fits the
 * sync (beta) and batch request params.
 */
export type WireOutputFormat = {
  type: "json_schema";
  schema: { [key: string]: unknown };
};

export function buildOutputFormat<T>(schema: z.ZodType<T>): WireOutputFormat {
  return { type: "json_schema", schema: zodOutputFormat(schema).schema };
}
