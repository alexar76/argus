import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { chromium } from "playwright-core";

const endpoint = (await readFile("/run/checkout/browser-ws", "utf8")).trim();
const url = new URL(endpoint);
if (!/^ws:\/\/argus-(?:checkout|hudson)-browser:47871\/[A-Za-z0-9_-]{32,128}$/.test(endpoint)) {
  throw new Error("Invalid private browser endpoint");
}

const expected = Buffer.from(url.pathname);
const headed = process.env.ARGUS_CHECKOUT_HEADED === "1";
const display = process.env.DISPLAY;
const authority = process.env.XAUTHORITY;
if (headed && (!display || !/^:\d+$/.test(display) || !authority || !authority.startsWith("/tmp/"))) {
  throw new Error("Headed checkout requires an isolated Xvfb display");
}
const browserServer = await chromium.launchServer({
  host: "127.0.0.1",
  port: 0,
  headless: !headed,
  channel: "chromium",
  chromiumSandbox: true,
  wsPath: url.pathname,
  args: [
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ],
  env: { HOME: "/tmp", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: "/tmp",
    ...(headed ? { DISPLAY: display, XAUTHORITY: authority } : {}) },
});
const upstreamPort = Number(new URL(browserServer.wsEndpoint()).port);

const proxy = createServer((_request, response) => response.writeHead(404).end());
proxy.on("upgrade", (request, client, head) => {
  const candidate = Buffer.from(request.url ?? "");
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)
      || request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket") {
    client.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const headers = request.rawHeaders;
  const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  upstream.on("close", () => client.destroy());
  upstream.once("connect", () => {
    const forwarded = [`GET ${url.pathname} HTTP/1.1`, `Host: 127.0.0.1:${upstreamPort}`];
    for (let index = 0; index < headers.length; index += 2) {
      if (headers[index].toLowerCase() !== "host") forwarded.push(`${headers[index]}: ${headers[index + 1]}`);
    }
    upstream.write(`${forwarded.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  });
});

const stop = () => {
  proxy.close();
  void browserServer.close();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
browserServer.once("close", () => process.exit(0));
proxy.listen(47871, "0.0.0.0", () => console.log("Checkout browser listening"));
