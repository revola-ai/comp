import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { NoObjectGeneratedError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_GOOGLE_MODEL_IDS, generateObjectStrict, googleModel } from './google-models';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

type GeminiReply = { text: string; finishReason?: string } | { status: number };

/** Builds a fetch stub that answers the Gemini generateContent endpoint in order. */
function geminiFetch(replies: GeminiReply[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, body });
    const reply = replies[calls.length - 1] ?? replies[replies.length - 1];
    if ('status' in reply) {
      return new Response(JSON.stringify({ error: { message: 'boom' } }), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: reply.text }], role: 'model' },
            finishReason: reply.finishReason ?? 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function promptTextOf(body: Record<string, unknown>): string {
  return JSON.stringify(body.contents);
}

const fiveSentences = z.object({
  sentences: z.array(z.string().min(8).max(200)).length(5),
});

const four = JSON.stringify({
  sentences: ['one sentence', 'two sentence', 'three sentence', 'four sentence'],
});
const five = JSON.stringify({
  sentences: ['one sentence', 'two sentence', 'three sentence', 'four sentence', 'five sentence'],
});

describe('googleModel', () => {
  beforeEach(() => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
  });
  afterEach(restoreEnv);

  it('uses the default model id for each role', () => {
    expect(googleModel('onboarding').modelId).toBe(DEFAULT_GOOGLE_MODEL_IDS.onboarding);
    expect(googleModel('policyUpdate').modelId).toBe(DEFAULT_GOOGLE_MODEL_IDS.policyUpdate);
    expect(googleModel('rerank').modelId).toBe(DEFAULT_GOOGLE_MODEL_IDS.rerank);
  });

  it('lets an env override replace the default per role', () => {
    process.env.AI_MODEL_ONBOARDING = 'gemini-custom-a';
    process.env.AI_MODEL_POLICY_UPDATE = 'gemini-custom-b';
    process.env.AI_MODEL_RERANK = 'gemini-custom-c';
    expect(googleModel('onboarding').modelId).toBe('gemini-custom-a');
    expect(googleModel('policyUpdate').modelId).toBe('gemini-custom-b');
    expect(googleModel('rerank').modelId).toBe('gemini-custom-c');
  });

  it('ignores blank overrides', () => {
    process.env.AI_MODEL_RERANK = '   ';
    expect(googleModel('rerank').modelId).toBe(DEFAULT_GOOGLE_MODEL_IDS.rerank);
  });

  it('is backed by the Google Generative AI provider', () => {
    expect(googleModel('onboarding').provider).toBe('google.generative-ai');
  });
});

describe('generateObjectStrict', () => {
  afterEach(restoreEnv);

  it('sends the request to Gemini with the chosen model and a response schema', async () => {
    const { fetchImpl, calls } = geminiFetch([{ text: five }]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    const result = await generateObjectStrict({
      model: provider('gemini-3.5-flash'),
      schema: fiveSentences,
      system: 'You write sentences.',
      prompt: 'Write five sentences.',
    });

    expect(result.object.sentences).toHaveLength(5);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('generativelanguage.googleapis.com');
    expect(calls[0].url).toContain('models/gemini-3.5-flash:generateContent');
    const generationConfig = calls[0].body.generationConfig as Record<string, unknown>;
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect(generationConfig.responseSchema).toBeDefined();
  });

  it('retries a schema validation failure with the concrete zod issue in the prompt', async () => {
    const { fetchImpl, calls } = geminiFetch([{ text: four }, { text: five }]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    const result = await generateObjectStrict({
      model: provider('gemini-3.5-flash'),
      schema: fiveSentences,
      prompt: 'Write five sentences.',
    });

    expect(result.object.sentences).toHaveLength(5);
    expect(calls).toHaveLength(2);
    expect(promptTextOf(calls[0].body)).not.toContain('failed validation');
    const retryPrompt = promptTextOf(calls[1].body);
    expect(retryPrompt).toContain('Write five sentences.');
    expect(retryPrompt).toContain('failed validation');
    expect(retryPrompt).toContain('sentences');
    expect(retryPrompt).toMatch(/5 items/);
  });

  it('retries malformed JSON with parse-specific feedback', async () => {
    const { fetchImpl, calls } = geminiFetch([{ text: '{"sentences": [' }, { text: five }]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    const result = await generateObjectStrict({
      model: provider('gemini-3.5-flash'),
      schema: fiveSentences,
      prompt: 'Write five sentences.',
    });

    expect(result.object.sentences).toHaveLength(5);
    expect(calls).toHaveLength(2);
    expect(promptTextOf(calls[1].body)).toContain('not valid JSON');
  });

  it('gives up after three attempts and rethrows the last NoObjectGeneratedError', async () => {
    const { fetchImpl, calls } = geminiFetch([
      { text: four },
      { text: four },
      { text: four },
      { text: five },
    ]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    await expect(
      generateObjectStrict({
        model: provider('gemini-3.5-flash'),
        schema: fiveSentences,
        prompt: 'Write five sentences.',
      }),
    ).rejects.toSatisfy((error: unknown) => NoObjectGeneratedError.isInstance(error));
    expect(calls).toHaveLength(3);
  });

  it('honours a custom attempt limit', async () => {
    const { fetchImpl, calls } = geminiFetch([{ text: four }, { text: five }]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    await expect(
      generateObjectStrict({
        model: provider('gemini-3.5-flash'),
        schema: fiveSentences,
        prompt: 'Write five sentences.',
        maxValidationAttempts: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => NoObjectGeneratedError.isInstance(error));
    expect(calls).toHaveLength(1);
  });

  it('falls back to the default attempt limit for a non-finite one', async () => {
    const { fetchImpl, calls } = geminiFetch([{ text: four }]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    await expect(
      generateObjectStrict({
        model: provider('gemini-3.5-flash'),
        schema: fiveSentences,
        prompt: 'Write five sentences.',
        maxValidationAttempts: Number.NaN,
      }),
    ).rejects.toSatisfy((error: unknown) => NoObjectGeneratedError.isInstance(error));
    expect(calls).toHaveLength(3);
  });

  it('does not retry when the model stopped for a content filter', async () => {
    const { fetchImpl, calls } = geminiFetch([
      { text: '', finishReason: 'SAFETY' },
      { text: five },
    ]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    await expect(
      generateObjectStrict({
        model: provider('gemini-3.5-flash'),
        schema: fiveSentences,
        prompt: 'Write five sentences.',
      }),
    ).rejects.toSatisfy((error: unknown) => NoObjectGeneratedError.isInstance(error));
    expect(calls).toHaveLength(1);
  });

  it('propagates non-object errors without its own retry', async () => {
    const { fetchImpl, calls } = geminiFetch([{ status: 500 }]);
    const provider = createGoogleGenerativeAI({ apiKey: 'test-key', fetch: fetchImpl });

    await expect(
      generateObjectStrict({
        model: provider('gemini-3.5-flash'),
        schema: fiveSentences,
        prompt: 'Write five sentences.',
        maxRetries: 0,
      }),
    ).rejects.toSatisfy((error: unknown) => !NoObjectGeneratedError.isInstance(error));
    expect(calls).toHaveLength(1);
  });
});
