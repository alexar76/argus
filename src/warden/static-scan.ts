import type {
  Severity,
  ToolDef,
  WardenFinding,
  WardenGate,
  WardenGateInput,
  WardenGateResult,
} from "../types.js";

/**
 * Static tool-definition scanner.
 *
 * The MCP tool *description* and *input schema* are attacker-controlled text the
 * model reads as trusted instructions — this is the tool-poisoning / prompt-
 * injection surface. We scan that text (never the live tool output) for known
 * signatures before a single token of it reaches the model. Cheap, deterministic,
 * and runs first so later gates can reason about its findings. Not fatal on its
 * own: a single "you must" shouldn't sever a connection, but it tanks the score.
 */

interface SignaturePattern {
  re: RegExp;
  code: string;
  severity: Severity;
}

// Imperative instructions aimed at the model — the classic injection tells.
const INJECTION_PATTERNS: SignaturePattern[] = [
  { re: /\bignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|preceding)\b/i, code: "TOOL_DEF_INJECTION", severity: "critical" },
  { re: /\bdisregard\s+(?:all\s+|the\s+|any\s+)?(?:previous|prior|above|instructions?|rules?)\b/i, code: "TOOL_DEF_INJECTION", severity: "critical" },
  { re: /\b(?:system\s+prompt|developer\s+(?:message|prompt))\b/i, code: "TOOL_DEF_INJECTION", severity: "high" },
  { re: /\bdo\s+not\s+(?:tell|inform|mention|reveal\s+to|notify)\s+(?:the\s+)?user\b/i, code: "TOOL_DEF_INJECTION", severity: "critical" },
  { re: /\bwithout\s+(?:telling|informing|asking)\s+(?:the\s+)?user\b/i, code: "TOOL_DEF_INJECTION", severity: "high" },
  { re: /\byou\s+must\b/i, code: "TOOL_DEF_INJECTION", severity: "medium" },
  { re: /\binstead\s+of\b/i, code: "TOOL_DEF_INJECTION", severity: "low" },
  { re: /<\s*\/?\s*(?:system|instructions?|important)\s*>/i, code: "TOOL_DEF_INJECTION", severity: "high" },
];

// Data-exfiltration phrasing.
const EXFIL_PATTERNS: SignaturePattern[] = [
  { re: /\bexfiltrat\w*/i, code: "TOOL_DEF_EXFIL", severity: "critical" },
  { re: /\b(?:send|post|forward|relay)\s+(?:it|them|this|the\s+\w+|all|results?|output|data|contents?)\s+to\b/i, code: "TOOL_DEF_EXFIL", severity: "high" },
  { re: /\b(?:post|send|put)\s+to\s+https?:\/\//i, code: "TOOL_DEF_EXFIL", severity: "critical" },
  { re: /\bupload\b[\s\S]{0,40}\bto\s+(?:https?:\/\/|[\w.-]+\.[a-z]{2,})/i, code: "TOOL_DEF_EXFIL", severity: "high" },
];

// Requests for secrets / credentials in description text or schema field names.
const SECRET_PATTERNS: SignaturePattern[] = [
  { re: /\bapi[_\s-]?key\b/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "high" },
  { re: /\bprivate[_\s-]?key\b/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "critical" },
  { re: /\bsecret(?:s)?\b/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "medium" },
  { re: /\bseed[_\s-]?phrase\b|\bmnemonic\b/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "critical" },
  { re: /\bpassword\b|\bpasswd\b/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "high" },
  { re: /(?:^|[^.\w])\.env\b|\benvironment\s+variables?\b/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "medium" },
  { re: /~\/\.ssh|\bid_rsa\b|\.ssh\/[\w.-]+/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "critical" },
  { re: /\bcredentials?\b|\baccess[_\s-]?token\b|\bbearer\s+token\b/i, code: "TOOL_DEF_SECRET_REQUEST", severity: "high" },
];

// Dangerous URL schemes embedded in text.
const URL_SCHEME_PATTERNS: SignaturePattern[] = [
  { re: /\bdata:[\w/+.-]+;base64,/i, code: "TOOL_DEF_DATA_URL", severity: "high" },
  { re: /\bjavascript:/i, code: "TOOL_DEF_DATA_URL", severity: "high" },
];

// Long base64-ish runs — hidden payloads / encoded instructions.
// Covers standard (RFC 4648 §4) AND URL-safe (RFC 4648 §5) base64,
// with or without padding. URL-safe uses `-` and `_` instead of `+` and `/`;
// JWTs and web payloads commonly omit padding entirely.
const BASE64_BLOB = /[A-Za-z0-9+/_-]{120,}={0,2}/;

// Zero-width / bidi / BOM characters used to hide text from human review.
// U+200B–200F, U+202A–202E, U+2060, U+FEFF. Built from a \u-escaped string so the
// source stays reviewable (the characters are, by definition, invisible).
const HIDDEN_UNICODE = new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF]");

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Penalty applied to the gate score per worst-severity found (critical → 0). */
const SEVERITY_PENALTY: Record<Severity, number> = {
  info: 0,
  low: 0.1,
  medium: 0.3,
  high: 0.6,
  critical: 1,
};

export class StaticScanGate implements WardenGate {
  readonly name = "static-scan";

  async evaluate(input: WardenGateInput): Promise<WardenGateResult> {
    const findings: WardenFinding[] = [];

    for (const tool of input.tools) {
      const schemaText = safeStringifySchema(tool.inputSchema);
      // Description is prose; schema text is field names + descriptions + enums.
      const haystacks: Array<{ text: string; where: string }> = [
        { text: tool.description ?? "", where: "description" },
        { text: schemaText, where: "input schema" },
      ];

      for (const { text, where } of haystacks) {
        for (const group of [INJECTION_PATTERNS, EXFIL_PATTERNS, SECRET_PATTERNS, URL_SCHEME_PATTERNS]) {
          for (const sig of group) {
            if (sig.re.test(text)) {
              findings.push({
                gate: this.name,
                severity: sig.severity,
                code: sig.code,
                message: `Tool "${tool.name}" ${where} matches ${sig.code} signature (${describe(sig.re)}).`,
                tool: tool.name,
              });
            }
          }
        }

        if (BASE64_BLOB.test(text)) {
          findings.push({
            gate: this.name,
            severity: "high",
            code: "TOOL_DEF_BASE64_BLOB",
            message: `Tool "${tool.name}" ${where} contains a long base64-encoded blob — possible hidden payload.`,
            tool: tool.name,
          });
        }

        if (HIDDEN_UNICODE.test(text)) {
          findings.push({
            gate: this.name,
            severity: "high",
            code: "TOOL_DEF_HIDDEN_UNICODE",
            message: `Tool "${tool.name}" ${where} contains zero-width or bidi control characters hiding text from review.`,
            tool: tool.name,
          });
        }
      }
    }

    return { findings, score: scoreFor(findings) };
  }
}

/** 1 minus the penalty for the worst severity found; clamped to [0,1]. */
function scoreFor(findings: WardenFinding[]): number {
  let worst: Severity = "info";
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  const score = 1 - SEVERITY_PENALTY[worst];
  return Math.max(0, Math.min(1, score));
}

/** Deterministic, total stringify of a JSON schema for scanning. */
function safeStringifySchema(schema: unknown): string {
  try {
    return JSON.stringify(schema) ?? "";
  } catch {
    return String(schema ?? "");
  }
}

/** Short human label for a signature regex, for the finding message. */
function describe(re: RegExp): string {
  return re.source.length > 48 ? `${re.source.slice(0, 45)}…` : re.source;
}
