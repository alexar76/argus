#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
runtime_image=argus-checkout-browser:playwright-1.64.1
canary=argus-checkout-browser-canary
secret="$(pwd)/private/browser-ws"
mode=${1:-canary}

install -d -m 0700 private
if [[ ! -e "$secret" ]]; then
  (
    umask 077
    token=$(openssl rand -hex 32)
    printf 'ws://argus-checkout-browser:47871/%s\n' "$token" > "$secret"
    chown 1000:1000 "$secret"
  )
fi
test ! -L "$secret"
test "$(stat -c '%u:%g:%a' "$secret")" = '1000:1000:600'

apparmor_parser --skip-kernel-load --skip-cache apparmor.profile
apparmor_parser -r -W apparmor.profile

case "$mode" in
  canary)
    docker run -d --name "$canary" --network none --init \
      --user 1000:1000 --cap-drop ALL --read-only --pids-limit 256 --memory 768m \
      --shm-size 128m --tmpfs /tmp:rw,nosuid,nodev,size=128m,mode=1777 \
      --security-opt no-new-privileges:true --security-opt apparmor=argus-checkout-browser \
      --security-opt "seccomp=$(pwd)/seccomp.json" \
      --env "ARGUS_CHECKOUT_HEADED=${ARGUS_CHECKOUT_HEADED:-0}" \
      --mount "type=bind,src=$secret,dst=/run/checkout/browser-ws,readonly" "$runtime_image" >/dev/null
    trap 'docker rm -f "$canary" >/dev/null' EXIT
    for _ in {1..20}; do
      if docker logs "$canary" 2>&1 | grep -q 'Checkout browser listening'; then
        docker exec -e CHECKOUT_SMOKE_HOST=127.0.0.1 "$canary" node /app/smoke.mjs
        exit 0
      fi
      [[ $(docker inspect -f '{{.State.Running}}' "$canary") = true ]] || break
      sleep 1
    done
    docker logs --tail 25 "$canary" >&2
    exit 1
    ;;
  start)
    if ! docker network inspect argus_checkout >/dev/null 2>&1; then
      docker network create --driver bridge argus_checkout >/dev/null
    fi
    docker compose up -d --no-build browser
    ;;
  *)
    echo 'Use canary or start' >&2
    exit 2
    ;;
esac
