// Self-hosted Renovate runtime configuration for the cachekit-io org.
//
// Scope: how Renovate connects and which repos it scans. All dependency
// policy (groups, automerge, schedule, security gates, quarantine windows)
// lives in default.json — the org preset, which every repo extends via its
// own renovate.json.
//
// Loaded by .github/workflows/renovate.yml.

module.exports = {
  platform: 'github',

  // Discover every repo the cachekit-renovate-bot App is installed on.
  // The org-wide install means: every cachekit-io repo.
  autodiscover: true,
  autodiscoverFilter: ['cachekit-io/*'],

  // Repos that disable Renovate via { "enabled": false } get skipped quickly
  // instead of cloned and analyzed. Important for the strategy/docs repos that
  // have nothing to manage.
  optimizeForDisabled: true,

  // First-run experience for repos without a renovate.json: open a single
  // onboarding PR that extends the org preset. Users merge to opt in, close
  // to opt out. Once merged, every subsequent run uses normal policy.
  onboarding: true,
  onboardingConfig: {
    $schema: 'https://docs.renovatebot.com/renovate-schema.json',
    extends: ['local>cachekit-io/renovate-config'],
  },
};

// Log level is set via the LOG_LEVEL env var in the workflow, not here.
// `logLevel` is intentionally NOT a valid Renovate config key.
