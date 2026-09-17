import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Episode, Lesson, MemoryStore, PinnedServer } from "../types.js";

/** Mint a prefixed, collision-free id for episodes/lessons. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** Lowercase word set used for cheap keyword overlap scoring. */
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9]+/)) if (w) out.add(w);
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * File-backed MemoryStore — the agent's only durable state between tasks.
 *
 * Kept deliberately dumb (three JSON arrays, in-memory cache, sync I/O behind an
 * async facade) so memory survives a crash without dragging in a DB dependency.
 * Writes go through a .tmp + rename so a half-written file can never corrupt the
 * store; reads are lazy + cached so retrieval on the hot path costs no syscalls.
 */
export class JsonMemoryStore implements MemoryStore {
  private readonly dir: string;
  private episodes?: Episode[];
  private lessons?: Lesson[];
  private pins?: PinnedServer[];

  constructor(dir: string) {
    // Resolve a leading "~/" ourselves — the shell never expands it for us here.
    this.dir = dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
  }

  async addEpisode(e: Episode): Promise<void> {
    const all = this.load("episodes", () => (this.episodes ??= []));
    all.push(e);
    this.persist("episodes.json", all);
  }

  async recentEpisodes(limit: number): Promise<Episode[]> {
    const all = this.load("episodes", () => (this.episodes ??= []));
    return [...all]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit));
  }

  async addLesson(l: Lesson): Promise<void> {
    const all = this.load("lessons", () => (this.lessons ??= []));
    all.push(l);
    this.persist("lessons.json", all);
  }

  async upsertLesson(l: Lesson): Promise<void> {
    const all = this.load("lessons", () => (this.lessons ??= []));
    const idx = all.findIndex((x) => x.topic === l.topic);
    if (idx >= 0) {
      // Replace in place: keep only the latest version of this topic.
      // Carry forward the existing `from` episode ids so provenance isn't lost.
      const existing = all[idx]!;
      all[idx] = {
        ...l,
        from: [...new Set([...existing.from, ...l.from])],
        weight: Math.max(existing.weight, l.weight) + 1,
      };
    } else {
      all.push(l);
    }
    this.persist("lessons.json", all);
  }

  /**
   * Half-life for lesson weight decay (days). After this many days, a lesson's
   * effective weight halves. A lesson reinforced regularly stays fresh; a lesson
   * from a one-off poisoned episode fades naturally. Set to 0 to disable decay.
   */
  private static readonly DECAY_HALF_LIFE_DAYS = 30;

  async recall(task: string, limit: number): Promise<Lesson[]> {
    const all = this.load("lessons", () => (this.lessons ??= []));
    const q = tokenize(task);
    if (q.size === 0) return [];
    const now = Date.now();
    const scored: Array<{ lesson: Lesson; score: number }> = [];
    for (const lesson of all) {
      const hay = tokenize(`${lesson.topic} ${lesson.text}`);
      const keywordScore = overlap(q, hay);
      if (keywordScore === 0) continue;
      // L5: Weight decay — older lessons fade unless regularly reinforced.
      // A lesson from a one-off poisoned episode loses influence over time.
      const ageDays = (now - new Date(lesson.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      const decay = JsonMemoryStore.DECAY_HALF_LIFE_DAYS > 0
        ? Math.exp(-ageDays * Math.LN2 / JsonMemoryStore.DECAY_HALF_LIFE_DAYS)
        : 1;
      const effectiveWeight = lesson.weight * decay;
      const score = keywordScore + Math.min(effectiveWeight, 10) * 0.1;
      scored.push({ lesson, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, limit)).map((s) => s.lesson);
  }

  async getPin(serverId: string): Promise<PinnedServer | undefined> {
    const all = this.load("pins", () => (this.pins ??= []));
    return all.find((p) => p.serverId === serverId);
  }

  async putPin(p: PinnedServer): Promise<void> {
    const all = this.load("pins", () => (this.pins ??= []));
    const i = all.findIndex((x) => x.serverId === p.serverId);
    if (i >= 0) all[i] = p;
    else all.push(p);
    this.persist("pins.json", all);
  }

  /** Lazily hydrate a cached array from disk on first access. */
  private load<T>(file: "episodes" | "lessons" | "pins", get: () => T[]): T[] {
    const cached = file === "episodes" ? this.episodes : file === "lessons" ? this.lessons : this.pins;
    if (cached) return cached as unknown as T[];
    const parsed = this.read<T>(`${file}.json`);
    if (file === "episodes") this.episodes = parsed as unknown as Episode[];
    else if (file === "lessons") this.lessons = parsed as unknown as Lesson[];
    else this.pins = parsed as unknown as PinnedServer[];
    return parsed.length ? parsed : get();
  }

  private read<T>(file: string): T[] {
    try {
      const raw = readFileSync(join(this.dir, file), "utf8");
      const json = JSON.parse(raw);
      return Array.isArray(json) ? (json as T[]) : [];
    } catch {
      // Missing/corrupt file → start from empty rather than crashing the agent.
      return [];
    }
  }

  /** Atomic-ish write: serialize to a sibling .tmp then rename over the target. */
  private persist(file: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const target = join(this.dir, file);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, target);
  }
}
