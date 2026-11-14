# Chromium for ARGUS checkout

The browser runs separately from the Telegram bot. The containers share the `argus_checkout` Docker bridge and one private WebSocket endpoint file. The browser has no host port. Its renderer routes through a closed local proxy, while Playwright serves the explicit HTTPS requests permitted by the checkout adapter.

Stage the bundle with `bash prepare.sh /root/argus-checkout-browser` on the Docker host. The script checks the Playwright package against the ARGUS lockfile's hash and builds the sidecar's seccomp profile from a pinned Moby source. The profile permits Chromium to create its renderer namespaces and chroot inside them. The sidecar starts as UID 1000 with a read-only root filesystem and all Docker capabilities dropped.

```sh
cd /root/argus-checkout-browser
docker pull mcr.microsoft.com/playwright:v1.64.1-noble@sha256:2f05f8a734509a7b3f26a912639488ee08f58a7b292d14d62271bcff9038768f
docker build --pull=false --network none -t argus-checkout-browser:playwright-1.64.1 .
bash launch.sh canary
bash launch.sh start
docker exec argus-checkout-browser node /app/smoke.mjs
```

One-off guest checkout on Hudson Link can require Chromium's windowed mode. Run the canary and start the service with `ARGUS_CHECKOUT_HEADED=1` to use an isolated Xvfb display. The display has no TCP listener. The Chromium sandbox and checkout request allowlist still apply.

The canary uses a networkless container. It checks Chromium's PID and network namespaces and renderer seccomp, rejects an incorrect WebSocket path, and renders a synthetic page through Playwright interception. For a read-only merchant check, feed `public-preflight.mjs` to `docker exec -i -w /app argus-checkout-browser node --input-type=module -`. That check uses GET and sends no customer details.

Attach the owner-pinned ARGUS service to the external `argus_checkout` network in addition to its existing networks. Mount `/root/argus-checkout-browser/private/browser-ws` at `/run/checkout/browser-ws` read-only and set `ARGUS_ITCH_BROWSER_WS_FILE=/run/checkout/browser-ws`. The endpoint file is owned by UID 1000 and has mode `0600`. Keep the Laso session and receipt configuration in the ARGUS service.

Install the scoped profile at `/etc/apparmor.d/argus-checkout-browser` for reload at boot. To remove the browser, stop it with `docker compose down` from its directory and detach ARGUS from `argus_checkout`. Remove the network when it has no members and unload the scoped profile with `apparmor_parser -R apparmor.profile` after removing the installed copy.
