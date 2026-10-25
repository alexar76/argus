/** Authenticated requests and their private bodies belong only to the chosen
 * endpoint. Native fetch forwards custom API/proof headers on cross-origin
 * redirects; 307/308 also forward POST bodies. Never follow such responses.
 */
export function fetchNoRedirect(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  transport: typeof fetch = globalThis.fetch,
): Promise<Response> {
  return transport(input, { ...init, redirect: "error" });
}
