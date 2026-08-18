# Contributing

Pull requests are welcome. A few ground rules:

- **The transport stays dependency-free.** `packages/graph-transport` has zero runtime
  dependencies and its core uses WinterCG APIs only (no Node-only imports outside the `./node`
  entry point) so it keeps running on Cloudflare Workers. PRs adding a runtime dependency to
  either package will be declined.
- The transport is the family's JS reference implementation — behaviour changes should stay
  consistent with the PHP siblings ([missivus-matomo](https://github.com/Solvetus/missivus-matomo)
  and its ports) unless there is a platform reason not to.
- Run `npm install` once, then `npm run build`, `npm test` and `npm run lint` before opening a PR.
- Security reports go to `security@missivus.com`, not the issue tracker.

No CLA, no DCO — the GPLv3 covers it.
