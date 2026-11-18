# Local picomatch 4.0.8 (GHSA-fc5q-39xc-vjpf)

Upstream `picomatch@4.0.7` is the newest release and is still in the advisory
range (`<=4.0.7`, patched: none). ARGUS CI audits the lockfile including
devDependencies; vitest → vite/tinyglobby pull picomatch and fail
`--audit-level=high`.

This tree is 4.0.7 plus the parse.js change from micromatch/picomatch#267,
versioned as 4.0.8 so npm audit treats it as outside the vulnerable range.
`package.json` overrides force every picomatch resolve here. Remove the
override when upstream publishes a real fixed release.
