'use strict';

// Round-trip tests for convertClaudeAgentToDroidAgent.
//
// Behaviour pinned by docs.factory.ai/cli/configuration/droids:
//   - `tools` field must list CASE-SENSITIVE tool IDs; wildcards (`mcp__*__*`)
//     cause DroidValidator errors.
//   - `mcpServers` is an array of MCP server names whose tools are exposed
//     to the droid. Omitting = inherit parent-session MCP availability.
//   - `description` is optional but DroidValidator warns when missing;
//     500-char UI display cap per the doc.
//
// These tests protect the GSD agent → Factory droid conversion in the
// same harness as runtime-artifact-conversion-droid.test.cjs.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  convertClaudeAgentToDroidAgent,
  validateDroidFrontmatter,
  normalizeDroidName,
  FACTORY_DROID_TOOL_IDS,
} = require(
  path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-conversion.cjs'),
);

describe('runtime-artifact-conversion droid agent rewrite (R5)', () => {
  test('strips MCP wildcards from `tools:` and emits `mcpServers:` instead', () => {
    const input = [
      '---',
      'name: gsd-executor',
      'description: Executes GSD plans with atomic commits.',
      'tools: Read, Write, Edit, Bash, Grep, Glob, Skill, mcp__context7__*',
      '---',
      '',
      '# Body',
      'Use `mcp__context7__resolve-library-id` to look up library docs.',
    ].join('\n');
    const out = convertClaudeAgentToDroidAgent(input);
    const fmMatch = out.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'output must keep YAML frontmatter');
    const fm = fmMatch[1];

    assert.match(fm, /^name: gsd-executor$/m);
    assert.match(fm, /^mcpServers: \["context7"\]$/m);
    assert.doesNotMatch(fm, /\*$/m, 'no wildcard tokens left in tools array');

    // Tools array only contains Factory-valid IDs that were in source list.
    const toolsLine = fm.split('\n').find((l) => l.startsWith('tools:'));
    assert.match(toolsLine, /\["Read", "Edit", "Grep", "Glob"\]/);
    assert.doesNotMatch(toolsLine, /\bWrite\b|\bBash\b|\bSkill\b/, 'Claude-only tool IDs dropped');
  });

  test('drops multiple MCP wildcards to multiple mcpServers entries (deduped)', () => {
    const input = [
      '---',
      'name: gsd-phase-researcher',
      'description: Research helper',
      'tools: Read, mcp__context7__*, mcp__firecrawl__*, mcp__exa__*, mcp__tavily__*',
      '---',
    ].join('\n');
    const out = convertClaudeAgentToDroidAgent(input);
    const fmMatch = out.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch[1];
    assert.match(fm, /^mcpServers: \["context7", "firecrawl", "exa", "tavily"\]$/m);
  });

  test('scans body for mcp__<server>__ references and adds them to mcpServers even when not in tools:', () => {
    const input = [
      '---',
      'name: gsd-ui-auditor',
      'description: Visual audit',
      'tools: Read, Grep, Glob',
      '---',
      '',
      'Use `mcp__playwright__navigate(url="http://example.com")` to load the page.',
      'Take a screenshot via `mcp__playwright__screenshot(name="desktop", width=1440)`.',
    ].join('\n');
    const out = convertClaudeAgentToDroidAgent(input);
    const fmMatch = out.match(/^---\n([\s\S]*?)\n---/);
    const fm = fmMatch[1];
    assert.match(fm, /^mcpServers: \["playwright"\]$/m, 'playwright MCP server added from body scan');
  });

  test('truncates description to ≤500 chars per droid doc §"Frontmatter" (UI display cap)', () => {
    const long = 'A'.repeat(800);
    const input = `---\nname: gsd-huge\ndescription: ${long}\ntools: Read\n---`;
    const out = convertClaudeAgentToDroidAgent(input);
    const fm = out.match(/^---\n([\s\S]*?)\n---/)[1];
    const descLine = fm.split('\n').find((l) => l.startsWith('description:'));
    // Strip surrounding quotes; the actual string content must be ≤500 chars.
    const inner = descLine.slice('description:'.length).trim().replace(/^"|"$/g, '');
    assert.ok(inner.length <= 500, `description length ${inner.length} exceeded 500 cap`);
    assert.ok(inner.endsWith('...'), 'truncated description ends with ellipsis marker');
  });

  test('omits `tools:` line entirely when source has no Factory-valid tool IDs', () => {
    const input = [
      '---',
      'name: gsd-claude-only',
      'description: Only Claude tools',
      'tools: Write, Bash, Skill, AskUserQuestion, TodoWrite',
      '---',
    ].join('\n');
    const out = convertClaudeAgentToDroidAgent(input);
    const fm = out.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.doesNotMatch(fm, /^tools:/m, 'no tools line emitted when source has no Factory IDs');
    assert.doesNotMatch(fm, /^mcpServers:/m);
  });

  test('omits `description:` line when field is absent (still emits name: + valid YAML)', () => {
    const input = '---\nname: gsd-nodev\ntools: Read, Grep\n---\nbody';
    const out = convertClaudeAgentToDroidAgent(input);
    const fm = out.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, /^name: gsd-nodev$/m);
    assert.doesNotMatch(fm, /^description:/m);
    assert.match(fm, /^tools: \["Read", "Grep"\]$/m);
  });

  test('preserves verbatim body so prompt references to MCP tools remain readable by LLM', () => {
    const body = [
      '',
      'Check `gh` for issues.',
      '',
      'Use `mcp__linear__list_issues` to enumerate.',
    ].join('\n');
    const input = `---\nname: gsd-issue\ndescription: Issue helper\ntools: Read, mcp__linear__*\n---${body}`;
    const out = convertClaudeAgentToDroidAgent(input);
    assert.ok(out.endsWith(body), 'body must pass through unchanged');
    const fm = out.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, /^mcpServers: \["linear"\]$/m);
  });

  test('FACTORY_DROID_TOOL_IDS set is the closed Factory catalog (no Claude-only IDs leak)', () => {
    // Regression: the source tools whitelist must NOT include Claude-only IDs
    // (Write, Bash, Skill, NotebookEdit, AskUserQuestion, TodoWrite, Agent,
    // WebFetch). If any of these slip into the set, DroidValidator will reject
    // them on load.
    const banned = ['Write', 'Bash', 'Skill', 'NotebookEdit', 'AskUserQuestion', 'TodoWrite', 'Agent', 'WebFetch'];
    for (const id of banned) {
      assert.equal(
        FACTORY_DROID_TOOL_IDS.has(id),
        false,
        `${id} must NOT be in FACTORY_DROID_TOOL_IDS — Claude-only tool name would cause DroidValidator rejection`,
      );
    }
    // And confirms the documented Factory categories every category table in
    // the droid doc covers.
    const expected = ['Read', 'LS', 'Grep', 'Glob', 'Create', 'Edit', 'ApplyPatch', 'Execute', 'WebSearch', 'FetchUrl'];
    for (const id of expected) {
      assert.equal(FACTORY_DROID_TOOL_IDS.has(id), true, `${id} must be in FACTORY_DROID_TOOL_IDS (droid doc §"Tool categories")`);
    }
  });

  test('normalizes uppercase/spaced source name to Factory lowercase identifier', () => {
    const input = '---\nname: GSD Phase Researcher\ndescription: x\ntools: Read\n---\nbody';
    const out = convertClaudeAgentToDroidAgent(input);
    const fm = out.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, /^name: gsd-phase-researcher$/m);
  });

  test('collapses a multiline description into a single line before truncation', () => {
    const input = '---\nname: gsd-multi\ndescription: "line one\\nline two   with   spaces"\ntools: Read\n---\nbody';
    const out = convertClaudeAgentToDroidAgent(input);
    const fm = out.match(/^---\n([\s\S]*?)\n---/)[1];
    const descLine = fm.split('\n').find((l) => l.startsWith('description:'));
    assert.doesNotMatch(descLine, /\n/, 'description must be single-line');
    assert.doesNotMatch(descLine, /\s{2,}/, 'inner whitespace collapsed');
  });

  test('converter output round-trips clean through validateDroidFrontmatter', () => {
    const input = [
      '---',
      'name: GSD Executor',
      'description: Executes GSD plans.',
      'tools: Read, Write, Edit, Bash, Grep, Glob, mcp__context7__*',
      '---',
      '',
      '# Body',
    ].join('\n');
    const out = convertClaudeAgentToDroidAgent(input);
    const result = validateDroidFrontmatter(out);
    assert.equal(result.valid, true, `emitted droid must validate clean: ${result.errors.join('; ')}`);
    assert.deepEqual(result.errors, []);
  });
});

describe('validateDroidFrontmatter — DroidValidator-style schema check (R8)', () => {
  test('passes a fully-valid droid with all documented fields', () => {
    const md = [
      '---',
      'name: gsd-planner',
      'description: Creates executable phase plans.',
      'model: claude-sonnet-4-5-20250929',
      'reasoningEffort: high',
      'tools: ["Read", "Grep", "Glob"]',
      'mcpServers: ["context7"]',
      '---',
      'body',
    ].join('\n');
    const r = validateDroidFrontmatter(md);
    assert.equal(r.valid, true, r.errors.join('; '));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });

  test('flags missing frontmatter as an error', () => {
    const r = validateDroidFrontmatter('# just a body, no frontmatter');
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /missing YAML frontmatter/.test(e)));
  });

  test('requires name and rejects non-lowercase names', () => {
    const missing = validateDroidFrontmatter('---\ndescription: x\n---\nbody');
    assert.ok(missing.errors.some((e) => /`name` is required/.test(e)));

    const bad = validateDroidFrontmatter('---\nname: GSD_Planner\ndescription: x\n---\nbody');
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some((e) => /must be lowercase/.test(e)));
  });

  test('warns (not errors) when description is missing', () => {
    const r = validateDroidFrontmatter('---\nname: gsd-x\ntools: Read\n---\nbody');
    assert.equal(r.valid, true);
    assert.ok(r.warnings.some((w) => /`description` is recommended/.test(w)));
  });

  test('errors when description exceeds 500 chars', () => {
    const md = `---\nname: gsd-x\ndescription: ${'A'.repeat(501)}\n---\nbody`;
    const r = validateDroidFrontmatter(md);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /max 500/.test(e)));
  });

  test('accepts inherit / specific / custom model ids and rejects garbage', () => {
    for (const m of ['inherit', 'claude-sonnet-4-5-20250929', 'custom:gpt-4o-mini']) {
      const r = validateDroidFrontmatter(`---\nname: gsd-x\ndescription: y\nmodel: ${m}\n---\nb`);
      assert.equal(r.valid, true, `${m} should be valid: ${r.errors.join('; ')}`);
    }
    const bad = validateDroidFrontmatter('---\nname: gsd-x\ndescription: y\nmodel: "has spaces"\n---\nb');
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some((e) => /not a valid model identifier/.test(e)));
  });

  test('constrains reasoningEffort to low|medium|high', () => {
    const ok = validateDroidFrontmatter('---\nname: gsd-x\ndescription: y\nreasoningEffort: medium\n---\nb');
    assert.equal(ok.valid, true);
    const bad = validateDroidFrontmatter('---\nname: gsd-x\ndescription: y\nreasoningEffort: extreme\n---\nb');
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some((e) => /low\|medium\|high/.test(e)));
  });

  test('accepts tool categories and case-sensitive IDs, rejects wildcards and unknown IDs', () => {
    const cat = validateDroidFrontmatter('---\nname: gsd-x\ndescription: y\ntools: read-only, execute\n---\nb');
    assert.equal(cat.valid, true, cat.errors.join('; '));

    const wild = validateDroidFrontmatter('---\nname: gsd-x\ndescription: y\ntools: ["Read", "mcp__context7__*"]\n---\nb');
    assert.equal(wild.valid, false);
    assert.ok(wild.errors.some((e) => /wildcard/.test(e)));

    const unknown = validateDroidFrontmatter('---\nname: gsd-x\ndescription: y\ntools: Write, Bash\n---\nb');
    assert.equal(unknown.valid, false);
    assert.ok(unknown.errors.some((e) => /not a Factory tool category or case-sensitive tool ID/.test(e)));
  });

  test('rejects malformed mcpServers entries', () => {
    const bad = validateDroidFrontmatter('---\nname: gsd-x\ndescription: y\nmcpServers: ["good", "bad server!"]\n---\nb');
    assert.equal(bad.valid, false);
    assert.ok(bad.errors.some((e) => /not a valid server name/.test(e)));
  });

  test('normalizeDroidName falls back to gsd-droid when nothing valid remains', () => {
    assert.equal(normalizeDroidName('***'), 'gsd-droid');
    assert.equal(normalizeDroidName('  Hello World  '), 'hello-world');
    assert.equal(normalizeDroidName('already-fine_1'), 'already-fine_1');
  });
});
