import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildStructuredParams } from "@/lib/claude/client";
import { CLAUDE_TASKS, type ClaudeTaskName } from "@/lib/claude/config";
import { buildOutputFormat } from "@/lib/claude/outputFormat";
import { matchResultSchema, resumeAnalysisResultSchema } from "@/lib/claude/parse";
import { importsOf, isTestFile, REPO_ROOT, repoSourceFiles, stripComments } from "@/tests/helpers/sdkImports";

/**
 * Wire-schema guards for every Claude output schema, per
 * docs/ARCHITECTURE.md §13.5.2 "Decision on `enum`" item 6 (M1.1b).
 *
 * The wire schema is the pinned SDK helper's output, unmodified
 * (`buildOutputFormat`). These tests pin what that output must look like, so
 * an SDK or zod bump that changes it fails here instead of silently changing
 * what the model is constrained to.
 */

// ---------------------------------------------------------------------------
// Output-schema registry (test-only)
// ---------------------------------------------------------------------------

/**
 * One entry per task in CLAUDE_TASKS. `null` means the task's schema hasn't
 * been written yet; the milestone that implements the task (M2.2, M2.3, M3.x)
 * replaces its `null` with the schema. Typed as a full Record so a new task
 * without an entry is a type error, and checked at runtime below in case test
 * files aren't type-checked.
 */
const OUTPUT_SCHEMAS: Record<ClaudeTaskName, z.ZodType | null> = {
  extractResumeProfile: null, // M2.3
  critiqueResume: null, // M3.x
  extractJobRequirements: null, // M2.2
  rerankJobsForRole: null, // M3.x
  narrateRoleFit: null, // M3.x
  assessJobFit: null, // M3.x
  analyzeResume: resumeAnalysisResultSchema,
  matchResumeToJob: matchResultSchema,
};

/** Design cap from §13.5.2 item 3. Lives here, not in runtime code. */
const OUTPUT_ENUM_MAX_VALUES = 64;

const registered = (Object.entries(OUTPUT_SCHEMAS) as Array<[ClaudeTaskName, z.ZodType | null]>).filter(
  (entry): entry is [ClaudeTaskName, z.ZodType] => entry[1] !== null,
);

// ---------------------------------------------------------------------------
// Fixture: every enum shape §13.5.4 schemas will use, plus stripped constraints
// ---------------------------------------------------------------------------

const Level = z.enum(["intern", "junior", "mid", "senior"]);

const FixtureSchema = z.object({
  plain: z.enum(["red", "green"]),
  nullable: z.enum(["a", "b", "c"]).nullable().describe("A nullable enum."),
  list: z.array(z.enum(["x", "y"])),
  reusedOne: Level,
  reusedTwo: z.object({ level: Level.nullable() }),
  score: z.number().int().min(0).max(100),
  label: z.string().min(1).max(80),
  tags: z.array(z.string()).max(5),
  slug: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Helpers: walk zod defs and wire JSON Schema in parallel
// ---------------------------------------------------------------------------

type JsonNode = { [key: string]: unknown };
type ZodDef = { type: string; [key: string]: unknown };

function zdef(schema: unknown): ZodDef {
  return (schema as { _zod: { def: ZodDef } })._zod.def;
}

type EnumPath = { path: string; values: unknown[]; nullable: boolean };

/**
 * Every `z.enum` in a zod schema, with its path and whether it sits directly
 * under `.nullable()`. Throws on zod node types it doesn't know, so a schema
 * using a new construct forces this walker to be extended rather than having
 * its enums skipped.
 */
function collectEnums(schema: unknown, path = "$", nullable = false): EnumPath[] {
  const def = zdef(schema);
  switch (def.type) {
    case "enum":
      return [{ path, values: Object.values(def.entries as Record<string, unknown>), nullable }];
    case "nullable":
      return collectEnums(def.innerType, path, true);
    case "optional":
      return collectEnums(def.innerType, path, nullable);
    case "object":
      return Object.entries(def.shape as Record<string, unknown>).flatMap(([key, child]) =>
        collectEnums(child, `${path}.${key}`),
      );
    case "array":
      return collectEnums(def.element, `${path}[]`);
    case "string":
    case "number":
    case "int":
    case "boolean":
    case "null":
      return [];
    default:
      throw new Error(`collectEnums: unsupported zod type "${def.type}" at ${path}; extend the walker.`);
  }
}

function resolveRef(root: JsonNode, node: JsonNode): JsonNode {
  let current = node;
  for (let hops = 0; typeof current.$ref === "string"; hops += 1) {
    if (hops > 10) throw new Error("ref cycle");
    const ref = current.$ref as string;
    expect(ref.startsWith("#/$defs/"), ref).toBe(true);
    current = (root.$defs as Record<string, JsonNode>)[ref.slice("#/$defs/".length)];
    expect(current, ref).toBeDefined();
  }
  return current;
}

/** Wire node at a collectEnums path, following `$ref` and nullable `anyOf`. */
function wireNodeAt(root: JsonNode, path: string): { node: JsonNode; nullBranch: boolean } {
  const segments = path.replace(/^\$/, "").match(/\.[^.[\]]+|\[\]/g) ?? [];
  let node = resolveRef(root, root);
  let nullBranch = false;
  const unwrapNullable = () => {
    nullBranch = false;
    if (Array.isArray(node.anyOf)) {
      const branches = (node.anyOf as JsonNode[]).map((b) => resolveRef(root, b));
      const nonNull = branches.filter((b) => b.type !== "null");
      nullBranch = branches.length - nonNull.length === 1;
      expect(nonNull.length).toBe(1);
      node = nonNull[0];
    }
  };
  unwrapNullable();
  for (const seg of segments) {
    if (seg === "[]") {
      expect(node.type).toBe("array");
      node = resolveRef(root, node.items as JsonNode);
    } else {
      expect(node.type).toBe("object");
      node = resolveRef(root, (node.properties as Record<string, JsonNode>)[seg.slice(1)]);
    }
    unwrapNullable();
  }
  return { node, nullBranch };
}

/** Visits every schema node (not property names) in a wire schema. */
function visitSchemaNodes(node: unknown, visit: (n: JsonNode) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as JsonNode;
  visit(n);
  for (const child of Object.values((n.properties as Record<string, unknown>) ?? {})) visitSchemaNodes(child, visit);
  for (const child of Object.values((n.$defs as Record<string, unknown>) ?? {})) visitSchemaNodes(child, visit);
  if (n.items) visitSchemaNodes(n.items, visit);
  for (const key of ["anyOf", "allOf", "oneOf"]) {
    for (const child of (n[key] as unknown[]) ?? []) visitSchemaNodes(child, visit);
  }
}

function wire(schema: z.ZodType): JsonNode {
  return buildOutputFormat(schema).schema as JsonNode;
}

/**
 * §13.5.2 "Decision on `enum`" item 3: every output-schema `z.enum` has
 * 1..OUTPUT_ENUM_MAX_VALUES values, all strings. Throws on the first violation.
 */
function assertEnumRules(schema: z.ZodType): void {
  for (const e of collectEnums(schema)) {
    if (e.values.length === 0) throw new Error(`${e.path}: empty enum`);
    if (e.values.length > OUTPUT_ENUM_MAX_VALUES) {
      throw new Error(`${e.path}: ${e.values.length} values (max ${OUTPUT_ENUM_MAX_VALUES}); data-driven vocabularies must be z.string()`);
    }
    const bad = e.values.find((v) => typeof v !== "string");
    if (bad !== undefined) throw new Error(`${e.path}: value ${String(bad)} is not a string`);
  }
}

const allSchemas: Array<[string, z.ZodType]> = [...registered, ["fixture", FixtureSchema]];

// ---------------------------------------------------------------------------

describe("OUTPUT_SCHEMAS registry", () => {
  it("has exactly one entry per CLAUDE_TASKS task", () => {
    expect(Object.keys(OUTPUT_SCHEMAS).sort()).toEqual(Object.keys(CLAUDE_TASKS).sort());
  });

  it("every task referenced by an implementation in lib/ has a non-null schema", () => {
    // A task counts as implemented once lib/ code outside config.ts names it (a
    // runner constant, a callStructured `task:`, a handler) or a
    // lib/claude/tasks/<task>.ts file exists. Its milestone must then replace
    // the registry's null.
    const sources = repoSourceFiles()
      .filter((f) => f.startsWith("lib/") && !isTestFile(f) && f !== "lib/claude/config.ts")
      .map((f) => ({ file: f, code: stripComments(readFileSync(join(REPO_ROOT, f), "utf8")) }));
    const names = (task: string, code: string) => ['"', "'", "`"].some((q) => code.includes(`${q}${task}${q}`));
    const implemented = (Object.keys(CLAUDE_TASKS) as ClaudeTaskName[]).filter((task) =>
      sources.some(({ file, code }) => file === `lib/claude/tasks/${task}.ts` || names(task, code)),
    );
    expect(implemented).toEqual(expect.arrayContaining(["analyzeResume", "matchResumeToJob"]));
    expect(implemented.filter((task) => OUTPUT_SCHEMAS[task] === null)).toEqual([]);
  });

  it("registers the schemas of the tasks implemented so far", () => {
    expect(registered.map(([task]) => task).sort()).toEqual(["analyzeResume", "matchResumeToJob"]);
  });
});

describe("buildOutputFormat", () => {
  it("returns exactly { type: 'json_schema', schema } (no parse function on the wire)", () => {
    const format = buildOutputFormat(FixtureSchema);
    expect(Object.keys(format)).toEqual(["type", "schema"]);
    expect(format.type).toBe("json_schema");
    expect(JSON.parse(JSON.stringify(format))).toEqual(format);
  });

  it("is deterministic", () => {
    expect(buildOutputFormat(FixtureSchema)).toEqual(buildOutputFormat(FixtureSchema));
  });
});

describe("wire-schema snapshots (review snapshot updates like code)", () => {
  it.each(registered)("%s", (_task, schema) => {
    expect(buildOutputFormat(schema)).toMatchSnapshot();
  });

  it("fixture", () => {
    expect(buildOutputFormat(FixtureSchema)).toMatchSnapshot();
  });
});

describe("enum coverage on the wire", () => {
  it("the fixture walker finds every enum shape", () => {
    expect(collectEnums(FixtureSchema).map((e) => [e.path, e.nullable])).toEqual([
      ["$.plain", false],
      ["$.nullable", true],
      ["$.list[]", false],
      ["$.reusedOne", false],
      ["$.reusedTwo.level", true],
    ]);
  });

  it.each(allSchemas)("%s: every z.enum path has `enum` with the zod values on the wire", (_name, schema) => {
    const root = wire(schema);
    for (const e of collectEnums(schema)) {
      const { node } = wireNodeAt(root, e.path);
      expect(node.enum, e.path).toEqual(e.values);
    }
  });

  it.each(allSchemas)("%s: nullable enums allow null on the wire", (_name, schema) => {
    const root = wire(schema);
    for (const e of collectEnums(schema).filter((x) => x.nullable)) {
      const { node, nullBranch } = wireNodeAt(root, e.path);
      expect(nullBranch || (node.enum as unknown[]).includes(null), e.path).toBe(true);
    }
  });

  it("fixture: nullable enums use the anyOf + {type:'null'} form (what SDK 1.8.0 emits)", () => {
    const root = wire(FixtureSchema);
    const properties = root.properties as Record<string, JsonNode>;
    for (const node of [properties.nullable, (properties.reusedTwo.properties as Record<string, JsonNode>).level]) {
      const branches = node.anyOf as JsonNode[];
      expect(branches).toHaveLength(2);
      expect(branches[1]).toEqual({ type: "null" });
      expect(resolveRef(root, branches[0]).enum).toBeDefined();
    }
  });

  it("fixture: a reused enum is emitted once in $defs and referenced at both paths", () => {
    const root = wire(FixtureSchema);
    const defs = Object.values(root.$defs as Record<string, JsonNode>);
    expect(defs.filter((d) => JSON.stringify(d.enum) === JSON.stringify(Level.options))).toHaveLength(1);
    const properties = root.properties as Record<string, JsonNode>;
    expect(typeof properties.reusedOne.$ref).toBe("string");
  });

  it("fixture: enum nodes are { enum } with no sibling type, and the values aren't copied into description", () => {
    const root = wire(FixtureSchema);
    visitSchemaNodes(root, (n) => {
      if ("enum" in n) {
        expect(n).not.toHaveProperty("type");
        expect(String(n.description ?? "")).not.toContain("enum");
      }
    });
  });
});

describe("output-schema design rules", () => {
  it.each(allSchemas)(
    `%s: every z.enum has <= ${OUTPUT_ENUM_MAX_VALUES} values, all strings (no data-driven vocabularies)`,
    (_name, schema) => {
      expect(() => assertEnumRules(schema)).not.toThrow();
    },
  );

  it("the enum guard throws on an oversized enum (e.g. a skills vocabulary)", () => {
    const skills = Array.from({ length: OUTPUT_ENUM_MAX_VALUES + 1 }, (_, i) => `skill-${i}`) as [string, ...string[]];
    const oversized = z.object({ nested: z.object({ skill: z.enum(skills).nullable() }) });
    expect(() => assertEnumRules(oversized)).toThrow(/\$\.nested\.skill: 65 values/);
  });

  it("the enum guard accepts exactly OUTPUT_ENUM_MAX_VALUES values", () => {
    const max = Array.from({ length: OUTPUT_ENUM_MAX_VALUES }, (_, i) => `v${i}`) as [string, ...string[]];
    expect(() => assertEnumRules(z.object({ v: z.enum(max) }))).not.toThrow();
  });

  it("the enum guard throws on non-string enum values", () => {
    expect(() => assertEnumRules(z.object({ n: z.enum({ ONE: 1, TWO: 2 }) }))).toThrow(/not a string/);
  });

  it.each(allSchemas)("%s: no `const` anywhere on the wire (no z.literal in output schemas)", (_name, schema) => {
    visitSchemaNodes(wire(schema), (n) => expect(n).not.toHaveProperty("const"));
  });

  it.each(allSchemas)(
    "%s: numeric/length/array-size constraints stay off the wire (validateX enforces them)",
    (_name, schema) => {
      visitSchemaNodes(wire(schema), (n) => {
        for (const key of [
          "minimum",
          "maximum",
          "exclusiveMinimum",
          "exclusiveMaximum",
          "multipleOf",
          "minLength",
          "maxLength",
          "maxItems",
        ]) {
          expect(n).not.toHaveProperty(key);
        }
        if ("minItems" in n) expect([0, 1]).toContain(n.minItems);
      });
    },
  );

  it("fixture: stripped constraints survive only as a description hint", () => {
    const properties = wire(FixtureSchema).properties as Record<string, JsonNode>;
    expect(properties.score).toMatchObject({ type: "integer" });
    expect(String(properties.score.description)).toContain("minimum: 0");
    expect(String(properties.label.description)).toContain("maxLength: 80");
    expect(String(properties.tags.description)).toContain("maxItems: 5");
  });

  it.each(allSchemas)("%s: every object has additionalProperties:false and full required", (_name, schema) => {
    visitSchemaNodes(wire(schema), (n) => {
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect([...((n.required as string[]) ?? [])].sort()).toEqual(
          Object.keys((n.properties as JsonNode) ?? {}).sort(),
        );
      }
    });
  });
});

describe("single wire-schema seam", () => {
  it.each(registered)("%s: buildStructuredParams sends exactly buildOutputFormat(schema)", (task, schema) => {
    const params = buildStructuredParams({
      task,
      system: [{ type: "text", text: "rules" }],
      userContent: "content",
      schema,
    });
    expect(params.output_config?.format).toEqual(buildOutputFormat(schema));
  });

  it("buildStructuredParams sends exactly buildOutputFormat(schema) for the enum fixture", () => {
    const params = buildStructuredParams({
      task: "matchResumeToJob",
      system: [{ type: "text", text: "rules" }],
      userContent: "content",
      schema: FixtureSchema,
    });
    expect(params.output_config?.format).toEqual(buildOutputFormat(FixtureSchema));
  });

  it("the SDK helpers (zodOutputFormat) are value-imported only by lib/claude/outputFormat.ts (test files exempt)", () => {
    const importers: string[] = [];
    for (const file of repoSourceFiles().filter((f) => !isTestFile(f))) {
      for (const site of importsOf(readFileSync(join(REPO_ROOT, file), "utf8"))) {
        if (site.typeOnly) continue;
        if (/^@anthropic-ai\/sdk\/helpers(\/|$)/.test(site.specifier) || site.bindings.includes("zodOutputFormat")) {
          importers.push(file);
        }
      }
    }
    expect([...new Set(importers)]).toEqual(["lib/claude/outputFormat.ts"]);
  });
});
