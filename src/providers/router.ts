import type { LLMRequest, LLMResponse, Provider, Tier } from "../types.js";
import { type ArgusConfig, type ModelConfig, parseModelRef, providerKey } from "../config.js";
import type { Logger } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAICompatProvider } from "./openai.js";

/**
 * Routes a request to the right provider for a tier and resolves the concrete
 * model id. Tiering is the cheapest token-economy lever: triage/route on a cheap
 * (often local) model, escalate to the core model for real work, reserve the
 * heavy model for genuinely hard sub-tasks.
 */
export class ProviderRouter {
  private readonly providers = new Map<string, Provider>();

  constructor(private readonly cfg: ArgusConfig, private readonly log: Logger) {
    for (const p of cfg.providers) {
      try {
        if (p.kind === "anthropic") {
          const key = providerKey(p);
          if (!key) {
            log.debug(`provider ${p.id} skipped (no ${p.apiKeyEnv})`);
            continue;
          }
          this.providers.set(p.id, new AnthropicProvider({ id: p.id, apiKey: key }));
        } else {
          // openai-compatible + local
          if (!p.baseUrl) {
            log.warn(`provider ${p.id} skipped (no baseUrl)`);
            continue;
          }
          const key = providerKey(p);
          // Remote openai providers need a key; local (Ollama/vLLM) does not.
          if (p.kind !== "local" && p.apiKeyEnv && !key) {
            log.debug(`provider ${p.id} skipped (no ${p.apiKeyEnv})`);
            continue;
          }
          this.providers.set(p.id, new OpenAICompatProvider({ id: p.id, kind: p.kind, baseUrl: p.baseUrl, apiKey: key }));
        }
      } catch (err) {
        log.warn(`provider ${p.id} failed to init: ${(err as Error).message}`);
      }
    }
    log.debug(`providers ready: ${[...this.providers.keys()].join(", ") || "(none)"}`);
  }

  /** True if at least one provider initialised. */
  get available(): boolean {
    return this.providers.size > 0;
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Resolve a tier to an available provider, keeping provider+model paired.
   * Falls back across tiers (e.g. core→triage→heavy) so a missing key for one
   * tier degrades to another usable model rather than failing — but never pairs
   * a provider with a model id from a different provider.
   */
  resolveTier(tier: Tier): { model: ModelConfig; provider: Provider; modelId: string } {
    const order: Tier[] =
      tier === "heavy" ? ["heavy", "core", "triage"] : tier === "triage" ? ["triage", "core", "heavy"] : ["core", "triage", "heavy"];
    for (const t of order) {
      const mc = this.cfg.models[t];
      if (!mc) continue;
      const { provider, model } = parseModelRef(mc.ref);
      const prov = this.providers.get(provider);
      if (prov) return { model: mc, provider: prov, modelId: model };
    }
    throw new Error("No usable LLM provider for any tier. Set an API key or run a local model (Ollama). See `argus doctor`.");
  }

  async chat(tier: Tier, req: Omit<LLMRequest, "model">): Promise<LLMResponse> {
    const { provider, modelId, model } = this.resolveTier(tier);
    return provider.chat({ ...req, model: modelId, maxTokens: req.maxTokens ?? model.maxTokens });
  }
}
