import { execFile } from 'node:child_process';
import type { Bus } from '../bus.ts';

/**
 * Customer-facing channels driven by AppleScript on macOS: system notifications and iMessage.
 * iMessage is dry-run unless COMMS_IMESSAGE=1 (it would send real texts from this Mac).
 */
export interface CommsChannel {
  readonly kind: 'mock' | 'applescript';
  notify(title: string, text: string): Promise<boolean>;
  imessage(to: string, text: string): Promise<{ ok: boolean; dryRun: boolean }>;
}

const osa = (script: string) => new Promise<boolean>((resolve) => execFile('osascript', ['-e', script], { timeout: 8000 }, (err) => resolve(!err)));
const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export class AppleScriptComms implements CommsChannel {
  readonly kind = 'applescript' as const;
  private imessageLive = process.env.COMMS_IMESSAGE === '1';
  async notify(title: string, text: string) {
    return osa(`display notification "${q(text.slice(0, 200))}" with title "${q(title.slice(0, 60))}"`);
  }
  async imessage(to: string, text: string) {
    if (!this.imessageLive) return { ok: true, dryRun: true };
    const ok = await osa(`tell application "Messages"\n set s to 1st account whose service type = iMessage\n send "${q(text)}" to participant "${q(to)}" of s\nend tell`);
    return { ok, dryRun: false };
  }
}

export class CommsMock implements CommsChannel {
  readonly kind = 'mock' as const;
  async notify() { return true; }
  async imessage() { return { ok: true, dryRun: true }; }
}

export function makeComms(_bus: Bus): CommsChannel {
  const enabled = process.platform === 'darwin' && process.env.COMMS_APPLESCRIPT !== '0';
  return enabled ? new AppleScriptComms() : new CommsMock();
}
