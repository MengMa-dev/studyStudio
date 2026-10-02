/** Identifiable gateway / search errors for callers (organize pipeline, settings UI). */

export class AiGatewayError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AiGatewayError";
    this.code = code;
  }
}

/** Daily token budget exceeded. Manual flows may pass allowOverLimit after confirmation. */
export class UsageLimitExceededError extends AiGatewayError {
  readonly day: string;
  readonly used: number;
  readonly limit: number;
  constructor(day: string, used: number, limit: number) {
    super("usage_limit_exceeded", `Daily token limit exceeded: used ${used}, limit ${limit} (day ${day})`);
    this.name = "UsageLimitExceededError";
    this.day = day;
    this.used = used;
    this.limit = limit;
  }
}

/** Context window overflow — do not retry; caller should chunk / shrink input. */
export class ContextTooLongError extends AiGatewayError {
  constructor(message: string, options?: ErrorOptions) {
    super("context_too_long", message, options);
    this.name = "ContextTooLongError";
  }
}

export class ProviderNotFoundError extends AiGatewayError {
  constructor(id: string) {
    super("provider_not_found", `Provider not found: ${id}`);
    this.name = "ProviderNotFoundError";
  }
}

export class TaskModelNotConfiguredError extends AiGatewayError {
  constructor(task: string) {
    super("task_model_not_configured", `No model configured for task: ${task}`);
    this.name = "TaskModelNotConfiguredError";
  }
}

/** Fixture replay miss: no recorded response for task + inputHash. */
export class FixtureNotFoundError extends AiGatewayError {
  readonly task: string;
  readonly inputHash: string;
  constructor(task: string, inputHash: string) {
    super("fixture_not_found", `No LLM fixture for task=${task} inputHash=${inputHash}. Record one under test/fixtures/llm/${task}/.`);
    this.name = "FixtureNotFoundError";
    this.task = task;
    this.inputHash = inputHash;
  }
}

export class AllModelsFailedError extends AiGatewayError {
  readonly failures: { role: "primary" | "fallback"; providerId: string; model: string; error: string }[];
  constructor(failures: AllModelsFailedError["failures"]) {
    const detail = failures.map((f) => `${f.role} ${f.providerId}/${f.model}: ${f.error}`).join("; ");
    super("all_models_failed", `All models failed: ${detail}`);
    this.name = "AllModelsFailedError";
    this.failures = failures;
  }
}

export function isAiGatewayError(error: unknown): error is AiGatewayError {
  return error instanceof AiGatewayError;
}
