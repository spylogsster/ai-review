/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 ai-review contributors
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseSubagentOutput,
  evaluateResults,
  resolveBinary,
  resolveCodexMacAppBinary,
  resolveCommandFromPath,
  logVerboseRunnerOutput,
  needsShellForBinary,
  buildSpawnOptions,
  buildPrompt,
  runReview,
  hasApiToken,
  checkPreflight,
  buildFallbackOrder,
  readLastUnavailable,
  writeLastUnavailable,
  clearLastUnavailable,
  extractTokenUsage,
  extractTokenUsageFromText,
} from '../src/review.ts';
import {
  buildAgentsContext,
  extractReferencedMarkdownFiles,
  buildReferencedMarkdownContext,
  resolvePromptHeaderLines,
  DEFAULT_PROMPT_HEADER_LINES,
  NO_POLICY_PROMPT_HEADER_LINES,
} from '../src/prompt.ts';
import { execFileSync } from 'node:child_process';

const PASS_RESULT = { status: 'pass', summary: 'No issues', findings: [] };
const FAIL_RESULT = { status: 'fail', summary: 'Bad code', findings: [{ severity: 'high', title: 'Bug', details: 'x', file: 'src/file.ts', line: 1 }] };
const PASS_WITH_FINDINGS = { status: 'pass', summary: 'Needs fixes', findings: [{ severity: 'low', title: 'Nit', details: 'y', file: 'src/file.ts', line: 2 }] };

test('parseSubagentOutput accepts valid payload', () => {
  const parsed = parseSubagentOutput(JSON.stringify(PASS_RESULT));
  assert.equal(parsed.status, 'pass');
  assert.equal(parsed.findings.length, 0);
});

test('parseSubagentOutput strips markdown fences', () => {
  const parsed = parseSubagentOutput('```json\n{"status":"pass","summary":"ok","findings":[]}\n```');
  assert.equal(parsed.status, 'pass');
});

test('parseSubagentOutput extracts JSON from surrounding text', () => {
  const parsed = parseSubagentOutput('Here is the review:\n{"status":"fail","summary":"issues found","findings":[]}\nDone.');
  assert.equal(parsed.status, 'fail');
});

test('parseSubagentOutput handles status keyword in string values', () => {
  const review = {
    status: 'fail',
    summary: 'Check the status of the build',
    findings: [{ severity: 'high', title: 'Bug', details: 'status field is wrong', file: 'a.ts', line: 1 }],
  };
  const parsed = parseSubagentOutput(JSON.stringify(review));
  assert.equal(parsed.status, 'fail');
  assert.equal(parsed.findings.length, 1);
  assert.ok(parsed.summary.includes('status'));
});

test('extractReferencedMarkdownFiles finds markdown references', () => {
  const files = extractReferencedMarkdownFiles('Read `BRANCHING.md` and deploy*.md and AGENTS.md');
  assert.deepEqual(files, ['BRANCHING.md', 'deploy*.md']);
});

test('buildReferencedMarkdownContext expands tracked wildcard references', () => {
  const blocks = buildReferencedMarkdownContext(
    ['deploy*.md', 'functions/DEPLOY.md'],
    ['deploy.prod.md', 'deploy.staging.md', 'functions/DEPLOY.md'],
    (file) => `CONTENT:${file}`,
  );

  assert.deepEqual(blocks, [
    '--- FILE: deploy.prod.md ---\nCONTENT:deploy.prod.md',
    '--- FILE: deploy.staging.md ---\nCONTENT:deploy.staging.md',
    '--- FILE: functions/DEPLOY.md ---\nCONTENT:functions/DEPLOY.md',
  ]);
});

test('evaluateResults blocks when all reviewers unavailable', () => {
  const verdict = evaluateResults({ available: false }, { available: false }, { available: false });
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reason.includes('unavailable'));
});

test('evaluateResults blocks pass status with findings', () => {
  const verdict = evaluateResults(
    { available: false },
    { available: true, result: PASS_RESULT },
    { available: true, result: PASS_WITH_FINDINGS },
  );
  assert.equal(verdict.pass, false);
});

test('evaluateResults passes when one available and clean', () => {
  const verdict = evaluateResults(
    { available: false },
    { available: true, result: PASS_RESULT },
    { available: false },
  );
  assert.equal(verdict.pass, true);
});

test('evaluateResults blocks explicit failure', () => {
  const verdict = evaluateResults(
    { available: false },
    { available: true, result: FAIL_RESULT },
    { available: false },
  );
  assert.equal(verdict.pass, false);
});

test('evaluateResults passes when Claude is the only available reviewer and clean', () => {
  const verdict = evaluateResults(
    { available: true, result: PASS_RESULT },
    { available: false },
    { available: false },
  );
  assert.equal(verdict.pass, true);
  assert.ok(verdict.reason.includes('Claude'));
});

test('evaluateResults blocks when Claude has findings', () => {
  const verdict = evaluateResults(
    { available: true, result: PASS_WITH_FINDINGS },
    { available: false },
    { available: false },
  );
  assert.equal(verdict.pass, false);
  assert.ok(verdict.reason.includes('Claude'));
});

test('evaluateResults reports all three reviewers when available', () => {
  const verdict = evaluateResults(
    { available: true, result: PASS_RESULT },
    { available: true, result: PASS_RESULT },
    { available: true, result: PASS_RESULT },
  );
  assert.equal(verdict.pass, true);
  assert.ok(verdict.reason.includes('Claude'));
  assert.ok(verdict.reason.includes('Codex'));
  assert.ok(verdict.reason.includes('Copilot'));
});


test('resolvePromptHeaderLines returns defaults when unset', () => {
  const lines = resolvePromptHeaderLines(undefined, true);
  assert.deepEqual(lines, [...DEFAULT_PROMPT_HEADER_LINES]);
});

test('resolvePromptHeaderLines accepts JSON array override', () => {
  const lines = resolvePromptHeaderLines('["Line A","Line B"]', true);
  assert.deepEqual(lines, ['Line A', 'Line B']);
});

test('resolvePromptHeaderLines accepts multiline override', () => {
  const lines = resolvePromptHeaderLines('Line A\nLine B', true);
  assert.deepEqual(lines, ['Line A', 'Line B']);
});

test('resolvePromptHeaderLines falls back to defaults for empty override', () => {
  const lines = resolvePromptHeaderLines('   ', true);
  assert.deepEqual(lines, [...DEFAULT_PROMPT_HEADER_LINES]);
});

test('resolvePromptHeaderLines falls back to defaults for empty JSON array', () => {
  const lines = resolvePromptHeaderLines('[]', true);
  assert.deepEqual(lines, [...DEFAULT_PROMPT_HEADER_LINES]);
});

test('resolvePromptHeaderLines returns no-policy defaults when there is no AGENTS.md', () => {
  const lines = resolvePromptHeaderLines(undefined, false);
  assert.deepEqual(lines, [...NO_POLICY_PROMPT_HEADER_LINES]);
  assert.ok(!lines[0].includes('AGENTS.md'));
});


test('resolveCodexMacAppBinary returns bundle executable on macOS when app exists', () => {
  const existing = new Set([
    '/Applications/Codex.app',
    '/Applications/Codex.app/Contents/Resources/codex',
  ]);

  const resolved = resolveCodexMacAppBinary('darwin', (path) => existing.has(path));
  assert.equal(resolved, '/Applications/Codex.app/Contents/Resources/codex');
});

test('needsShellForBinary returns true for .cmd and .bat files on win32', () => {
  assert.equal(needsShellForBinary('C:\\nvm4w\\nodejs\\codex.cmd', 'win32'), true);
  assert.equal(needsShellForBinary('codex.CMD', 'win32'), true);
  assert.equal(needsShellForBinary('C:\\tools\\codex.bat', 'win32'), true);
  assert.equal(needsShellForBinary('codex.BAT', 'win32'), true);
});

test('needsShellForBinary returns false for .exe files on win32', () => {
  assert.equal(needsShellForBinary('C:\\nvm4w\\nodejs\\node.exe', 'win32'), false);
});

test('needsShellForBinary returns false for .cmd/.bat files on non-win32', () => {
  assert.equal(needsShellForBinary('codex.cmd', 'darwin'), false);
  assert.equal(needsShellForBinary('codex.bat', 'linux'), false);
});

test('needsShellForBinary returns false for binaries without extension', () => {
  assert.equal(needsShellForBinary('/usr/local/bin/codex', 'win32'), false);
  assert.equal(needsShellForBinary('codex', 'linux'), false);
});

test('buildSpawnOptions sets detached=false on win32', () => {
  const opts = buildSpawnOptions('/tmp', {}, 'win32');
  assert.equal(opts.detached, false);
  assert.equal(opts.windowsHide, true);
});

test('buildSpawnOptions sets detached=true on linux', () => {
  const opts = buildSpawnOptions('/tmp', {}, 'linux');
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
});

test('buildSpawnOptions sets detached=true on darwin', () => {
  const opts = buildSpawnOptions('/tmp', {}, 'darwin');
  assert.equal(opts.detached, true);
});

test('resolveCommandFromPath resolves a known system command on the current platform', () => {
  // Use 'ls' on Unix, 'cmd' on Windows — always available in PATH regardless of shell profile
  const cmd = process.platform === 'win32' ? 'cmd' : 'ls';
  const result = resolveCommandFromPath(cmd);
  assert.ok(result !== null, `Expected "${cmd}" to be found via PATH`);
  if (process.platform === 'win32') {
    assert.ok(/\.(exe|cmd|bat)$/i.test(result), `Expected .exe/.cmd/.bat path on Windows, got: ${result}`);
  } else {
    assert.ok(result.startsWith('/'), `Expected absolute path on Unix, got: ${result}`);
  }
});

test('resolveCommandFromPath returns null for nonexistent command', () => {
  assert.equal(resolveCommandFromPath('nonexistent-cmd-xyz-9999'), null);
});

test('resolveCommandFromPath rejects candidates with shell metacharacters', () => {
  assert.equal(resolveCommandFromPath('$(whoami)'), null);
  assert.equal(resolveCommandFromPath('foo;rm -rf /'), null);
  assert.equal(resolveCommandFromPath('a b'), null);
  assert.equal(resolveCommandFromPath('cmd`id`'), null);
});

test('resolveCodexMacAppBinary returns null outside macOS', () => {
  const resolved = resolveCodexMacAppBinary('linux', () => true);
  assert.equal(resolved, null);
});

test('resolveBinary prefers env override over PATH and fallback', () => {
  const resolved = resolveBinary(
    'CODEX_BIN',
    ['codex'],
    {
      env: { CODEX_BIN: '/custom/codex' } as NodeJS.ProcessEnv,
      resolveFromPath: () => '/usr/local/bin/codex',
      resolveCodexFallback: () => '/Applications/Codex.app/Contents/Resources/codex',
    },
  );

  assert.equal(resolved, '/custom/codex');
});

test('resolveBinary prefers PATH before macOS fallback', () => {
  const resolved = resolveBinary(
    'CODEX_BIN',
    ['codex'],
    {
      env: {} as NodeJS.ProcessEnv,
      resolveFromPath: () => '/usr/local/bin/codex',
      resolveCodexFallback: () => '/Applications/Codex.app/Contents/Resources/codex',
    },
  );

  assert.equal(resolved, '/usr/local/bin/codex');
});

test('resolveBinary uses macOS fallback for CODEX_BIN when env and PATH are missing', () => {
  const resolved = resolveBinary(
    'CODEX_BIN',
    ['codex'],
    {
      env: {} as NodeJS.ProcessEnv,
      resolveFromPath: () => null,
      resolveCodexFallback: () => '/Applications/Codex.app/Contents/Resources/codex',
    },
  );

  assert.equal(resolved, '/Applications/Codex.app/Contents/Resources/codex');
});

test('runReview uses verbose branch and forwards verbose to reviewers', async () => {
  const logs: string[] = [];
  let claudeVerbose = false;
  let codexVerbose = false;
  let copilotVerbose = false;

  const result = await runReview(
    '/tmp/repo',
    { verbose: true },
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT_CONTENT',
      runClaude: (_prompt, verbose) => {
        claudeVerbose = verbose;
        return Promise.resolve({ available: false });
      },
      runCodex: (_prompt, verbose) => {
        codexVerbose = verbose;
        return Promise.resolve({ available: false });
      },
      runCopilot: (_prompt, verbose) => {
        copilotVerbose = verbose;
        return Promise.resolve({ available: false });
      },
      writeReport: () => {},
      log: (line) => {
        logs.push(line);
      },
    },
  );

  assert.equal(claudeVerbose, true);
  assert.equal(codexVerbose, true);
  assert.equal(copilotVerbose, true);
  assert.equal(result.pass, false);
  assert.ok(logs.includes('----- REVIEW PROMPT (FULL) -----'));
  assert.ok(logs.includes('PROMPT_CONTENT'));
});

test('runReview skips reviewers and alerts when diff is empty string', async () => {
  const logs: string[] = [];
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    {},
    {
      getStagedDiff: () => '',
      buildPrompt: () => 'PROMPT',
      runClaude: () => { claudeCalled = true; return Promise.resolve({ available: false }); },
      runCodex: () => { codexCalled = true; return Promise.resolve({ available: false }); },
      runCopilot: () => { copilotCalled = true; return Promise.resolve({ available: false }); },
      writeReport: () => {},
      log: (line) => { logs.push(line); },
    },
  );

  assert.equal(result.pass, true);
  assert.equal(result.reason, 'Empty diff.');
  assert.equal(claudeCalled, false);
  assert.equal(codexCalled, false);
  assert.equal(copilotCalled, false);
  assert.ok(logs.some((l) => l.includes('diff is empty')));
});

test('runReview skips reviewers and alerts when diff is whitespace-only', async () => {
  const logs: string[] = [];
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    {},
    {
      getStagedDiff: () => '   \n  \n  ',
      buildPrompt: () => 'PROMPT',
      runClaude: () => { claudeCalled = true; return Promise.resolve({ available: false }); },
      runCodex: () => { codexCalled = true; return Promise.resolve({ available: false }); },
      runCopilot: () => { copilotCalled = true; return Promise.resolve({ available: false }); },
      writeReport: () => {},
      log: (line) => { logs.push(line); },
    },
  );

  assert.equal(result.pass, true);
  assert.equal(result.reason, 'Empty diff.');
  assert.equal(claudeCalled, false);
  assert.equal(codexCalled, false);
  assert.equal(copilotCalled, false);
  assert.ok(logs.some((l) => l.includes('diff is empty')));
});

test('logVerboseRunnerOutput prints stdout, stderr, and response file', () => {
  const lines: string[] = [];
  logVerboseRunnerOutput(
    {
      model: 'Codex',
      stdout: 'out-data',
      stderr: 'err-data',
      responseFile: '{"status":"pass"}',
    },
    (msg) => lines.push(msg),
  );

  assert.ok(lines.some((l) => l.includes('CODEX STDOUT (RAW)')));
  assert.ok(lines.includes('out-data'));
  assert.ok(lines.some((l) => l.includes('CODEX STDERR (RAW)')));
  assert.ok(lines.includes('err-data'));
  assert.ok(lines.some((l) => l.includes('CODEX RESPONSE FILE (RAW)')));
  assert.ok(lines.includes('{"status":"pass"}'));
  assert.ok(lines.some((l) => l.includes('END CODEX RAW OUTPUT')));
});

test('runReview with reviewer=codex skips Claude and Copilot even when Codex is unavailable', async () => {
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    { reviewer: 'codex' },
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT',
      runClaude: () => {
        claudeCalled = true;
        return Promise.resolve({ available: false });
      },
      runCodex: () => {
        codexCalled = true;
        return Promise.resolve({ available: false });
      },
      runCopilot: () => {
        copilotCalled = true;
        return Promise.resolve({ available: false });
      },
      writeReport: () => {},
      log: () => {},
    },
  );

  assert.equal(claudeCalled, false);
  assert.equal(codexCalled, true);
  assert.equal(copilotCalled, false);
  assert.equal(result.pass, false);
});

test('runReview with reviewer=copilot skips Claude and Codex', async () => {
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    { reviewer: 'copilot' },
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT',
      runClaude: () => {
        claudeCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      runCodex: () => {
        codexCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      runCopilot: () => {
        copilotCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      writeReport: () => {},
      log: () => {},
    },
  );

  assert.equal(claudeCalled, false);
  assert.equal(codexCalled, false);
  assert.equal(copilotCalled, true);
  assert.equal(result.pass, true);
});

test('runReview without reviewer uses default Codex-first fallback chain', async () => {
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    {},
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT',
      runClaude: () => {
        claudeCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      runCodex: () => {
        codexCalled = true;
        return Promise.resolve({ available: false });
      },
      runCopilot: () => {
        copilotCalled = true;
        return Promise.resolve({ available: false });
      },
      writeReport: () => {},
      log: () => {},
    },
  );

  assert.equal(codexCalled, true);
  assert.equal(copilotCalled, true);
  assert.equal(claudeCalled, true);
  assert.equal(result.pass, true);
});

test('runReview default chain stops at Copilot when Codex unavailable', async () => {
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    {},
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT',
      runClaude: () => {
        claudeCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      runCodex: () => {
        codexCalled = true;
        return Promise.resolve({ available: false });
      },
      runCopilot: () => {
        copilotCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      writeReport: () => {},
      log: () => {},
    },
  );

  assert.equal(codexCalled, true);
  assert.equal(copilotCalled, true);
  assert.equal(claudeCalled, false);
  assert.equal(result.pass, true);
});

test('runReview default chain stops at Codex when available', async () => {
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    {},
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT',
      runClaude: () => {
        claudeCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      runCodex: () => {
        codexCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      runCopilot: () => {
        copilotCalled = true;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      writeReport: () => {},
      log: () => {},
    },
  );

  assert.equal(codexCalled, true);
  assert.equal(copilotCalled, false);
  assert.equal(claudeCalled, false);
  assert.equal(result.pass, true);
});

test('runReview with reviewer=claude forces Claude only (no fallback)', async () => {
  let claudeCalled = false;
  let codexCalled = false;
  let copilotCalled = false;

  const result = await runReview(
    '/tmp/repo',
    { reviewer: 'claude' },
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT',
      runClaude: () => {
        claudeCalled = true;
        return Promise.resolve({ available: false });
      },
      runCodex: () => {
        codexCalled = true;
        return Promise.resolve({ available: false });
      },
      runCopilot: () => {
        copilotCalled = true;
        return Promise.resolve({ available: false });
      },
      writeReport: () => {},
      log: () => {},
    },
  );

  assert.equal(claudeCalled, true);
  assert.equal(codexCalled, false);
  assert.equal(copilotCalled, false);
  assert.equal(result.pass, false);
});

test('logVerboseRunnerOutput omits response file section when not provided', () => {
  const lines: string[] = [];
  logVerboseRunnerOutput(
    { model: 'Copilot', stdout: 'ok', stderr: '' },
    (msg) => lines.push(msg),
  );

  assert.ok(lines.some((l) => l.includes('COPILOT STDOUT (RAW)')));
  assert.ok(!lines.some((l) => l.includes('RESPONSE FILE')));
  assert.ok(lines.some((l) => l.includes('END COPILOT RAW OUTPUT')));
});

test('hasApiToken returns true when env var is set', () => {
  assert.equal(hasApiToken('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'sk-ant-123' } as NodeJS.ProcessEnv), true);
});

test('hasApiToken returns false when env var is not set', () => {
  assert.equal(hasApiToken('ANTHROPIC_API_KEY', {} as NodeJS.ProcessEnv), false);
});

test('hasApiToken returns false for empty string', () => {
  assert.equal(hasApiToken('OPENAI_API_KEY', { OPENAI_API_KEY: '' } as NodeJS.ProcessEnv), false);
});

test('hasApiToken returns false for whitespace-only value', () => {
  assert.equal(hasApiToken('GITHUB_TOKEN', { GITHUB_TOKEN: '   ' } as NodeJS.ProcessEnv), false);
});

test('hasApiToken detects OPENAI_API_KEY', () => {
  assert.equal(hasApiToken('OPENAI_API_KEY', { OPENAI_API_KEY: 'sk-openai-xyz' } as NodeJS.ProcessEnv), true);
});

test('hasApiToken detects GITHUB_TOKEN', () => {
  assert.equal(hasApiToken('GITHUB_TOKEN', { GITHUB_TOKEN: 'ghp_abc123' } as NodeJS.ProcessEnv), true);
});

test('checkPreflight returns true when API token is set (skips network)', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  try {
    const reachCalled: string[] = [];
    const result = checkPreflight('Claude', 'ANTHROPIC_API_KEY', ['https://api.anthropic.com'], false, (url) => {
      reachCalled.push(url);
      return false;
    });
    assert.equal(result, true);
    assert.equal(reachCalled.length, 0, 'canReach should not be called when token is set');
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('checkPreflight falls back to canReach when no token is set', () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const reachCalled: string[] = [];
    const result = checkPreflight('Codex', 'OPENAI_API_KEY', ['https://api.openai.com/v1/models', 'https://chatgpt.com'], false, (url) => {
      reachCalled.push(url);
      return url === 'https://chatgpt.com';
    });
    assert.equal(result, true);
    assert.ok(reachCalled.length > 0, 'canReach should be called when no token is set');
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
});

test('checkPreflight returns false when no token and canReach fails', () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const result = checkPreflight('Copilot', 'GITHUB_TOKEN', ['https://api.github.com'], false, () => false);
    assert.equal(result, false);
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('buildPrompt uses custom diffLabel when provided', () => {
  const tempDir = createTempGitRepo();
  writeFileSync(join(tempDir, 'AGENTS.md'), '# Test agents', 'utf8');
  try {
    const prompt = buildPrompt('some diff content', tempDir, 'Branch diff (main...feature)');
    assert.ok(prompt.includes('Branch diff (main...feature):'));
    assert.ok(!prompt.includes('Staged diff:'));
    assert.ok(prompt.includes('some diff content'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildPrompt uses default Staged diff label when no diffLabel provided', () => {
  const tempDir = createTempGitRepo();
  writeFileSync(join(tempDir, 'AGENTS.md'), '# Test agents', 'utf8');
  try {
    const prompt = buildPrompt('some diff content', tempDir);
    assert.ok(prompt.includes('Staged diff:'));
    assert.ok(prompt.includes('some diff content'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-review-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

test('buildAgentsContext returns empty context when AGENTS.md is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  try {
    assert.deepEqual(buildAgentsContext(tempDir), { agents: '', referenced: [] });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildAgentsContext lists tracked markdown from the given cwd, not process.cwd()', () => {
  const repo = createTempGitRepo();
  writeFileSync(join(repo, 'AGENTS.md'), 'See `BAR.md`', 'utf8');
  writeFileSync(join(repo, 'BAR.md'), '# Bar rules', 'utf8');
  execFileSync('git', ['add', 'AGENTS.md', 'BAR.md'], { cwd: repo });
  try {
    const context = buildAgentsContext(repo);
    assert.equal(context.referenced.length, 1);
    assert.ok(context.referenced[0].includes('--- FILE: BAR.md ---'));
    assert.ok(context.referenced[0].includes('# Bar rules'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('buildPrompt omits the AGENTS.md section and uses the no-policy header when AGENTS.md is missing', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  try {
    const prompt = buildPrompt('diff --git a/x b/x\n+hi', tempDir);
    assert.ok(!prompt.includes('Here is the full AGENTS.md for reference'));
    assert.ok(prompt.includes(NO_POLICY_PROMPT_HEADER_LINES[0]));
    assert.ok(!prompt.includes(DEFAULT_PROMPT_HEADER_LINES[0]));
    assert.ok(prompt.includes('Respond with ONLY a JSON object'));
    assert.ok(prompt.includes('diff --git a/x b/x'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildPrompt keeps the AGENTS.md section and header when AGENTS.md exists', () => {
  const tempDir = createTempGitRepo();
  writeFileSync(join(tempDir, 'AGENTS.md'), '# Test agents', 'utf8');
  try {
    const prompt = buildPrompt('some diff content', tempDir);
    assert.ok(prompt.includes('Here is the full AGENTS.md for reference:'));
    assert.ok(prompt.includes('# Test agents'));
    assert.ok(prompt.includes(DEFAULT_PROMPT_HEADER_LINES[0]));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildFallbackOrder returns default order when no last unavailable', () => {
  assert.deepEqual(buildFallbackOrder(null), ['codex', 'copilot', 'claude']);
  assert.deepEqual(buildFallbackOrder(''), ['codex', 'copilot', 'claude']);
  assert.deepEqual(buildFallbackOrder('unknown'), ['codex', 'copilot', 'claude']);
});

test('buildFallbackOrder rotates codex to end', () => {
  assert.deepEqual(buildFallbackOrder('codex'), ['copilot', 'claude', 'codex']);
});

test('buildFallbackOrder rotates copilot to end', () => {
  assert.deepEqual(buildFallbackOrder('copilot'), ['codex', 'claude', 'copilot']);
});

test('buildFallbackOrder rotates claude to end', () => {
  assert.deepEqual(buildFallbackOrder('claude'), ['codex', 'copilot', 'claude']);
});

test('readLastUnavailable returns null when file does not exist', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  try {
    assert.equal(readLastUnavailable(tempDir), null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('writeLastUnavailable and readLastUnavailable round-trip', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  mkdirSync(join(tempDir, '.git'), { recursive: true });
  try {
    writeLastUnavailable(tempDir, 'codex');
    assert.equal(readLastUnavailable(tempDir), 'codex');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('clearLastUnavailable removes the file', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  mkdirSync(join(tempDir, '.git'), { recursive: true });
  try {
    writeLastUnavailable(tempDir, 'copilot');
    assert.equal(readLastUnavailable(tempDir), 'copilot');
    clearLastUnavailable(tempDir);
    assert.equal(readLastUnavailable(tempDir), null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runReview default fallback rotates based on last-unavailable file', async () => {
  const callOrder: string[] = [];
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  mkdirSync(join(tempDir, '.git'), { recursive: true });

  // Write codex as last unavailable
  writeLastUnavailable(tempDir, 'codex');

  try {
    await runReview(
      tempDir,
      {},
      {
        getStagedDiff: () => 'diff --cached',
        buildPrompt: () => 'PROMPT',
        runClaude: () => {
          callOrder.push('claude');
          return Promise.resolve({ available: false });
        },
        runCodex: () => {
          callOrder.push('codex');
          return Promise.resolve({ available: false });
        },
        runCopilot: () => {
          callOrder.push('copilot');
          return Promise.resolve({ available: true, result: PASS_RESULT });
        },
        writeReport: () => {},
        log: () => {},
      },
    );

    // Copilot should be tried first (codex rotated to end)
    assert.equal(callOrder[0], 'copilot');
    assert.equal(callOrder.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runReview preserves last-unavailable state when rotated reviewer is not retried', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  mkdirSync(join(tempDir, '.git'), { recursive: true });

  // Simulate: codex was unavailable last run, so it's rotated to end
  writeLastUnavailable(tempDir, 'codex');

  try {
    // Run 1: copilot is first (due to rotation) and succeeds immediately — codex is never tried
    await runReview(
      tempDir,
      {},
      {
        getStagedDiff: () => 'diff --cached',
        buildPrompt: () => 'PROMPT',
        runClaude: () => Promise.resolve({ available: false }),
        runCodex: () => Promise.resolve({ available: false }),
        runCopilot: () => Promise.resolve({ available: true, result: PASS_RESULT }),
        writeReport: () => {},
        log: () => {},
      },
    );

    // State should be preserved because codex was never retried
    assert.equal(readLastUnavailable(tempDir), 'codex',
      'last-unavailable state should persist when the rotated reviewer was not retried');

    // Run 2: copilot should still be first (rotation preserved)
    const callOrder: string[] = [];
    await runReview(
      tempDir,
      {},
      {
        getStagedDiff: () => 'diff --cached',
        buildPrompt: () => 'PROMPT',
        runClaude: () => { callOrder.push('claude'); return Promise.resolve({ available: false }); },
        runCodex: () => { callOrder.push('codex'); return Promise.resolve({ available: false }); },
        runCopilot: () => { callOrder.push('copilot'); return Promise.resolve({ available: true, result: PASS_RESULT }); },
        writeReport: () => {},
        log: () => {},
      },
    );

    assert.equal(callOrder[0], 'copilot', 'copilot should still be first on consecutive runs');
    assert.equal(callOrder.length, 1, 'should stop after first available reviewer');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runReview updates last-unavailable to new first failure when rotated reviewer succeeds', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-test-'));
  mkdirSync(join(tempDir, '.git'), { recursive: true });

  // codex was last unavailable → order becomes ['copilot', 'claude', 'codex']
  writeLastUnavailable(tempDir, 'codex');

  try {
    // copilot and claude fail, codex (rotated to end) succeeds
    await runReview(
      tempDir,
      {},
      {
        getStagedDiff: () => 'diff --cached',
        buildPrompt: () => 'PROMPT',
        runClaude: () => Promise.resolve({ available: false }),
        runCopilot: () => Promise.resolve({ available: false }),
        runCodex: () => Promise.resolve({ available: true, result: PASS_RESULT }),
        writeReport: () => {},
        log: () => {},
      },
    );

    // State should now reflect copilot as the first unavailable (not codex anymore)
    assert.equal(readLastUnavailable(tempDir), 'copilot',
      'last-unavailable state should update to the new first failure');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runReview with explicit reviewer passes skipPreflight=true to runner', async () => {
  const preflightArgs: Record<string, boolean | undefined> = {};

  const makeDeps = (reviewer: 'claude' | 'codex' | 'copilot') => ({
    getStagedDiff: () => 'diff --cached',
    buildPrompt: () => 'PROMPT',
    runClaude: (_p: string, _v: boolean, skip?: boolean) => {
      preflightArgs.claude = skip;
      return Promise.resolve({ available: true, result: PASS_RESULT } as const);
    },
    runCodex: (_p: string, _v: boolean, skip?: boolean) => {
      preflightArgs.codex = skip;
      return Promise.resolve({ available: true, result: PASS_RESULT } as const);
    },
    runCopilot: (_p: string, _v: boolean, skip?: boolean) => {
      preflightArgs.copilot = skip;
      return Promise.resolve({ available: true, result: PASS_RESULT } as const);
    },
    writeReport: () => {},
    log: () => {},
  });

  preflightArgs.claude = undefined;
  await runReview('/tmp/repo', { reviewer: 'claude' }, makeDeps('claude'));
  assert.equal(preflightArgs.claude, true, '--claude should pass skipPreflight=true');

  preflightArgs.codex = undefined;
  await runReview('/tmp/repo', { reviewer: 'codex' }, makeDeps('codex'));
  assert.equal(preflightArgs.codex, true, '--codex should pass skipPreflight=true');

  preflightArgs.copilot = undefined;
  await runReview('/tmp/repo', { reviewer: 'copilot' }, makeDeps('copilot'));
  assert.equal(preflightArgs.copilot, true, '--copilot should pass skipPreflight=true');
});

test('runReview default fallback does not pass skipPreflight to runners', async () => {
  const preflightArgs: Record<string, boolean | undefined> = {};

  await runReview(
    '/tmp/repo',
    {},
    {
      getStagedDiff: () => 'diff --cached',
      buildPrompt: () => 'PROMPT',
      runClaude: (_p, _v, skip) => {
        preflightArgs.claude = skip;
        return Promise.resolve({ available: true, result: PASS_RESULT });
      },
      runCodex: (_p, _v, skip) => {
        preflightArgs.codex = skip;
        return Promise.resolve({ available: false });
      },
      runCopilot: (_p, _v, skip) => {
        preflightArgs.copilot = skip;
        return Promise.resolve({ available: false });
      },
      writeReport: () => {},
      log: () => {},
    },
  );

  assert.equal(preflightArgs.codex, undefined, 'default chain should not pass skipPreflight');
  assert.equal(preflightArgs.copilot, undefined, 'default chain should not pass skipPreflight');
  assert.equal(preflightArgs.claude, undefined, 'default chain should not pass skipPreflight');
});

test('checkPreflight logs token usage only in verbose mode', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  const originalLog = console.log;
  try {
    // Non-verbose: console.log should NOT be called with token message
    const nonVerboseLogs: string[] = [];
    console.log = (...args: unknown[]) => { nonVerboseLogs.push(args.join(' ')); };
    const result = checkPreflight('Claude', 'ANTHROPIC_API_KEY', ['https://api.anthropic.com'], false, () => false);
    assert.equal(result, true);
    assert.ok(!nonVerboseLogs.some((l) => l.includes('API token')), 'Should not log token message in non-verbose mode');

    // Verbose: console.log SHOULD be called with token message
    const verboseLogs: string[] = [];
    console.log = (...args: unknown[]) => { verboseLogs.push(args.join(' ')); };
    const resultVerbose = checkPreflight('Claude', 'ANTHROPIC_API_KEY', ['https://api.anthropic.com'], true, () => false);
    assert.equal(resultVerbose, true);
    assert.ok(verboseLogs.some((l) => l.includes('API token') && l.includes('ANTHROPIC_API_KEY')), 'Should log token message in verbose mode');
  } finally {
    console.log = originalLog;
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('extractTokenUsage extracts valid usage object', () => {
  const usage = extractTokenUsage({ input_tokens: 100, output_tokens: 50 });
  assert.deepEqual(usage, { input_tokens: 100, output_tokens: 50 });
});

test('extractTokenUsage returns undefined for null/undefined/non-object', () => {
  assert.equal(extractTokenUsage(null), undefined);
  assert.equal(extractTokenUsage(undefined), undefined);
  assert.equal(extractTokenUsage('string'), undefined);
  assert.equal(extractTokenUsage(42), undefined);
});

test('extractTokenUsage returns undefined when no numeric token fields', () => {
  assert.equal(extractTokenUsage({ input_tokens: 'not a number' }), undefined);
  assert.equal(extractTokenUsage({}), undefined);
});

test('extractTokenUsage handles partial usage (only input)', () => {
  const usage = extractTokenUsage({ input_tokens: 200 });
  assert.deepEqual(usage, { input_tokens: 200, output_tokens: undefined });
});

test('extractTokenUsage handles partial usage (only output)', () => {
  const usage = extractTokenUsage({ output_tokens: 75 });
  assert.deepEqual(usage, { input_tokens: undefined, output_tokens: 75 });
});

test('extractTokenUsageFromText extracts from JSON fragment', () => {
  const text = 'some log\n{"input_tokens": 500, "output_tokens": 120}\nmore log';
  const usage = extractTokenUsageFromText(text);
  assert.deepEqual(usage, { input_tokens: 500, output_tokens: 120 });
});

test('extractTokenUsageFromText returns undefined for text without token data', () => {
  assert.equal(extractTokenUsageFromText('no tokens here'), undefined);
  assert.equal(extractTokenUsageFromText(''), undefined);
});

test('extractTokenUsageFromText does not combine matches from separate objects', () => {
  const text = '{"input_tokens": 100}\n{"output_tokens": 200}';
  assert.equal(extractTokenUsageFromText(text), undefined);
});
