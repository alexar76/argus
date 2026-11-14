#!/bin/sh
set -eu

if [ "${ARGUS_CHECKOUT_HEADED:-0}" = 1 ]; then
  exec xvfb-run -a -s '-screen 0 1280x900x24 -nolisten tcp' node /app/server.mjs
fi

exec node /app/server.mjs
