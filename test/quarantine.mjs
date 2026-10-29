// Asserts which updates the preset holds for Dependency Dashboard approval, resolved through the pinned
// Renovate's own preset, packageRules, flatten, vulnerability and branch-grouping code. Run with
// `npm test` after `npm ci --ignore-scripts`; PRESET=<path> runs it against another default.json.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

const dist = new URL('../node_modules/renovate/dist/', import.meta.url);
const load = (p) => import(new URL(p, dist));
const { getConfig } = await load('config/defaults.js');
const { mergeChildConfig } = await load('config/utils.js');
const { resolveConfigPresets } = await load('config/presets/index.js');
const { flattenUpdates } = await load('workers/repository/updates/flatten.js');
const { generateBranchConfig } = await load('workers/repository/updates/generate.js');
const { detectVulnerabilityAlerts } = await load('workers/repository/init/vulnerability.js');
const { Vulnerabilities } = await load('workers/repository/process/vulnerabilities.js');
const { setPlatformApi } = await load('modules/platform/index.js');
const { default: platforms } = await load('modules/platform/api.js');

const presetPath = process.env.PRESET ? resolve(process.env.PRESET) : new URL('../default.json', import.meta.url);
const preset = JSON.parse(await readFile(presetPath, 'utf8'));
const base = mergeChildConfig(getConfig(), (await resolveConfigPresets(preset)).config);
const HELD = ['replacement', 'pin', 'rollback'];
const digest = `sha256:${'b'.repeat(64)}`;

const npm = (depName, currentValue, update, extra = {}) => ({
  depName, packageName: depName, datasource: 'npm', versioning: 'npm', depType: 'dependencies', currentValue, updates: [update], ...extra,
});
const pin = (newVersion, newMajor) => ({ updateType: 'pin', isPin: true, newValue: newVersion, newVersion, newMajor });
const replacement = { depName: 'containerbase/base', packageName: 'containerbase/base', datasource: 'docker', currentValue: '1.0.0', updates: [{ updateType: 'replacement', newName: 'ghcr.io/containerbase/base', newValue: '1.0.0' }] };
const pinDigest = { depName: 'alpine', packageName: 'alpine', datasource: 'docker', currentValue: '3.20', updates: [{ updateType: 'pinDigest', isPinDigest: true, newValue: '3.20', newDigest: digest }] };

// Resolves package files the way a repository run does after lookup: the preset, any repository
// config, then packageRules per update, then branches grouped by branchName.
async function resolveUpdates(packageFiles, repoConfig = {}) {
  const updates = await flattenUpdates(mergeChildConfig(base, repoConfig), packageFiles);
  return { updates, branches: Map.groupBy(updates, (u) => u.branchName) };
}

function assertHeld({ updates, branches }, type) {
  const held = updates.filter((u) => u.updateType === type);
  assert.ok(held.length, `fixture must produce a ${type} update`);
  for (const u of held) {
    const what = `${type} of ${u.depName} (${u.branchName})`;
    assert.equal(u.minimumReleaseAgeBehaviour, 'timestamp-required', `${what} must stay timestamp-required`);
    const branch = branches.get(u.branchName);
    assert.ok(branch.every((o) => HELD.includes(o.updateType)), `${what} must share a branch only with held updates, or an existing branch could open it`);
    const config = generateBranchConfig(branch);
    assert.equal(config.dependencyDashboardApproval, true, `${what}: its branch must wait for approval`);
    assert.equal(config.prCreation, 'immediate', `${what}: once ticked, its branch must open its PR on the same run`);
    assert.equal(config.automerge, false, `${what}: a ticked update must be merged by hand, never automerged`);
  }
}

function assertOpens(u, what) {
  assert.equal(u.prCreation, 'immediate', `${what} must open its PR immediately`);
  assert.notEqual(u.dependencyDashboardApproval, true, `${what} must not wait for approval`);
}

test('the held rule comes after every rule that sets groupName', () => {
  const held = base.packageRules.findIndex((r) => HELD.every((t) => r.matchUpdateTypes?.includes(t)));
  assert.notEqual(held, -1, 'the preset must have a rule matching every held type');
  assert.equal(held, base.packageRules.findLastIndex((r) => 'groupName' in r), 'a later groupName would put held updates back in a group');
});

test('a replacement alone is held', async () => {
  assertHeld(await resolveUpdates({ dockerfile: [{ packageFile: 'Dockerfile', deps: [replacement] }] }), 'replacement');
});

test('a pin alone is held', async () => {
  const files = { npm: [{ packageFile: 'package.json', deps: [npm('foo', '^2.0.0', pin('2.0.1', 2))] }] };
  assertHeld(await resolveUpdates(files), 'pin');
});

test('a rollback alone is held (rollbackPrs: true)', async () => {
  const rollback = npm('left-pad', '1.1.0', { updateType: 'rollback', newValue: '1.0.0', newVersion: '1.0.0', newMajor: 1 });
  const files = { npm: [{ packageFile: 'package.json', deps: [rollback] }] };
  assertHeld(await resolveUpdates(files, { rollbackPrs: true }), 'rollback');
});

test('pins leave the Pin Dependencies group and this preset\'s groups; pinDigest still groups', async () => {
  const resolved = await resolveUpdates({
    dockerfile: [{ packageFile: 'Dockerfile', deps: [pinDigest] }],
    npm: [{ packageFile: 'package.json', deps: [
      npm('foo', '^2.0.0', pin('2.0.1', 2)),
      npm('@cachekit-io/cachekit', '^1.3.0', pin('1.3.1', 1)),
      npm('@cachekit-io/other', '1.0.0', { updateType: 'minor', newValue: '1.1.0', newVersion: '1.1.0', newMajor: 1 }),
    ] }],
    cargo: [{ packageFile: 'Cargo.toml', deps: [
      { depName: 'http-body-util', packageName: 'http-body-util', datasource: 'crate', depType: 'dev-dependencies', currentValue: '1.0', updates: [pin('=1.0.2', 1)] },
      { depName: 'anyhow', packageName: 'anyhow', datasource: 'crate', depType: 'dev-dependencies', currentValue: '1.0.80', updates: [{ updateType: 'patch', newValue: '1.0.81', newVersion: '1.0.81', newMajor: 1 }] },
    ] }],
    pep621: [{ packageFile: 'pyproject.toml', deps: [
      { depName: 'pytest', packageName: 'pytest', datasource: 'pypi', currentValue: '>=8', updates: [pin('==8.3.0', 8)] },
      { depName: 'ruff', packageName: 'ruff', datasource: 'pypi', currentValue: '1.6.1', updates: [{ updateType: 'patch', newValue: '1.6.2', newVersion: '1.6.2', newMajor: 1 }] },
    ] }],
  });
  // Each pin above has a non-held groupmate it would otherwise share a branch with.
  for (const group of ['renovate/first-party-cachekit', 'renovate/rust-dev-deps', 'renovate/python-dev-deps']) {
    const members = resolved.branches.get(group);
    assert.ok(members?.length && members.every((u) => !HELD.includes(u.updateType)), `${group} keeps its version updates and no held ones`);
  }
  assertHeld(resolved, 'pin');
  const digestPins = resolved.branches.get('renovate/pin-dependencies');
  assert.ok(digestPins?.length && digestPins.every((u) => u.updateType === 'pinDigest'), 'digest pins still group');
  assertOpens(generateBranchConfig(digestPins), 'the digest pin group');
});

// Approval only gates a branch that does not exist yet, and an existing branch takes whatever target
// Renovate gives it. Each pair below is one dependency on two runs, or two dependencies on one run: a
// different target must get a different branch name, so it waits for its own tick.
const docker = (newValue, extra = {}) => ({
  dockerfile: [{ packageFile: 'Dockerfile', deps: [{ ...replacement, currentValue: newValue, updates: [{ ...replacement.updates[0], newValue, ...extra }] }] }],
});
const onNpm = (dep) => ({ npm: [{ packageFile: 'package.json', deps: [dep] }] });
const rollback = (v) => npm('left-pad', '1.1.0', { updateType: 'rollback', newValue: v, newVersion: v, newMajor: 1 });
const targets = {
  'a pin to a newer release': [onNpm(npm('foo', '^2.0.0', pin('2.0.1', 2))), onNpm(npm('foo', '^2.0.0', pin('2.0.2', 2)))],
  'a rollback to another release': [onNpm(rollback('1.0.0')), onNpm(rollback('1.0.1'))],
  'a replacement to another value': [docker('1.0.0'), docker('1.1.0')],
  'a replacement whose tag is re-pushed': [docker('1.0.0', { newDigest: `sha256:${'1'.repeat(64)}` }), docker('1.0.0', { newDigest: `sha256:${'2'.repeat(64)}` })],
  'a replacement to another name': [docker('1.0.0'), docker('1.0.0', { newName: 'quay.io/containerbase/base' })],
  'a pin of a same-named package in another ecosystem': [
    onNpm(npm('foo', '^2.0.0', pin('2.0.1', 2))),
    { pep621: [{ packageFile: 'pyproject.toml', deps: [{ depName: 'foo', packageName: 'foo', datasource: 'pypi', currentValue: '>=2', updates: [{ ...pin('2.0.1', 2), newValue: '==2.0.1' }] }] }] },
  ],
};
for (const [name, [a, b]] of Object.entries(targets)) {
  test(`a held branch is bound to its target: ${name}`, async () => {
    const branchOf = async (files) => {
      const held = (await resolveUpdates(files, { rollbackPrs: true })).updates.filter((u) => HELD.includes(u.updateType));
      assert.equal(held.length, 1, 'fixture must produce one held update');
      return held[0].branchName;
    };
    const [first, second] = [await branchOf(a), await branchOf(b)];
    assert.notEqual(first, second, `both targets resolve to ${first}, so an approved branch would take the second without a tick`);
  });
}

test('a major and a pin of the same dependency get separate branches', async () => {
  const resolved = await resolveUpdates({
    npm: [
      { packageFile: 'packages/a/package.json', deps: [npm('foo', '1.0.0', { updateType: 'major', newValue: '2.0.0', newVersion: '2.0.0', newMajor: 2 })] },
      { packageFile: 'package.json', deps: [npm('foo', '^2.0.0', pin('2.0.1', 2))] },
    ],
  });
  assertHeld(resolved, 'pin');
  const major = resolved.updates.find((u) => u.updateType === 'major');
  assertOpens(major, `the major of foo (${major.branchName})`);
});

// Both alert sources append a packageRule whose force carries vulnerabilityAlerts, which resets
// dependencyDashboardApproval to false and sets prCreation immediate.
const vulnerable = { npm: [{ packageFile: 'package.json', deps: [npm('foo', '^2.0.0', pin('2.0.1', 2), { currentVersion: '2.0.0', lockedVersion: '2.0.0' })] }] };

async function assertVulnerabilityFixOpens(config) {
  assertHeld(await resolveUpdates(vulnerable), 'pin');
  const fix = (await flattenUpdates(config, vulnerable)).find((u) => u.updateType === 'pin');
  assert.equal(fix.isVulnerabilityAlert, true, 'the alert rule must match the fixture');
  assertOpens(fix, `vulnerability fix ${fix.branchName}`);
  assertOpens(generateBranchConfig([fix]), `the branch of vulnerability fix ${fix.branchName}`);
}

test('a GitHub vulnerability fix on a held type is not held', async () => {
  const alert = {
    security_advisory: { summary: 'test', identifiers: [{ type: 'GHSA', value: 'GHSA-xxxx-xxxx-xxxx' }], references: [], description: '' },
    security_vulnerability: { package: { ecosystem: 'npm', name: 'foo' }, first_patched_version: { identifier: '2.0.1' }, vulnerable_version_range: '< 2.0.1', severity: 'HIGH' },
  };
  // Only the alert fetch is replaced; detectVulnerabilityAlerts builds the packageRule as in a run.
  platforms.set('github', { getVulnerabilityAlerts: async () => [alert] });
  setPlatformApi('github');
  const config = await detectVulnerabilityAlerts({ ...base, packageRules: [...base.packageRules] });
  assert.ok(config.packageRules.some((r) => r.isVulnerabilityAlert), 'GitHub alert must produce a packageRule');
  await assertVulnerabilityFixOpens(config);
});

test('an OSV vulnerability fix on a held type is not held', async () => {
  const osv = {
    id: 'GHSA-yyyy-yyyy-yyyy', modified: '2026-01-01T00:00:00Z', summary: 'test', details: '',
    affected: [{ package: { ecosystem: 'npm', name: 'foo' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.1' }] }] }],
  };
  const config = { ...base, packageRules: [...base.packageRules] };
  await new Vulnerabilities({ getVulnerabilities: async () => [osv] }).appendVulnerabilityPackageRules(config, vulnerable);
  assert.ok(config.packageRules.some((r) => r.isVulnerabilityAlert), 'OSV advisory must produce a packageRule');
  await assertVulnerabilityFixOpens(config);
});
