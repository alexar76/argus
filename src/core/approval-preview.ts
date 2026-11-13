/** These actions require an interactive decision on the exact arguments. */
export function requiresExactApproval(tool: string): boolean {
  return tool === "travel_book_approve" || tool === "cmc_buy_quotes" || tool === "laso_buy_card"
    || /^(?:tavily_buy_|chuhching_buy_|browserbase_)/.test(tool);
}

export function renderApprovalArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args).replace(/[\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export const MAX_EXACT_APPROVAL_LENGTH = 3000;
