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
  own group. First-party means exactly these published names, each on its own
  registry: crates.io `cachekit-core`, `cachekit-rs`, `cachekit-macros` and
  `cachekit-cli`; PyPI `cachekit`; npm `@cachekit-io/*`. Any other name,
  `cachekit*` included, waits 5 days. A new crate or PyPI package joins only
  when the preset adds it
- Lock file maintenance PRs skip that wait: Renovate has no release date to
  check them against. npm refreshes get a best-effort `--before` at the same
  5 days; pnpm and yarn refreshes get only the repo's own package-manager
  setting (pnpm 11 defaults to one day). They carry a review note and never
  automerge. Cargo and uv lock files are not refreshed: neither has a
  release-age cutoff, and uv can run builds while resolving
- All minor/patch updates are grouped into one PR; GitHub Actions, Rust dev
  deps and Python test/lint tools get their own groups. Digest-only updates
  open their own PRs
- The exception is a cargo 0.x minor update (0.12 to 0.13). Cargo treats it as
  breaking, so it opens its own PR instead of joining a group, first-party
  crates and Rust dev deps included. Cargo 0.x patch updates stay grouped
- Rust dev deps and the Python test/lint group automerge once the age gate
  has passed and their checks are green. npm dev dependencies are marked for automerge
  too, but they ride in the grouped minor/patch PR, which only automerges when
  every update in it is a dev dependency
- Renovate does that merge itself, on a later run. It merges only when
  nothing has failed, every check run it can see has finished as success,
  skipped or neutral, and every commit status other than its own is success.
  A PR whose only statuses are Renovate's own stays pending. Checks and
  statuses from review bots count too, so this does not prove CI ran: a
  repository that relies on automerge should require at least one CI status
  check. Renovate does not arm GitHub's native auto-merge
  (`platformAutomerge: false`), because native auto-merge waits only for
  required checks. The repository's own merge rules, such as required
  reviews, still apply
- `.python-version` files are off by default. A repository opts a file in
  (a `packageRule` with `matchManagers: ["pyenv"]`, `matchFileNames` set to
  that file and `enabled: true`) to keep it in step with `requires-python`, so
  both move in one branch and `uv lock` resolves against the new interpreter.
  The file must pin `X.Y`: it is looked up against python.org releases, like
  `requires-python`, so both bumps clear the 5-day wait on the same day
- `wrangler`, the deploy tool, never automerges
- Major version bumps always require manual review
- Any major update to a `pnpm-workspace.yaml` override waits under Pending
  Approval on the Dependency Dashboard instead of opening a branch. Two cases
  are not held: a 0.x bound (`<0.M`), because Renovate classes a 0.M to
  0.M+1 bump as minor, and vulnerability updates, because Renovate forces the
  approval off for them. A repository with bounded overrides therefore also
  needs a CI check that the bounds still hold
- Docker images and GitHub Actions are pinned by digest
- Replacement, pin and rollback updates wait under Pending Approval on the
  Dependency Dashboard, first-party packages included. Renovate does not check
  their release age, so the 5-day wait cannot hold them. A tick approves one
  target in one manifest: a newer release, another value or name, a new image
  digest, or the same update in another manifest waits for its own tick. Each
  dashboard line names the datasource, package and manifest, and the start of
  the digest where there is one. Ticking one opens its PR on the run that
  creates its branch. These PRs never automerge and carry the `stop-updating`
  label: Renovate rebuilds an approved branch, resolving its lock file as of
  that run, only when someone ticks it on the dashboard or ticks its PR's rebase
  box. A ticked branch whose PR did not open waits under Other Branches, and
  any of the dashboard's global checkboxes also rebuilds it. A repository's
  hourly commit limit never lists one of these branches as rate-limited. Every
  update of a package with an open vulnerability alert opens at once, a
  replacement included: Renovate forces approval off for them
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

Install the pinned Renovate first:

```sh
npm ci --ignore-scripts
```

`renovate-config-validator` auto-detects the standard repo config file names
and `config.js`, never a preset file such as `default.json`. `npm run validate`
names the preset explicitly and validates it as repository config rather than
the more permissive global config. It runs only the pinned local install:

```sh
npm run validate
```

The validator does not check what a rule resolves to. `npm test` does: it
runs `default.json` through the pinned Renovate's own preset, `packageRules`
and branch-grouping code, and checks which updates wait for Dependency
Dashboard approval. It also runs Renovate's branch processing twice against a
throwaway local git repository, so it needs `git` on the `PATH`. Set
`PRESET=<path>` to run it against another copy of the preset.

```sh
npm test
```

The `Test preset` check (`.github/workflows/test.yml`) runs `npm ci
--ignore-scripts`, `npm test` and `npm run validate` on every pull request,
Renovate's own included, and goes red if any of them fails.
