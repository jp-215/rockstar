/** Checks that the configured API keys work with tiny calls. Run: npx tsx backend/test/smoke-apis.ts */
import { loadEnv } from '../src/env.ts';
import Anthropic from '@anthropic-ai/sdk';
console.log('env loaded from files:', loadEnv().join(', ') || '(none)');
if (process.env.ANTHROPIC_API_KEY) {
  const c = new Anthropic();
  const r = await c.messages.create({ model: 'claude-opus-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] });
  console.log('claude:', r.content.find((b) => b.type === 'text')?.text, `| ${r.usage.input_tokens} in / ${r.usage.output_tokens} out`);
} else console.log('claude: no ANTHROPIC_API_KEY');
if (process.env.FLUX_API_KEY) {
  const base = process.env.FLUX_API_BASE ?? 'https://api.bfl.ai', model = process.env.FLUX_MODEL ?? 'flux-dev';
  const s = await fetch(`${base}/v1/${model}`, { method: 'POST', headers: { 'x-key': process.env.FLUX_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'warm café counter with croissants, soft morning light, no text', width: 832, height: 1440, output_format: 'jpeg' }) });
  const body = await s.text();
  console.log(`bfl ${model}: HTTP ${s.status}`, body.slice(0, 160));
} else console.log('bfl: no FLUX_API_KEY');
