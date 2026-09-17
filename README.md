# cachekit-io/renovate-config

Shared Renovate preset for all cachekit-io repositories (`default.json`), plus
the self-hosted runner that applies it (`config.js` +
`.github/workflows/renovate.yml`).

## What the preset does

- Policy schedule: daily before 6am Australia/Sydney. Lock file maintenance
  weekly, Monday before 6am
- Security updates (GitHub Dependabot alerts and OSV) bypass the schedule and
  the release-age quarantine, carry the `security` label, and are never
  automerged
- Third-party releases wait 5 days (`minimumReleaseAge`) before they are
  proposed; first-party cachekit-io packages propagate immediately in their
  own group
- All non-major updates are grouped into one PR; GitHub Actions, Rust dev deps
  and Python test/lint tools get their own groups
- Minor/patch dev dependency updates automerge once CI is green
- Major version bumps always require manual review
- Docker images and GitHub Actions are pinned by digest
- Manifests under `test/`, `tests/` and `__tests__/` are scanned. This
  overrides the ignore list `config:recommended` applies, because test
  harnesses in this org carry real dependencies that Dependabot flags

## Per-repo setup

Add a `renovate.json` at the repo root:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>cachekit-io/renovate-config"]
}
```

That's it. Override specific rules by adding `packageRules` after the `extends`.

## Bot GitHub App permissions

The runner authenticates as the `cachekit-renovate-bot` GitHub App. Renovate
needs the repository permissions below on that App. After any permission
change the org installation has to accept the new permissions before they take
effect.

| Permission | Level | Why Renovate needs it |
|---|---|---|
| Metadata | read | mandatory for every App |
| Contents | read & write | read manifests, push branches |
| Pull requests | read & write | open and update PRs |
| Issues | read & write | Dependency Dashboard issue |
| Workflows | read & write | update pins inside `.github/workflows` |
| Members | read | resolve assignees and reviewers |
| Dependabot alerts | read | read the repo's vulnerability alerts. Without it every Dependency Dashboard shows "Cannot access vulnerability alerts" and only OSV-sourced security PRs are opened |
| Commit statuses | read & write | `prCreation: not-pending` reads the combined commit status before opening a PR, and the release-age check is written as a status. Without it the run aborts with "Integration unauthorized" on the first scheduled branch and no non-security PR is ever opened |
| Checks | read | read check runs when deciding whether a branch is green |
| Administration | read | read branch protection to decide whether to rebase branches that fall behind the base |

Reference: <https://docs.renovatebot.com/security-and-permissions/>

## Validating changes

`renovate-config-validator` only auto-detects `renovate.json` and
`config.js`. The preset itself has to be named explicitly or it is silently
skipped:

```sh
npx --yes --package renovate@43 -- renovate-config-validator --strict default.json
```
