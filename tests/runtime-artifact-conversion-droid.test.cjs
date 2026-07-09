'use strict';

// Standalone coverage for the droid case in _applyRuntimeRewrites
// (Plan 14-04 of phase 14-droid-runtime — R5).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const conv = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-conversion.cjs'));

const { _applyRuntimeRewrites } = conv;

const PATH_PREFIX = '$HOME/.factory/';
const NORMALIZED = '$HOME/.factory';

describe('runtime-artifact-conversion droid rewrite (R5)', () => {
  test('rewrites ~/.claude/ token to pathPrefix', () => {
    const input = 'export PATH=~/.claude/bin:$PATH';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, `export PATH=${PATH_PREFIX}bin:$PATH`);
  });

  test('rewrites $HOME/.claude/ token to pathPrefix', () => {
    const input = 'node "$HOME/.claude/hooks/run.cjs"';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, `node "${PATH_PREFIX}hooks/run.cjs"`);
  });

  test('rewrites ./.claude/ token to ./${dirName}/ (i.e. ./.factory/)', () => {
    const input = 'src = ./.claude/skills/foo';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, 'src = ./.factory/skills/foo');
  });

  test('rewrites word-boundary trailing ~/.claude token to normalizedPathPrefix', () => {
    const input = 'home dir was ~/.claude';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, `home dir was ${NORMALIZED}`);
  });

  test('rewrites word-boundary trailing $HOME/.claude token to normalizedPathPrefix', () => {
    const input = 'home dir was $HOME/.claude';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, `home dir was ${NORMALIZED}`);
  });

  test('passes through ~/.factory/ token as pathPrefix (idempotent — already-droid content unchanged)', () => {
    const input = 'export PATH=~/.factory/bin:$PATH';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, `export PATH=${PATH_PREFIX}bin:$PATH`);
  });

  test('preserves .claudeignore literal as a passthrough (NOT replaced)', () => {
    const input = 'echo "Setting up .claudeignore passthrough"';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, input, '.claudeignore must be preserved verbatim for droid output (D-02)');
  });

  test('rewrites $HOME/.claude/agents/<x>.md to $HOME/.factory/droids/<x>.md (factory has no agents/ dir)', () => {
    const input = '@$HOME/.claude/agents/gsd-planner.md';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(
      output,
      `@${PATH_PREFIX}droids/gsd-planner.md`,
      `expected factory droids/ subdir; got ${JSON.stringify(output)}`,
    );
  });

  test('rewrites ~/.claude/agents/<x>.md to ~/.factory/droids/<x>.md', () => {
    const input = '!include ~/.claude/agents/gsd-verifier.md';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(output, `!include ${PATH_PREFIX}droids/gsd-verifier.md`);
  });

  test('rewrites $HOME/.claude/commands/<x>.md to $HOME/.factory/skills/<x>/SKILL.md-shape (factory slash invocations are skills/)', () => {
    const input = '$HOME/.claude/commands/gsd-help.md';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(
      output,
      `${PATH_PREFIX}skills/gsd-help.md`,
      `expected factory skills/ subdir; got ${JSON.stringify(output)}`,
    );
  });

  test('rewrites ~/.claude/commands/<x>.md to ~/.factory/skills/<x>.md', () => {
    const input = 'cp ~/.claude/commands/gsd-help.md /tmp/scratch';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.strictEqual(
      output,
      `cp ${PATH_PREFIX}skills/gsd-help.md /tmp/scratch`,
    );
  });

  test('does NOT leave residual .claude or .claude/agents tokens after rewrite (full pipeline)', () => {
    const input = [
      'a $HOME/.claude/agents/gsd-foo.md',
      'b ~/.claude/commands/gsd-bar.md',
      'c $HOME/.claude/skills/baz/SKILL.md',
    ].join('\n');
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.equal(/\.claude/.test(output), false, `output must contain no .claude residue; got ${JSON.stringify(output)}`);
    assert.match(output, /\$HOME\/\.factory\/droids\/gsd-foo\.md/);
    assert.match(output, /\$HOME\/\.factory\/skills\/gsd-bar\.md/);
    assert.match(output, /\$HOME\/\.factory\/skills\/baz\/SKILL\.md/);
  });
});

describe('runtime-artifact-conversion droid NEG_GATE — never introduce .factoryignore (D-02)', () => {
  test('no droid rewrite ever introduces a .factoryignore literal', () => {
    const input = 'a .claudeignore line\nb ~/.claude/foo\nc $HOME/.claude\nd ./.claude/skills';
    const output = _applyRuntimeRewrites(input, 'droid', PATH_PREFIX);
    assert.equal(
      /\.factoryignore/.test(output),
      false,
      `droid output must never contain a .factoryignore literal (D-02 lock); got: ${JSON.stringify(output)}`,
    );
  });

  test('non-droid runtimes also produce no .factoryignore literal (regression guard)', () => {
    for (const runtime of ['claude', 'codex', 'cline']) {
      const input = 'a ~/.claude/foo';
      const output = _applyRuntimeRewrites(input, runtime, PATH_PREFIX);
      assert.equal(
        /\.factoryignore/.test(output),
        false,
        `runtime ${runtime} output must never introduce a .factoryignore literal`,
      );
    }
  });
});
