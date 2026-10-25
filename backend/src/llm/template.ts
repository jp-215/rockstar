import type { LLMProvider, LLMRequest } from './provider.ts';

/** Deterministic fallback: every request carries its own template. */
export class TemplateProvider implements LLMProvider {
  readonly name = 'template' as const;
  async complete<T>(req: LLMRequest<T>): Promise<T> { return req.schema.parse(req.template()); }
}
