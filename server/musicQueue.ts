import { randomBytes } from 'crypto';
import { parseWatchUrl } from '../shared/watch';
import { QUEUE_MAX, QUEUE_PER_USER, type QueueItem } from '../shared/musicQueue';

type Res<T = object> = ({ ok: true } & T) | { ok: false; error: string; status?: number };
/** One room's queue (memory only, like the watch party itself). `current` is the item the queue last put on the player. */
export class MusicQueue {
  items: (QueueItem & { key: string })[] = [];
  current: (QueueItem & { key: string }) | null = null;
  add(raw: unknown, by: string, key: string): Res<{ item: QueueItem }> {
    const p = parseWatchUrl(raw);
    if (!p || p.provider !== 'youtube' || p.kind !== 'video') return { ok: false, error: 'Paste a YouTube video link' };
    if (this.items.length >= QUEUE_MAX) return { ok: false, error: `The queue is full (${QUEUE_MAX})`, status: 409 };
    if (this.items.filter((i) => i.key === key).length >= QUEUE_PER_USER) return { ok: false, error: `You can have ${QUEUE_PER_USER} songs waiting at a time`, status: 409 };
    if (this.items.some((i) => i.videoId === p.id)) return { ok: false, error: 'That video is already in the queue', status: 409 };
    const item = { id: randomBytes(6).toString('hex'), videoId: p.id, url: p.url, by, addedAt: Date.now(), key };
    this.items.push(item);
    return { ok: true, item: strip(item) };
  }
  remove(id: unknown, key: string, canControl: boolean): Res {
    const i = this.items.findIndex((x) => x.id === id);
    if (i < 0) return { ok: false, error: 'Not in the queue' };
    if (!canControl && this.items[i].key !== key) return { ok: false, error: 'Only the room owner or a role with music control can remove other people\'s songs', status: 403 };
    this.items.splice(i, 1);
    return { ok: true };
  }
  /** Take the next item (or null when empty). */
  next(): (QueueItem & { key: string }) | null { this.current = this.items.shift() ?? null; return this.current; }
  state(): { items: QueueItem[]; current: QueueItem | null } { return { items: this.items.map(strip), current: this.current ? strip(this.current) : null }; }
}
const strip = ({ key: _k, ...rest }: QueueItem & { key: string }): QueueItem => rest;
