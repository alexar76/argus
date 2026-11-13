#!/usr/bin/env bash
set -euo pipefail

target=${1:?pass the output directory}
install -d -m 0700 "$target"
target=$(cd -- "$target" && pwd)
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

install -m 0600 "$source_dir"/{.dockerignore,Dockerfile,apparmor.profile,compose.yaml,launch.sh,public-preflight.mjs,server.mjs,smoke.mjs} "$target/"
curl -fsSL --proto '=https' --max-time 45 \
  https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.1.tgz \
  -o "$target/playwright-core-1.64.1.tgz"
curl -fsSL --proto '=https' --max-time 20 \
  https://raw.githubusercontent.com/moby/profiles/f862455628f78f84c937e967e4a03902fb1dee11/seccomp/default.json \
  -o "$target/moby-seccomp.json"

python3 - "$target" <<'PY'
from hashlib import sha256, sha512
from pathlib import Path
import json
import sys

target = Path(sys.argv[1])
profile = (target / "moby-seccomp.json").read_bytes()
assert sha256(profile).hexdigest() == "3320527d4568265ac97a077609b1bfd4cfd0d789eeb9239b7e094b1526675406"
assert sha512((target / "playwright-core-1.64.1.tgz").read_bytes()).hexdigest() == (
    "042e2cf32e9211503a435ad2c594eda3c848d4a508df15e51c6660bc6a8fe08a8f"
    "748fdae855fd1f6f480cdcfbbcaa3d976d5be8b7d8a2c49c3cbe8cdf1c720d"
)
value = json.loads(profile)
# Chromium needs to create its own renderer namespaces and chroot within them.
# Remove Moby's chroot cap filter because it applies to the initial container
# capabilities. Chromium obtains the kernel capability in its own user namespace.
for rule in value["syscalls"]:
    if "chroot" in rule["names"]:
        rule["names"].remove("chroot")
value["syscalls"] = [rule for rule in value["syscalls"] if rule["names"]]
value["syscalls"].insert(0, {
    "names": ["chroot", "clone", "setns", "unshare"],
    "action": "SCMP_ACT_ALLOW",
    "comment": "Chromium namespace sandbox",
})
(target / "seccomp.json").write_text(json.dumps(value, indent=2) + "\n")
(target / "moby-seccomp.json").unlink()
PY
