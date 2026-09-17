import type { Episode, Lesson, Logger, MemoryStore } from "../types.js";
import { newId } from "./store.js";

/** Cap on brand-new lessons minted per distill call — the anti-bloat valve. */
const MAX_NEW_PER_CALL = 5;

/** Injection classifier: returns true when text is judged to be an injection attempt. */
export interface InjectionClassifier {
  isInjection(text: string): Promise<boolean>;
}

export interface LessonDistillerOptions {
  store: MemoryStore;
  log: Logger;
  /**
   * Optional LLM hook to author nicer lesson prose. Honestly optional: ARGUS
   * "self-learns" by accumulating retrievable lessons, not by touching weights,
   * so the heuristic text below must work with no model present.
   */
  summarize?: (prompt: string) => Promise<string>;
  /**
   * Optional adversarial classifier that judges whether a lesson text is a
   * prompt-injection payload. When set, every new lesson is screened before
   * storage. Recommended when a triage model is available.
   */
  classifier?: InjectionClassifier;
}

interface Group {
  topic: string;
  episodes: Episode[];
  tools: Set<string>;
  outcome: Episode["outcome"];
}

/**
 * Turns past mistakes into durable, retrievable advice — the continual-learning
 * layer. It is deliberately deterministic: failures are grouped by a derived
 * topic and condensed into one actionable takeaway each. The hard part isn't
 * writing lessons, it's NOT writing the same one forever, so distillation dedupes
 * against existing memory (bumping weight on a hit) and caps new lessons per run.
 *
 * PROMPT-INJECTION DEFENSE (L3): when a classifier is configured, every new lesson
 * text is screened by the triage model before storage. Lessons flagged as injection
 * attempts are dropped with a WARN-level audit log.
 */
export class LessonDistiller {
  private readonly store: MemoryStore;
  private readonly log: Logger;
  private readonly summarize?: (prompt: string) => Promise<string>;
  private readonly classifier?: InjectionClassifier;

  constructor(opts: LessonDistillerOptions) {
    this.store = opts.store;
    this.log = opts.log.child("distill");
    this.summarize = opts.summarize;
    this.classifier = opts.classifier;
  }

  async distill(episodes: Episode[]): Promise<Lesson[]> {
    // Only non-successes teach us anything — successes are the expected path.
    const learnable = episodes.filter((e) => e.outcome !== "success");
    if (learnable.length === 0) return [];

    const groups = this.group(learnable);
    const persisted: Lesson[] = [];
    let minted = 0;

    for (const g of groups) {
      // Dedupe by topic against existing memory before minting anything new.
      const existing = await this.store.recall(g.topic, 3);
      const match = existing.find((l) => l.topic === g.topic);
      if (match) {
        await this.reinforce({ ...match, from: mergeIds(match.from, g.episodes) });
        this.log.debug(`reinforced "${g.topic}" → weight ${match.weight + 1}`);
        continue;
      }
      if (minted >= MAX_NEW_PER_CALL) {
        this.log.debug(`cap reached (${MAX_NEW_PER_CALL}); deferring "${g.topic}"`);
        continue;
      }

      const text = await this.text(g);

      // L3: Adversarial classifier screen — before the lesson touches storage.
      if (this.classifier) {
        const isInjection = await this.classifier.isInjection(text).catch(() => true);
        if (isInjection) {
          this.log.warn(
            `prompt-injection defense L3: classifier REJECTED lesson "${g.topic}" ` +
            `(text: "${text.slice(0, 120)}") — possible memory-poisoning attempt`,
          );
          continue;
        }
      }

      const lesson: Lesson = {
        id: newId("lesson"),
        topic: g.topic,
        text,
        from: g.episodes.map((e) => e.id),
        weight: 1,
        createdAt: new Date().toISOString(),
      };
      await this.store.addLesson(lesson);
      persisted.push(lesson);
      minted += 1;
    }

    return persisted;
  }

  async reinforce(lesson: Lesson): Promise<void> {
    // Upsert by topic: replaces the existing entry in-place (bumping weight)
    // instead of appending a duplicate. Prevents unbounded growth of lessons.json
    // from repeated reinforcement calls across many tasks.
    await this.store.upsertLesson({ ...lesson, weight: lesson.weight + 1 });
  }

  /** Group failures by "<first tool>:<outcome>" so the same failure mode merges. */
  private group(episodes: Episode[]): Group[] {
    const by = new Map<string, Group>();
    for (const e of episodes) {
      const tool = e.toolsUsed[0] ?? normalizeTask(e.task);
      const topic = `${tool}:${e.outcome}`;
      const g = by.get(topic) ?? { topic, episodes: [], tools: new Set(), outcome: e.outcome };
      g.episodes.push(e);
      for (const t of e.toolsUsed) g.tools.add(t);
      by.set(topic, g);
    }
    return [...by.values()];
  }

  /** Author the takeaway — LLM if injected, otherwise a heuristic template. */
  private async text(g: Group): Promise<string> {
    const tool = g.topic.split(":")[0] ?? "the chosen tool";
    const heuristic =
      g.outcome === "failure"
        ? `When a task needs "${tool}", it tended to fail (${g.episodes.length}×) — confirm preconditions and prefer a safer alternative before relying on it.`
        : `When a task needs "${tool}", it only partly succeeded (${g.episodes.length}×) — verify the result and plan a fallback step.`;
    if (!this.summarize) return heuristic;
    try {
      const tasks = g.episodes.map((e) => `- ${e.task}: ${e.summary}`).join("\n");
      const out = await this.summarize(
        `Write one short, actionable takeaway (max 200 chars) for an autonomous agent, given these failed attempts using "${tool}":\n${tasks}`,
      );
      return out.trim() || heuristic;
    } catch (err) {
      this.log.warn(`summarizer failed, using heuristic: ${(err as Error).message}`);
      return heuristic;
    }
  }
}

function mergeIds(existing: string[], episodes: Episode[]): string[] {
  return [...new Set([...existing, ...episodes.map((e) => e.id)])];
}

/** Fallback topic when an episode recorded no tools: a few task keywords. */
function normalizeTask(task: string): string {
  return task.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 3).join("-") || "task";
}
