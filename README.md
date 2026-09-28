# cachekit-io/renovate-config

Shared Renovate preset for all cachekit-io repositories (`default.json`), plus
the self-hosted Renovate run that applies it (`config.js` +
`.github/workflows/renovate.yml`).

## What the preset does

- Policy schedule: daily before 6am Australia/Sydney. Lock file maintenance
  weekly, Monday before 6am
- PRs open as soon as their branch exists (Renovate's default `prCreation`).
  CI in these repositories runs on pull requests, not on `renovate/*` branch
  pushes, so a branch has no checks until its PR exists; waiting for them
  before opening the PR would mean it never opens
- Security updates (GitHub Dependabot alerts and OSV) bypass the schedule and
  the release-age quarantine, carry the `security` label, and are never
  automerged
- Third-party releases wait 5 days (`minimumReleaseAge`) before they are
  proposed; first-party cachekit-io packages propagate immediately in their
  own group
- Lock file maintenance PRs skip that wait: Renovate has no release date to
  check them against. npm refreshes get a best-effort `--before` at the same
  5 days; pnpm and yarn refreshes get only the repo's own package-manager
  setting (pnpm 11 defaults to one day). They carry a review note and never
  automerge. Cargo and uv lock files are not refreshed: neither has a
  release-age cutoff, and uv can run builds while resolving
- All minor/patch updates are grouped into one PR; GitHub Actions, Rust dev
  deps and Python test/lint tools get their own groups. Digest-only updates
  open their own PRs
- Rust dev deps and the Python test/lint group automerge once the age gate
  has passed and CI is green. npm dev dependencies are marked for automerge
  too, but they ride in the grouped minor/patch PR, which only automerges when
  every update in it is a dev dependency
- Renovate does that merge itself, on a later run, and only when every check
  run and commit status on the PR has passed; a PR with no checks never
  automerges. It does not arm GitHub's native auto-merge
  (`platformAutomerge: false`), because native auto-merge waits only for
  required checks. The repository's own merge rules, such as required
  reviews, still apply
- Major version bumps always require manual review
- A routine update that would move a `pnpm-workspace.yaml` override past its
  upper bound into a new major waits under Pending Approval on the Dependency
  Dashboard instead of opening a branch. Vulnerability updates skip that
  approval (Renovate forces it off for them), so a repository with bounded
  overrides also needs a CI check that the bounds still hold
- Docker images and GitHub Actions are pinned by digest
- Manifests under `test/`, `tests/` and `__tests__/` are scanned. This
  overrides the ignore list `config:recommended` applies, because test
  harnesses in this org carry real dependencies that Dependabot flags. Their
  updates follow the same rules as everything else, dev-dependency automerge
  included

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

The run authenticates as the `cachekit-renovate-bot` GitHub App. Renovate
needs the repository permissions below on that App. After any permission
change the org installation has to accept the new permissions before they take
effect.

| Permission | Level | Why Renovate needs it |
|---|---|---|
| Contents | read & write | read manifests, push branches |
| Pull requests | read & write | open and update PRs |
| Issues | read & write | Dependency Dashboard issue, assignees |
| Workflows | read & write | update pins inside `.github/workflows` |
| Dependabot alerts | read | read the repo's vulnerability alerts. Without it every Dependency Dashboard shows "Cannot access vulnerability alerts" and only OSV-sourced security PRs are opened |
| Commit statuses | read & write | Renovate writes its own `renovate/*` statuses (release-age gate, artifact errors) and reads the combined commit status before it automerges. Without it the run aborts with "Integration unauthorized" and no non-security PR is ever opened |
| Checks | read | read check runs when deciding whether a branch is green |
| Administration | read | optional. Reads branch protection so branches that fall behind a base with strict status checks get rebased; without it that read fails quietly and such branches are never rebased |

Reference: <https://docs.renovatebot.com/security-and-permissions/>

## Validating changes

`renovate-config-validator` auto-detects the standard repo config file names
and `config.js`, never a preset file such as `default.json`. Name the preset
explicitly, and validate it as repository config rather than the more
permissive global config:

```sh
npx --yes --package renovate@43 -- renovate-config-validator --strict --no-global default.json
```
