/**
 * A message from a tool straight to the owner, around the model. For what the owner needs and the
 * model must not see: an eSIM's activation code and QR. The Telegram channel registers itself as the
 * sink when it starts; without one (CLI, HTTP) `notifyOwner` answers false and the tool says so.
 */
export interface OwnerNote {
  text: string;
  /** An image the owner should see, by URL (a QR code). */
  photoUrl?: string;
  /** Text the owner will copy: sent as its own message, monospace. */
  copyable?: string;
}

type Sink = (note: OwnerNote) => Promise<void>;
let sink: Sink | null = null;
/** Notes that waited for the channel: a startup report is written before Telegram is up. */
const pending: OwnerNote[] = [];
const MAX_PENDING = 5;

export function setOwnerSink(fn: Sink | null): void {
  sink = fn;
  retryOwnerNotes();
}

/**
 * Try the waiting notes again: when the channel registers, and when it gains an owner (a bot
 * nobody has claimed yet cannot deliver, and its notes wait for the first /start).
 */
export function retryOwnerNotes(): void {
  const fn = sink;
  if (!fn || !pending.length) return;
  const notes = pending.splice(0);
  void (async () => {
    for (const note of notes) {
      try { await fn(note); }
      catch { if (pending.length < MAX_PENDING) pending.push(note); }
    }
  })();
}

/**
 * For news that can wait for the owner's channel: delivered now when it is up, otherwise when
 * it registers. Never reaches anyone if no channel ever starts (CLI runs, HTTP-only hosts).
 * Not for anything a tool waits on; that is {@link notifyOwner}, which answers whether it went.
 */
export function notifyOwnerWhenReady(note: OwnerNote): void {
  if (pending.length < MAX_PENDING) pending.push(note);
  retryOwnerNotes();
}

export function hasOwnerSink(): boolean {
  return sink !== null;
}

/** True when the owner's channel took the note. */
export async function notifyOwner(note: OwnerNote): Promise<boolean> {
  if (!sink) return false;
  try {
    await sink(note);
    return true;
  } catch {
    return false;
  }
}
