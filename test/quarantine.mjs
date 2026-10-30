// Asserts which updates the preset holds for Dependency Dashboard approval, resolved through the pinned
// Renovate's own preset, packageRules, flatten, vulnerability, branch-grouping and branch-processing code. Run with
// `npm test` after `npm ci --ignore-scripts`, with git on the PATH; PRESET=<path> runs it against another
// default.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
const { isLimitReached, setCount } = await load('workers/global/limits.js');
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
// flattenUpdates writes branchName into the fixture objects, so every fixture is built fresh per call.
const replacement = (newValue = '1.0.0', extra = {}) => ({
  depName: 'containerbase/base', packageName: 'containerbase/base', datasource: 'docker', currentValue: newValue,
  updates: [{ updateType: 'replacement', newName: 'ghcr.io/containerbase/base', newValue, ...extra }],
});
const pinDigest = () => ({ depName: 'alpine', packageName: 'alpine', datasource: 'docker', currentValue: '3.20', updates: [{ updateType: 'pinDigest', isPinDigest: true, newValue: '3.20', newDigest: digest }] });

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
  assertHeld(await resolveUpdates({ dockerfile: [{ packageFile: 'Dockerfile', deps: [replacement()] }] }), 'replacement');
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
    dockerfile: [{ packageFile: 'Dockerfile', deps: [pinDigest()] }],
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
const docker = (newValue, extra = {}) => ({ dockerfile: [{ packageFile: 'Dockerfile', deps: [replacement(newValue, extra)] }] });
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

test('a held branch keeps the stop-updating label when the repository names another', async () => {
  const files = { npm: [{ packageFile: 'package.json', deps: [npm('foo', '^2.0.0', pin('2.0.1', 2))] }] };
  const { updates } = await resolveUpdates(files, { stopUpdatingLabel: 'frozen' });
  const config = generateBranchConfig(updates.filter((u) => u.updateType === 'pin'));
  assert.equal(config.stopUpdatingLabel, 'stop-updating');
  assert.ok(config.labels.includes('stop-updating'));
});

test('a held replacement\'s dashboard line shows the first 16 hex characters of its digest', async () => {
  const { updates } = await resolveUpdates(docker('1.0.0', { newDigest: `sha256:abcdef1${'1'.repeat(57)}` }));
  const { prTitle } = generateBranchConfig(updates.filter((u) => u.updateType === 'replacement'));
  assert.ok(prTitle.endsWith('@ abcdef1111111111)'), prTitle);
});

test('a repository\'s hourly commit limit skips a non-held branch and not a held one', async () => {
  const files = { npm: [{ packageFile: 'package.json', deps: [
    npm('foo', '^2.0.0', pin('2.0.1', 2)),
    npm('bar', '1.0.0', { updateType: 'major', newValue: '2.0.0', newVersion: '2.0.0', newMajor: 2 }),
  ] }] };
  const { branches } = await resolveUpdates(files, { commitHourlyLimit: 2 });
  const branchOf = (type) => generateBranchConfig([...branches.values()].find((b) => b[0].updateType === type));
  setCount('HourlyCommits', 2);
  try {
    assert.equal(isLimitReached('HourlyCommits', branchOf('major')), true, 'the fixture must reach the limit');
    assert.equal(isLimitReached('HourlyCommits', branchOf('pin')), false);
  } finally {
    setCount('HourlyCommits', 0);
  }
});

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
// under it; a replacement is the held type that does occur.
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

// Two runs of the pinned Renovate's processBranch, against a local git remote and an in-memory platform
// that keys PRs by branch name. Run 1 ticks the held update on the Dependency Dashboard, which creates its
// branch and PR. One input then changes, and run 2 processes every held branch it resolves to, with no tick.
// "PR not opened" drops run 1's PR before run 2, as when a ticked branch's PR did not open. Both runs are
// inside the schedule.
const { processBranch } = await load('workers/repository/update/branch/index.js');
const { platformScmImpls } = await load('modules/platform/scm.js');
const { DefaultGitScm } = await load('modules/platform/default-scm.js');
const { GlobalConfig } = await load('config/global.js');
const git = await load('util/git/index.js');

const gitIn = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

// Only the calls processBranch makes on these paths. processBranch catches errors, so an unexpected call
// is recorded, and the test asserts there were none.
function inMemoryPlatform() {
  const prs = new Map();
  const unexpected = [];
  const api = {
    getBranchPr: async (branchName) => prs.get(branchName) ?? null,
    findPr: async ({ branchName }) => prs.get(branchName) ?? null,
    createPr: async ({ sourceBranch, targetBranch, prTitle, labels }) => {
      const pr = { number: prs.size + 1, sourceBranch, targetBranch, title: prTitle, labels, state: 'open' };
      prs.set(sourceBranch, pr);
      return pr;
    },
    tryReuseAutoclosedPr: async () => null,
    addAssignees: async () => {},
    refreshPr: async () => {},
    updatePr: async ({ number, prTitle }) => {
      const pr = [...prs.values()].find((p) => p.number === number);
      pr.title = prTitle;
    },
    massageMarkdown: (body) => body,
    labelCharLimit: () => 50,
    getBranchStatus: async () => 'green',
    getBranchStatusCheck: async () => null,
    setBranchStatus: async () => {},
    isBranchMergeQueueEnabled: async () => false,
  };
  const get = (t, key) => {
    if (key in t || key === 'then') return t[key];
    unexpected.push(String(key));
    throw new Error(`unexpected platform call: ${String(key)}`);
  };
  return { prs, unexpected, api: new Proxy(api, { get }) };
}

const manifest = (dependencies) => `${JSON.stringify({ dependencies }, null, 2)}\n`;
const pinOfFoo = ({ packageFile = 'package.json', dep = {}, update = {} } = {}) => () => ({
  npm: [{ packageFile, deps: [npm('foo', '^2.0.0', { ...pin('2.0.1', 2), ...update }, dep)] }],
});

async function twoRuns({ run2Files = pinOfFoo(), repoConfig = {}, env = {}, onBase, prOpened = true, tick2 }) {
  const dir = await mkdtemp(join(tmpdir(), 'held-'));
  const [remote, seed, local] = ['remote.git', 'seed', 'local'].map((d) => join(dir, d));
  const commitToBase = async (files) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(seed, path)), { recursive: true });
      await writeFile(join(seed, path), content);
    }
    gitIn(seed, 'add', '-A');
    gitIn(seed, 'commit', '-qm', 'base');
    gitIn(seed, 'push', '-q', 'origin', 'HEAD:main');
  };
  const shaOf = (branchName) => gitIn(remote, 'for-each-ref', '--format=%(objectname)', `refs/heads/${branchName}`);
  const { prs, unexpected, api } = inMemoryPlatform();
  const savedEnv = Object.entries(env).map(([key]) => [key, process.env[key]]);
  try {
    gitIn(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    gitIn(dir, 'clone', '-q', remote, seed);
    await commitToBase({ 'package.json': manifest({ foo: '^2.0.0' }) });
    await mkdir(local);
    GlobalConfig.set({ localDir: local, cacheDir: join(dir, 'cache') });
    platforms.set('in-memory', api);
    platformScmImpls.set('in-memory', DefaultGitScm);
    setPlatformApi('in-memory');

    const run = async (packageFiles, config, checks = () => undefined) => {
      await git.initRepo({ url: remote, defaultBranch: 'main' });
      git.setGitAuthor('Renovate Bot <bot@example.com>'); // after initRepo, which resets it
      const runConfig = mergeChildConfig(base, { baseBranch: 'main', schedule: ['at any time'], fetchChangeLogs: 'off', ...config });
      const results = new Map();
      const held = (await flattenUpdates(runConfig, packageFiles())).filter((u) => HELD.includes(u.updateType));
      for (const [branchName, upgrades] of Map.groupBy(held, (u) => u.branchName)) {
        const branch = { ...generateBranchConfig(upgrades), packageFiles: packageFiles(), errors: [], warnings: [], dependencyDashboardChecks: checks(branchName) };
        results.set(branchName, (await processBranch(branch)).result);
      }
      return results;
    };

    const run1 = await run(pinOfFoo(), {}, (name) => ({ [name]: 'approve' }));
    assert.equal(run1.size, 1, 'run 1 must resolve one branch');
    const [[approved, result1]] = run1;
    assert.equal(result1, 'pr-created', 'run 1 must create the ticked branch and its PR');
    const sha1 = shaOf(approved);
    assert.ok(sha1, 'run 1 must push the ticked branch');
    assert.deepEqual(unexpected, [], 'run 1 made a platform call the in-memory platform does not model');
    assert.equal(prs.get(approved)?.labels?.includes('stop-updating'), true, 'run 1 must open the PR with the stop-updating label');
    if (!prOpened) prs.clear();

    if (onBase) await commitToBase(onBase);
    Object.assign(process.env, env);
    const run2 = await run(run2Files, repoConfig, (name) => (name === approved && tick2 ? { [name]: tick2 } : undefined));
    const newBranches = [...run2].filter(([name]) => name !== approved);
    for (const [name, result] of newBranches) {
      assert.equal(result, 'needs-approval', `run 2's new branch ${name} must wait for its own tick`);
      assert.equal(shaOf(name), '', `run 2 must not push ${name}`);
    }
    assert.deepEqual(unexpected, [], 'processBranch made a platform call the in-memory platform does not model');
    return { newBranch: newBranches.length > 0, newCommit: shaOf(approved) !== sha1, approvedResult: run2.get(approved) };
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    GlobalConfig.reset();
    await rm(dir, { recursive: true, force: true });
  }
}

// approvedResult is run 2's result for the approved branch: undefined when run 2 no longer resolves it.
const NEW_BRANCH = { newBranch: true, newCommit: false, approvedResult: undefined };
const NO_NEW_COMMIT = { newBranch: false, newCommit: false, approvedResult: 'no-work' };
const BOTH = [true, false];
const PR_OPEN = [true];
const twoRunCases = {
  'the datasource': [NEW_BRANCH, PR_OPEN, { run2Files: pinOfFoo({ dep: { datasource: 'github-tags' } }) }],
  'the package name behind an alias': [NEW_BRANCH, PR_OPEN, { run2Files: pinOfFoo({ dep: { packageName: 'bar' } }) }],
  'the manifest': [NEW_BRANCH, PR_OPEN, { run2Files: pinOfFoo({ packageFile: 'packages/b/package.json' }) }],
  'the new name': [NEW_BRANCH, PR_OPEN, { run2Files: pinOfFoo({ update: { newName: 'bar' } }) }],
  'the new value': [NEW_BRANCH, PR_OPEN, { run2Files: pinOfFoo({ update: { newValue: '2.0.2' } }) }],
  'the new version': [NEW_BRANCH, PR_OPEN, { run2Files: pinOfFoo({ update: { newVersion: '2.0.2' } }) }],
  'the new digest': [NEW_BRANCH, PR_OPEN, { run2Files: pinOfFoo({ update: { newDigest: digest } }) }],
  'nothing': [NO_NEW_COMMIT, PR_OPEN, {}],
  'the manifest text on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { 'package.json': manifest({ foo: '^2.0.0', qux: '^1.0.0' }) } }],
  'a conflicting edit on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { 'package.json': manifest({ foo: '^2.0.5' }) } }],
  'a lock file on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { 'package-lock.json': '{ "lockfileVersion": 3, "packages": {} }\n' } }],
  'the GitHub Actions lock file on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { '.github/workflows/actions.lock': '{}\n' } }],
  'a per-directory .npmrc on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { '.npmrc': 'registry=https://registry.example.com/\n' } }],
  'pip index lines on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { 'requirements.txt': '--index-url https://pypi.example.com/simple\n' } }],
  'uv indexes on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { 'pyproject.toml': '[[tool.uv.index]]\nname = "example"\nurl = "https://pypi.example.com/simple"\n' } }],
  '.cargo/config.toml on the base branch': [NO_NEW_COMMIT, BOTH, { onBase: { '.cargo/config.toml': '[source.crates-io]\nreplace-with = "example"\n' } }],
  'packageRules registryUrls': [NO_NEW_COMMIT, PR_OPEN, { repoConfig: { packageRules: [{ matchPackageNames: ['foo'], registryUrls: ['https://registry.example.com/'] }] } }],
  'PIP_INDEX_URL': [NO_NEW_COMMIT, PR_OPEN, { env: { PIP_INDEX_URL: 'https://pypi.example.com/simple' } }],
  'CARGO_REGISTRIES_*': [NO_NEW_COMMIT, PR_OPEN, { env: { CARGO_REGISTRIES_EXAMPLE_INDEX: 'sparse+https://crates.example.com/' } }],
  'hostRules': [NO_NEW_COMMIT, PR_OPEN, { repoConfig: { hostRules: [{ matchHost: 'registry.npmjs.org', token: 'example' }] } }],
};
for (const [input, [expected, prStates, change]] of Object.entries(twoRunCases)) {
  for (const prOpened of prStates) {
    const outcome = expected.newBranch ? 'a new branch' : 'no new commit';
    test(`two runs, ${input} changed between them${prOpened ? '' : ', PR not opened'}: ${outcome}`, async () => {
      assert.deepEqual(await twoRuns({ ...change, prOpened }), expected);
    });
  }
}

test('two runs, every open PR ticked for rebase: no new commit', async () => {
  const result = await twoRuns({ onBase: { '.npmrc': 'registry=https://registry.example.com/\n' }, repoConfig: { dependencyDashboardRebaseAllOpen: true } });
  assert.deepEqual(result, NO_NEW_COMMIT);
});

for (const prOpened of [true, false]) {
  test(`two runs, the base branch moved and the approved branch ticked for rebase${prOpened ? '' : ', PR not opened'}: a new commit`, async () => {
    const result = await twoRuns({ onBase: { '.npmrc': 'registry=https://registry.example.com/\n' }, tick2: 'rebase', prOpened });
    assert.deepEqual(result, { newBranch: false, newCommit: true, approvedResult: 'done' });
  });
}
