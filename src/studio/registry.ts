import type { StudioVerb } from "./types.js";
import { ablationVerbs } from "./verbs/ablation.js";
import { chronosVerbs } from "./verbs/chronos.js";
import { colonyVerbs } from "./verbs/colony.js";
import { fermatVerbs } from "./verbs/fermat.js";
import { landauerVerbs } from "./verbs/landauer.js";
import { latticeVerbs } from "./verbs/lattice.js";
import { lumenVerbs } from "./verbs/lumen.js";
import { murmurationVerbs } from "./verbs/murmuration.js";
import { percolaVerbs } from "./verbs/percola.js";
import { platonVerbs } from "./verbs/platon.js";
import { turingVerbs } from "./verbs/turing.js";

/**
 * The Studio verb registry. Keyed by human verb. Each entry knows its capability id,
 * how to build the capability input from friendly args, and how to summarize the
 * output. Pure data + pure functions: no I/O happens here.
 */
export const STUDIO_VERBS: Readonly<Record<string, StudioVerb>> = Object.freeze({
  ...platonVerbs,
  ...chronosVerbs,
  ...latticeVerbs,
  ...murmurationVerbs,
  ...colonyVerbs,
  ...turingVerbs,
  ...lumenVerbs,
  ...percolaVerbs,
  ...fermatVerbs,
  ...ablationVerbs,
  ...landauerVerbs,
});
