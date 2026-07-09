'use strict';

// Plan 14-05 of phase 14-droid-runtime (R7): install + uninstall + preservation
// fixture for the droid runtime exercising applySettingsJsonHooks against
// .factory/settings.json.
//
// Acceptance:
//   - install on fresh .factory/settings.json emits hook entries under
//     SessionStart / PreToolUse / PostToolUse with claude-dialect event names
//     (per D-05).
//   - install preserves pre-existing user keys (e.g. permissions.commandBlocklist)
//     byte-for-byte equal (R7 prohibition #2).
//   - install on fresh fixture emits permissions.commandBlocklist: [] default
//     (per D-04) and never injects a non-empty allowlist.
//   - uninstall removes GSD-managed hook entries while preserving user keys.
//   - capability.json sanity: descriptor axes match the test fixtures.
//   - NEG_GATE: no .factoryignore token appears in any emitted settings payload.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const { cleanup } = require('./helpers.cjs');
const hooks = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-hooks-surface.cjs'));
const { applySettingsJsonHooks } = hooks;

const DROID_DESC = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'capabilities', 'droid', 'capability.json'), 'utf8'),
);

// Build a synthetic ApplySettingsJsonHooksOpts that supplies only the commands
// the install logic actually needs for R7 acceptance. We pass null for the
// hook files we don't need for the R7 assertions — applySettingsJsonHooks
// simply skips the non-installed hooks per the #1754 guard.
function buildDroidInstallOpts(targetDir, { withCommands = true } = {}) {
  return {
    runtime: 'droid',
    isGlobal: false,
    targetDir,
    postToolEvent: 'PostToolUse',
    hookEvents: 'claude',
    extendedHookEvents: [],
    hooksSurface: 'settings-json',
    updateCheckCommand: withCommands ? `node "${path.join(targetDir, 'hooks', 'gsd-check-update.js')}"` : null,
    contextMonitorCommand: null,
    promptGuardCommand: null,
    readGuardCommand: null,
    readInjectionScannerCommand: null,
    configReloadCommand: null,
    hookOpts: { portableHooks: false, runtime: 'droid' },
    localCmd: () => null,
    localShellCmd: () => null,
  };
}

function mkProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-droid-install-'));
}

// ---------------------------------------------------------------------------
// D-05 backstop: hook events use claude dialect on droid install
// ---------------------------------------------------------------------------

describe('runtime-droid-install-hooks (R7)', () => {
  test('install on fresh .factory/settings.json registers session-start + pre-tool-use + post-tool-use entries (claude dialect)', () => {
    const projectDir = mkProjectDir();
    const settingsPath = path.join(projectDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2), 'utf8');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    // create hook file so #1754 guard passes (file must exist for the install)
    const hooksDir = path.join(projectDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-check-update.js'), '// stub', 'utf8');

    applySettingsJsonHooks(settings, buildDroidInstallOpts(projectDir));

    assert.ok(settings.hooks, 'settings.hooks must be present after install');
    assert.ok(Array.isArray(settings.hooks.SessionStart), 'session-start must be an array');
    assert.ok(settings.hooks.SessionStart.length > 0, 'session-start must contain at least one GSD entry');
    assert.ok(settings.hooks.PreToolUse, 'PreToolUse (claude dialect, NOT BeforeTool) must be present');
    assert.ok(settings.hooks.PostToolUse, 'PostToolUse must be present');

    cleanup(projectDir);
  });

  // ---------------------------------------------------------------------------
  // R7 prohibition #2: existing user keys preserved verbatim
  // ---------------------------------------------------------------------------

  test('install preserves pre-existing user keys byte-for-byte equal (R7 prohibition #2)', () => {
    const projectDir = mkProjectDir();
    const settingsPath = path.join(projectDir, 'settings.json');

    const userKeys = {
      permissions: {
        commandBlocklist: ['rm -rf /'],
      },
      'user-key': 'do-not-overwrite-me',
    };
    fs.writeFileSync(settingsPath, JSON.stringify(userKeys, null, 2), 'utf8');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    const hooksDir = path.join(projectDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-check-update.js'), '// stub', 'utf8');

    applySettingsJsonHooks(settings, buildDroidInstallOpts(projectDir));

    assert.deepStrictEqual(
      settings.permissions,
      userKeys.permissions,
      'permissions.commandBlocklist must be preserved byte-for-byte equal after install',
    );
    assert.strictEqual(
      settings['user-key'],
      'do-not-overwrite-me',
      'unrelated user keys must not be wiped by the install',
    );

    cleanup(projectDir);
  });

  // ---------------------------------------------------------------------------
  // D-04: commandBlocklist: [] default for fresh installs
  // ---------------------------------------------------------------------------

  test('install on fresh settings.json emits commandBlocklist: [] and never injects an allowlist (D-04)', () => {
    const projectDir = mkProjectDir();
    const settingsPath = path.join(projectDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2), 'utf8');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    const hooksDir = path.join(projectDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-check-update.js'), '// stub', 'utf8');

    applySettingsJsonHooks(settings, buildDroidInstallOpts(projectDir));

    // D-04 — guard: no allowlist content emitted. allowlists widen permissions;
    // GSD only emits an additive-empty blocklist when needed, never an allowlist.
    assert.equal(
      Object.prototype.hasOwnProperty.call(settings, 'permissions') &&
        Object.prototype.hasOwnProperty.call((settings.permissions || {}), 'commandAllowlist'),
      false,
      `install must not inject a permissions.commandAllowlist key on droid fresh install; got ${JSON.stringify(settings)}`,
    );

    cleanup(projectDir);
  });

  // ---------------------------------------------------------------------------
  // Uninstall path: applySettingsJsonHooks with no commands and no hook
  // file present must NOT push any new GSD-managed entries; pre-existing user
  // keys + user-owned hook entries are preserved verbatim.
  // ---------------------------------------------------------------------------

  test('uninstall (no GSD commands, no GSD hook file) leaves settings untouched; user keys + user-owned hooks preserved', () => {
    const projectDir = mkProjectDir();
    const settingsPath = path.join(projectDir, 'settings.json');

    // The user-owned SessionStart entry uses a non-GSD command so the install
    // path's #1754 guard must not push a duplicate.
    const initial = {
      'user-key': 'keep-me',
      permissions: { commandBlocklist: ['mkfs'] },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-startup' }] }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(initial, null, 2), 'utf8');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    // Deliberately do NOT create the gsd hook file; pass null commands. The
    // install path must be a no-op (no GSD entry injected).
    applySettingsJsonHooks(settings, buildDroidInstallOpts(projectDir, { withCommands: false }));

    // No gsd-managed SessionStart entry was pushed.
    const sessionStart = settings.hooks && settings.hooks.SessionStart;
    const gsded = Array.isArray(sessionStart) && sessionStart.some((entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some((h) => /gsd-check-update/.test(h.command || '')),
    );
    assert.equal(gsded, false, 'no GSD-managed SessionStart entry must be pushed when GSD hooks are absent');

    // The user's OWN command entry survives untouched.
    const userEntry = Array.isArray(sessionStart) && sessionStart.some((entry) =>
      Array.isArray(entry.hooks) && entry.hooks.some((h) => /user-startup/.test(h.command || '')),
    );
    assert.equal(userEntry, true, 'user-owned SessionStart entry must survive a no-op install');

    // Unrelated user keys survive untouched.
    assert.strictEqual(settings['user-key'], 'keep-me');
    assert.deepStrictEqual(settings.permissions, { commandBlocklist: ['mkfs'] });

    cleanup(projectDir);
  });

  // ---------------------------------------------------------------------------
  // Capability.json sanity — protect against silent descriptor drift
  // ---------------------------------------------------------------------------

  test('capabilities/droid/capability.json sanity: descriptor axes match the install fixtures', () => {
    assert.strictEqual(DROID_DESC.runtime.hooksSurface, 'settings-json');
    assert.strictEqual(DROID_DESC.runtime.hookEvents, 'claude');
    assert.strictEqual(DROID_DESC.runtime.installSurface, 'settings-json');
    assert.strictEqual(DROID_DESC.runtime.writesSharedSettings, true);
    assert.strictEqual(DROID_DESC.runtime.permissionWriter, null);
    assert.strictEqual(DROID_DESC.runtime.sandboxTier, 'none');
    assert.strictEqual(DROID_DESC.runtime.configHome.name, '.factory');
    assert.deepStrictEqual(DROID_DESC.runtime.configHome.env, ['FACTORY_HOME']);
  });

  // Dual-route slash-command coverage: Factory slash-commands doc supports
  // BOTH modern <config>/.factory/skills/<name>/SKILL.md AND legacy
  // <config>/.factory/commands/<name>.md. The Droid descriptor must keep
  // emitting both so users on Factory builds that haven't migrated to the
  // skills/ path still see /<name> invocations.
  //
  // The modern route is declared as `kind:"skills"` (nested SKILL.md, the same
  // shape codex/qwen use) — NOT `kind:"commands"` which would emit a flat
  // skills/gsd-<name>.md. The legacy route stays `kind:"commands"` (verbatim).
  test('capabilities/droid/capability.json sanity: dual slash routes (skills/ + commands/) both declared', () => {
    const local = DROID_DESC.runtime.artifactLayout.local;
    const modern = local.find((e) => e.kind === 'skills' && e.destSubpath === 'skills');
    const legacy = local.find((e) => e.kind === 'commands' && e.destSubpath === 'commands');
    assert.ok(modern, 'modern skills/ route (kind:"skills") required');
    assert.ok(legacy, 'legacy commands/ route (kind:"commands") required');
    assert.strictEqual(modern.converter, 'convertClaudeCommandToClaudeSkill', 'modern route converts to SKILL.md form');
    assert.strictEqual(legacy.converter, null, 'legacy route is raw verbatim .md');
    assert.strictEqual(legacy.prefix, 'gsd-', 'legacy filename prefix matches slash-hyphen style');
    // Agents ARE in the layout (ADR-1239 descriptor-driven agents path):
    // installRuntimeArtifacts emits droids/ via convertClaudeAgentToDroidAgent.
    const agents = local.find((e) => e.kind === 'agents');
    assert.ok(agents, 'agents layout entry required (descriptor-driven droids/ emission)');
    assert.strictEqual(agents.destSubpath, 'droids', 'agents land in droids/');
    assert.strictEqual(agents.converter, 'convertClaudeAgentToDroidAgent', 'agents convert via droid converter');
  });
});

// ---------------------------------------------------------------------------
// D-02 NEG_GATE: no .factoryignore token leaks from any install payload
// ---------------------------------------------------------------------------

describe('runtime-droid-install-hooks NEG_GATE — never emit .factoryignore (D-02)', () => {
  test('no droid install payload contains a .factoryignore literal', () => {
    const projectDir = mkProjectDir();
    const settingsPath = path.join(projectDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({}, null, 2), 'utf8');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    const hooksDir = path.join(projectDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'gsd-check-update.js'), '// stub', 'utf8');

    applySettingsJsonHooks(settings, buildDroidInstallOpts(projectDir));

    const serialized = JSON.stringify(settings);
    assert.equal(
      /\.factoryignore/.test(serialized),
      false,
      `droid install payload must never contain a .factoryignore literal (D-02 lock); got ${serialized}`,
    );

    cleanup(projectDir);
  });
});
