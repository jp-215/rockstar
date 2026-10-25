import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LLMProvider, LLMRequest } from './provider.ts';

export const CLAUDE_MODEL = 'claude-opus-5-5';

/** Claude via the Anthropic SDK with structured (schema-validated) output. */
export class ClaudeProvider implements LLMProvider {
  readonly name = 'claude' as const;
  private client = new Anthropic({ timeout: 45_000, maxRetries: 1 });

  async complete<T>(req: LLMRequest<T>): Promise<T> {
    const res = await this.client.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: zodOutputFormat(req.schema as never), effort: 'low' },
    });
    if (res.stop_reason === 'refusal') throw new Error(`claude refused: ${res.stop_details?.explanation ?? 'no detail'}`);
    if (res.parsed_output == null) throw new Error('claude returned no parsable output');
    return req.schema.parse(res.parsed_output);
  }
}

export const isConnectionError = (e: unknown) => e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.APIConnectionTimeoutError;
