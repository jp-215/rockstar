export type AttentionEvent =
  | { type: 'gaze_start'; t: number; pedId: number; x: number; lane: number }
  | { type: 'gaze_end'; t: number; pedId: number; dwellMs: number }
  | { type: 'stop_and_look'; t: number; pedId: number; x: number }
  | { type: 'zone_exit'; t: number; pedId: number; looked: boolean; totalDwellMs: number; lane: number }
  | { type: 'entered'; t: number; pedId: number; totalDwellMs: number }
  | { type: 'purchased'; t: number; pedId: number }
  | { type: 'left_store'; t: number; pedId: number; insideSec: number; purchased: boolean };

export type EventType = AttentionEvent['type'];
type Handler = (e: AttentionEvent) => void;

export class EventBus {
  private handlers = new Set<Handler>();
  on(h: Handler): () => void { this.handlers.add(h); return () => this.handlers.delete(h); }
  emit(e: AttentionEvent): void { for (const h of this.handlers) h(e); }
}
