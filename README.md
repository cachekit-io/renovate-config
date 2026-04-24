# cachekit-io/renovate-config

Shared Renovate preset for all cachekit-io repositories.

## What it does

- Runs weekly on Monday before 6am AEST
- Auto-merges patch/minor dev dependency updates after a 3-day age gate and CI green
- Groups GitHub Actions, Rust dev deps, and Python test/lint tools into batched PRs
- Security advisories bypass the schedule and get priority 10
- Major version bumps always require manual review
- Pins Docker image digests

## Per-repo setup

Add a `renovate.json` at the repo root:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>cachekit-io/renovate-config"]
}
```

That's it. Override specific rules by adding `packageRules` after the `extends`.
