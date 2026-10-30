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
    assert.equal(config.rebaseWhen, 'never', `${what}: an approved branch must not be rebuilt, or its lock file re-resolved, without a tick`);
    assert.ok(config.labels.includes('stop-updating') && config.stopUpdatingLabel === 'stop-updating', `${what}: its PR must carry the stop-updating label, or a global dashboard checkbox rebuilds it`);
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
// Renovate gives it when it is rebuilt. Each pair below is one dependency on two runs, or two dependencies on one run: a
// different target or manifest must get a different branch name, so it waits for its own tick, and a
// different PR title, so the Dependency Dashboard line a maintainer ticks tells the two apart.
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
  'a pin to a release that differs only in a doubled hyphen': [
    onNpm(npm('foo', '^2.0.1-alpha', pin('2.0.1-alpha--beta', 2))),
    onNpm(npm('foo', '^2.0.1-alpha', pin('2.0.1-alpha-beta', 2))),
  ],
  'a replacement whose digest shares its first 7 characters': [
    docker('1.0.0', { newDigest: `sha256:abcdef1${'1'.repeat(57)}` }),
    docker('1.0.0', { newDigest: `sha256:abcdef1${'2'.repeat(57)}` }),
  ],
  'the same pin in manifests whose paths differ only in case': [
    { npm: [{ packageFile: 'packages/Foo/package.json', deps: [npm('foo', '^2.0.0', pin('2.0.1', 2))] }] },
    { npm: [{ packageFile: 'packages/foo/package.json', deps: [npm('foo', '^2.0.0', pin('2.0.1', 2))] }] },
  ],
  'a replacement to a name that differs only in punctuation': [docker('1.0.0', { newName: '@acme/tool' }), docker('1.0.0', { newName: 'acme-tool' })],
  'a pin of an npm alias to another package': [
    onNpm({ ...npm('foo', '^2.0.0', pin('2.0.1', 2)), packageName: 'bar' }),
    onNpm({ ...npm('foo', '^2.0.0', pin('2.0.1', 2)), packageName: 'baz' }),
  ],
  'the same pin in another manifest, which may use another registry': [
    onNpm(npm('foo', '^2.0.0', pin('2.0.1', 2))),
    { npm: [{ packageFile: 'packages/b/package.json', deps: [npm('foo', '^2.0.0', pin('2.0.1', 2))] }] },
  ],
  'a pin of a same-named package in another ecosystem': [
    onNpm(npm('foo', '^2.0.0', pin('2.0.1', 2))),
    { pep621: [{ packageFile: 'package.json', deps: [{ depName: 'foo', packageName: 'foo', datasource: 'pypi', currentValue: '>=2', updates: [pin('2.0.1', 2)] }] }] }, // same file and value, so only the datasource differs
  ],
};
for (const [name, [a, b]] of Object.entries(targets)) {
  test(`a held branch is bound to its target and manifest: ${name}`, async () => {
    const heldOf = async (files) => {
      const held = (await resolveUpdates(files, { rollbackPrs: true })).updates.filter((u) => HELD.includes(u.updateType));
      assert.equal(held.length, 1, 'fixture must produce one held update');
      return { branchName: held[0].branchName, prTitle: generateBranchConfig(held).prTitle };
    };
    const [first, second] = [await heldOf(a), await heldOf(b)];
    assert.notEqual(first.branchName, second.branchName, `both resolve to ${first.branchName}, so an approved branch would take the second without a tick`);
    assert.notEqual(first.prTitle, second.prTitle, `both show "${first.prTitle}" on the dashboard, so a tick cannot tell them apart`);
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
// dependencyDashboardApproval to false and sets prCreation immediate for every update of the alerted
// package, a replacement included. An alert forces rangeStrategy update-lockfile, so lookup emits no pin
// under it; a replacement is the held type that does occur. flattenUpdates writes into the fixture, so
// each call gets a fresh one.
const vulnerable = () => ({
  npm: [{ packageFile: 'package.json', deps: [npm('foo', '2.0.0', { updateType: 'replacement', newName: 'bar', newValue: '2.0.0' }, { currentVersion: '2.0.0', lockedVersion: '2.0.0' })] }],
});

async function assertVulnerabilityFixOpens(config) {
  assertHeld(await resolveUpdates(vulnerable()), 'replacement');
  const fix = (await flattenUpdates(config, vulnerable())).find((u) => u.updateType === 'replacement');
  assert.equal(fix.isVulnerabilityAlert, true, 'the alert rule must match the fixture');
  assertOpens(fix, `replacement under an alert ${fix.branchName}`);
  assertOpens(generateBranchConfig([fix]), `the branch of the replacement under an alert ${fix.branchName}`);
  assert.notEqual(fix.rebaseWhen, 'never', 'a PR opened under an alert must still rebase');
  assert.ok(!generateBranchConfig([fix]).labels.includes('stop-updating'), 'a PR opened under an alert must not carry the stop-updating label');
}

test('a replacement of a package with a GitHub alert opens at once', async () => {
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

test('a replacement of a package with an OSV advisory opens at once', async () => {
  const osv = {
    id: 'GHSA-yyyy-yyyy-yyyy', modified: '2026-01-01T00:00:00Z', summary: 'test', details: '',
    affected: [{ package: { ecosystem: 'npm', name: 'foo' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.0.1' }] }] }],
  };
  const config = { ...base, packageRules: [...base.packageRules] };
  await new Vulnerabilities({ getVulnerabilities: async () => [osv] }).appendVulnerabilityPackageRules(config, vulnerable());
  assert.ok(config.packageRules.some((r) => r.isVulnerabilityAlert), 'OSV advisory must produce a packageRule');
  await assertVulnerabilityFixOpens(config);
});

// crates.io and PyPI have no namespace, so the preset names each first-party package exactly, on its
// own datasource. Any other cachekit* name keeps the global release-age wait and schedule.
const FIRST_PARTY = 'first-party cachekit';
const VERSIONING = { crate: 'cargo', pypi: 'pep440', npm: 'npm' }; // as lookup sets them
const release = (datasource, name, currentValue, updateType, newVersion) => ({
  depName: name, packageName: name, datasource, versioning: VERSIONING[datasource], depType: 'dependencies', currentValue,
  updates: [{ updateType, newValue: newVersion, newVersion, newMajor: Number(newVersion.split('.')[0]) }],
});
const resolveOne = async (manager, dep) => (await resolveUpdates({ [manager]: [{ packageFile: 'manifest', deps: [dep] }] })).updates[0];
const firstPartyCases = [
  ['cargo', 'crate', 'cachekit-core', true],
  ['cargo', 'crate', 'cachekit-rs', true],
  ['cargo', 'crate', 'cachekit-macros', true],
  ['cargo', 'crate', 'cachekit-cli', true],
  ['pep621', 'pypi', 'cachekit', true],
  ['npm', 'npm', '@cachekit-io/cachekit', true],
  ['cargo', 'crate', 'cachekit', false],
  ['npm', 'npm', 'cachekit-ts', false],
  ['pep621', 'pypi', 'cachekit-core', false],
];
for (const [manager, datasource, name, firstParty] of firstPartyCases) {
  test(`${datasource} ${name} ${firstParty ? 'is first-party: 0-day age, own group, any time' : 'is not first-party: global age and schedule'}`, async () => {
    const u = await resolveOne(manager, release(datasource, name, '1.0.0', 'patch', '1.0.1'));
    if (firstParty) {
      assert.equal(u.minimumReleaseAge, '0 days');
      assert.equal(u.groupName, FIRST_PARTY);
      assert.deepEqual(u.schedule, ['at any time']);
      assert.equal(u.rangeStrategy, 'update-lockfile');
    } else {
      assert.equal(u.minimumReleaseAge, '5 days');
      assert.notEqual(u.groupName, FIRST_PARTY);
      assert.deepEqual(u.schedule, base.schedule);
    }
  });
}

test('a 0.x minor of a first-party crate leaves the group and keeps the 0-day age', async () => {
  const u = await resolveOne('cargo', release('crate', 'cachekit-core', '0.7.0', 'minor', '0.8.0'));
  assert.equal(u.groupName, null);
  assert.equal(u.minimumReleaseAge, '0 days');
});
