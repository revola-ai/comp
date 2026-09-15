import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { asSchema, generateObject, JSONParseError, NoObjectGeneratedError } from 'ai';

/**
 * Direct Google Gemini models for the call sites that upstream routes through the
 * Vercel AI Gateway. The API key comes from GOOGLE_GENERATIVE_AI_API_KEY (the
 * provider's default); the SDK reports a clear error at call time if it is missing.
 */
export type GoogleModelRole = 'onboarding' | 'policyUpdate' | 'rerank';

export const DEFAULT_GOOGLE_MODEL_IDS: Record<GoogleModelRole, string> = {
  onboarding: 'gemini-3.5-flash',
  policyUpdate: 'gemini-3.5-flash',
  rerank: 'gemini-flash-lite-latest',
};

const MODEL_ENV_OVERRIDES: Record<GoogleModelRole, string> = {
  onboarding: 'AI_MODEL_ONBOARDING',
  policyUpdate: 'AI_MODEL_POLICY_UPDATE',
  rerank: 'AI_MODEL_RERANK',
};

let defaultProvider: ReturnType<typeof createGoogleGenerativeAI> | undefined;

function provider() {
  defaultProvider ??= createGoogleGenerativeAI();
  return defaultProvider;
}

function googleModelId(role: GoogleModelRole): string {
  const override = process.env[MODEL_ENV_OVERRIDES[role]]?.trim();
  return override || DEFAULT_GOOGLE_MODEL_IDS[role];
}

export function googleModel(role: GoogleModelRole): LanguageModelV3 {
  return provider()(googleModelId(role));
}

/** Any schema `generateObject` accepts (zod, Standard Schema, or `jsonSchema()`). */
type ObjectSchema = Exclude<Parameters<typeof asSchema>[0], undefined>;

type GenerateObjectOptions<SCHEMA extends ObjectSchema> = Parameters<
  typeof generateObject<SCHEMA, 'object'>
>[0];

type GenerateObjectReturn<SCHEMA extends ObjectSchema> = Awaited<
  ReturnType<typeof generateObject<SCHEMA, 'object'>>
>;

type StrictOptions<SCHEMA extends ObjectSchema> = Omit<
  GenerateObjectOptions<SCHEMA>,
  'prompt' | 'messages'
> & {
  /** Model prompt as a string; feedback from a failed attempt is appended to it. */
  prompt: string;
  /** Total attempts including the first (default 3). */
  maxValidationAttempts?: number;
};

const DEFAULT_MAX_VALIDATION_ATTEMPTS = 3;

/**
 * `generateObject` with a bounded regenerate-on-invalid-object loop, for object
 * output with a schema.
 *
 * The Google provider forwards only `minLength`, `enum`, `format`, `required`,
 * `anyOf` and `oneOf` to Gemini's response schema, so constraints such as
 * `.length(5)` or `.max(200)` are enforced only by local validation. When the
 * object fails to parse or validate, the failure is described back to the model
 * and the call is retried, up to `maxValidationAttempts` in total. Content-filter
 * stops and every other error propagate immediately.
 */
export async function generateObjectStrict<SCHEMA extends ObjectSchema>(
  options: StrictOptions<SCHEMA>,
): Promise<GenerateObjectReturn<SCHEMA>> {
  const { maxValidationAttempts = DEFAULT_MAX_VALIDATION_ATTEMPTS, prompt, ...rest } = options;
  const attempts = Number.isFinite(maxValidationAttempts)
    ? Math.max(1, Math.floor(maxValidationAttempts))
    : DEFAULT_MAX_VALIDATION_ATTEMPTS;
  let feedback: string | undefined;

  for (let attempt = 1; ; attempt++) {
    const attemptPrompt = feedback ? `${prompt}\n\n${feedback}` : prompt;
    try {
      return await generateObject<SCHEMA, 'object'>({ ...rest, prompt: attemptPrompt });
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      if (attempt >= attempts || !isRegenerable(error)) throw error;
      feedback = describeFailure(error);
    }
  }
}

function isRegenerable(error: NoObjectGeneratedError): boolean {
  return error.finishReason !== 'content-filter';
}

function describeFailure(error: NoObjectGeneratedError): string {
  if (JSONParseError.isInstance(error.cause)) {
    return 'Your previous answer was not valid JSON. Return a single complete JSON object that satisfies the schema exactly.';
  }
  const issues = validationIssues(error.cause);
  const detail =
    issues.length > 0
      ? issues.join('; ')
      : error.cause instanceof Error
        ? error.cause.message
        : error.message;
  return `Your previous answer failed validation: ${detail}. Return JSON that satisfies the schema exactly.`;
}

type ValidationIssue = { path?: (string | number)[]; message?: string };

function hasIssues(value: unknown): value is { issues: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { issues?: unknown }).issues)
  );
}

/** Walks the cause chain for a zod-style error and formats its issues as `path: message`. */
function validationIssues(cause: unknown): string[] {
  for (let current = cause, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (hasIssues(current)) {
      return current.issues
        .filter((issue): issue is ValidationIssue => typeof issue === 'object' && issue !== null)
        .map((issue) => {
          const path = issue.path?.join('.') ?? '';
          const message = issue.message ?? 'invalid';
          return path ? `${path}: ${message}` : message;
        });
    }
    current = current.cause;
  }
  return [];
}
