import type { ZodType } from 'zod';
import type { AgentName, Provider } from '../../../shared/mesh-types.ts';

/** One structured LLM call. Every request carries a deterministic template so the mesh never stalls. */
export interface LLMRequest<T> {
  agent: AgentName;
  task: string;               // short label for tracing
  system: string;
  user: string;
  schema: ZodType<T>;
  example: T;                 // shown to small local models as the exact shape to produce
  template: () => T;          // deterministic fallback
  maxTokens?: number;
}

export interface LLMProvider {
  readonly name: Provider;
  complete<T>(req: LLMRequest<T>): Promise<T>;
}
