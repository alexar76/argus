import { expect, it, vi } from "vitest";
import { authorizeMicrosoftMail } from "../src/cli/commands/mail-microsoft-oauth.js";

const clientId = "afb2b823-5e84-4b15-b173-c502eb0624be";
const fixture = {
  device_code: "fixture-device-secret",
  user_code: "OWNER-CODE",
  verification_uri: "https://www.microsoft.com/link",
  interval: 5,
  expires_in: 900,
};

it("shows only the user code and exchanges at Microsoft after the prescribed polling intervals", async () => {
  const responses = [
    Response.json(fixture),
    Response.json({ error: "authorization_pending" }, { status: 400 }),
    Response.json({ error: "slow_down" }, { status: 400 }),
    Response.json({ refresh_token: "fixture-refresh" }),
  ];
  const request = vi.fn(async (_url: string, _init: RequestInit) => responses.shift()!);
  const wait = vi.fn(async () => {});
  const showCode = vi.fn();
  await expect(authorizeMicrosoftMail({ clientId, request, wait, showCode, signal: AbortSignal.timeout(2000) }))
    .resolves.toBe("fixture-refresh");
  expect(showCode).toHaveBeenCalledExactlyOnceWith(fixture.verification_uri, fixture.user_code);
  expect(wait.mock.calls.map(call => call[0])).toEqual([5000, 5000, 10000]);
  const [device, ...polls] = request.mock.calls;
  const initial = new URLSearchParams(device![1].body as URLSearchParams);
  expect(device![0]).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode");
  expect(initial.get("client_id")).toBe(clientId);
  expect(initial.get("scope")?.split(" ").sort()).toEqual([
    "https://graph.microsoft.com/Mail.Read", "https://graph.microsoft.com/Mail.Send", "https://graph.microsoft.com/User.Read", "offline_access",
  ]);
  for (const [url, init] of polls) {
    expect(url).toBe("https://login.microsoftonline.com/consumers/oauth2/v2.0/token");
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      client_id: clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: fixture.device_code,
    });
  }
});

it("does not print a sign-in code or poll when the response supplies an untrusted verification page", async () => {
  const request = vi.fn(async () => Response.json({ ...fixture, verification_uri: "https://www.microsoft.com.example.net/link" }));
  const showCode = vi.fn();
  await expect(authorizeMicrosoftMail({ clientId, request, showCode, signal: AbortSignal.timeout(2000) }))
    .rejects.toThrow("unexpected sign-in page");
  expect(request).toHaveBeenCalledOnce();
  expect(showCode).not.toHaveBeenCalled();
});

it("requests only profile, read and offline access for an incoming-only Microsoft mailbox", async () => {
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fixture))
    .mockResolvedValueOnce(Response.json({ refresh_token: "fixture-refresh" }));
  await expect(authorizeMicrosoftMail({
    clientId, incomingOnly: true, request, showCode: vi.fn(), wait: async () => {}, signal: AbortSignal.timeout(2000),
  })).resolves.toBe("fixture-refresh");
  const params = new URLSearchParams(request.mock.calls[0]?.[1]?.body as URLSearchParams);
  expect(params.get("scope")?.split(" ")).toEqual([
    "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Read", "offline_access",
  ]);
});
