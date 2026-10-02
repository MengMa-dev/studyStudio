import { z } from "zod";

const WRAP_KEY = "result" as const;

/** True when the top-level schema is a union / discriminated union (OpenAI strict JSON Schema forbids top-level anyOf). */
export function isTopLevelUnion(schema: z.ZodType): boolean {
  const type = (schema as unknown as { def?: { type?: string } }).def?.type;
  return type === "union" || type === "discriminatedUnion";
}

export function wrapUnionSchema<T>(schema: z.ZodType<T>): z.ZodObject<{ result: z.ZodType<T> }> {
  return z.object({ [WRAP_KEY]: schema });
}

export function unwrapUnionResult<T>(value: unknown, wrapped: boolean): T {
  if (!wrapped) return value as T;
  if (value && typeof value === "object" && WRAP_KEY in (value as object)) {
    return (value as { result: T }).result;
  }
  return value as T;
}

export type PreparedSchema<T> = {
  schema: z.ZodType<T | { result: T }>;
  wrapped: boolean;
  systemSuffix: string;
};

/**
 * For openai-compatible providers, wrap top-level unions as `{ result: ... }`.
 * Gemini / Ollama / mock can use the schema as-is.
 */
export function prepareSchemaForProvider<T>(schema: z.ZodType<T>, wrapTopLevelUnion: boolean): PreparedSchema<T> {
  if (wrapTopLevelUnion && isTopLevelUnion(schema)) {
    return {
      schema: wrapUnionSchema(schema),
      wrapped: true,
      systemSuffix: "\n把最终结果放在 result 字段中。"
    };
  }
  return { schema, wrapped: false, systemSuffix: "" };
}

export function schemaHintForPrompt(schema: z.ZodType): string {
  try {
    return `\n\n输出必须符合以下 JSON Schema：\n${JSON.stringify(z.toJSONSchema(schema))}`;
  } catch {
    return "\n\n只输出符合约定结构的 JSON 对象。";
  }
}
