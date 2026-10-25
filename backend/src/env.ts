import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads KEY=VALUE pairs from .env files into process.env without overriding values already set.
 * Tolerates spaces around '=', quotes, comments and missing trailing newline. Checked in order:
 * repo root .env, then frontend/.env (where keys may have been dropped by mistake; Vite never
 * exposes them to the browser because they lack the VITE_ prefix).
 */
export function loadEnv(): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const loaded: string[] = [];
  for (const file of [resolve(root, '.env'), resolve(root, 'backend/.env'), resolve(root, 'frontend/.env')]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const key = line.slice(0, i).trim();
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(key in process.env) && val !== '') { process.env[key] = val; loaded.push(key); }
    }
  }
  return loaded;
}
