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

export function setOwnerSink(fn: Sink | null): void {
  sink = fn;
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
