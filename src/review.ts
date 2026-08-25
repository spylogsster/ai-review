/* SPDX-License-Identifier: MPL-2.0
 * Copyright (c) 2026 ai-review contributors
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REVIEW_SCHEMA } from './schema.js';
import type { ParsedReview, ReviewReport, ReviewRunnerResult, TokenUsage } from './types.js';
import { buildAgentsContext, resolvePromptHeaderLines } from './prompt.js';
import { getGitPath, git } from './git.js';

const COPILOT_MODEL = process.env.COPILOT_REVIEW_MODEL || 'gpt-5.3-codex';
const TIMEOUT_MS = Number(process.env.AI_REVIEW_TIMEOUT_MS || 300000);
const PREFLIGHT_TIMEOUT_SEC = Number(process.env.AI_REVIEW_PREFLIGHT_TIMEOUT_SEC || 8);

export type ReviewerName = 'codex' | 'copilot' | 'claude';
const DEFAULT_FALLBACK_ORDER: ReadonlyArray<ReviewerName> = ['codex', 'copilot', 'claude'];

export function buildFallbackOrder(lastUnavailable: string | null): ReviewerName[] {
  if (!lastUnavailable || !DEFAULT_FALLBACK_ORDER.includes(lastUnavailable as ReviewerName)) {
    return [...DEFAULT_FALLBACK_ORDER];
  }
  const order = DEFAULT_FALLBACK_ORDER.filter((r) => r !== lastUnavailable);
  order.push(lastUnavailable as ReviewerName);
  return order;
}

export function readLastUnavailable(cwd: string): string | null {
  try {
    const filePath = resolve(cwd, getGitPath('ai-review-last-unavailable'));
    if (!existsSync(filePath)) return null;
    const value = readFileSync(filePath, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export function writeLastUnavailable(cwd: string, reviewer: string): void {
  const filePath = resolve(cwd, getGitPath('ai-review-last-unavailable'));
  try {
    writeFileSync(filePath, reviewer, 'utf8');
  } catch {
    console.error(`Warning: could not write last-unavailable state to ${filePath}`);
  }
}

export function clearLastUnavailable(cwd: string): void {
  const filePath = resolve(cwd, getGitPath('ai-review-last-unavailable'));
  try {
    rmSync(filePath, { force: true });
  } catch {
    console.error(`Warning: could not clear last-unavailable state at ${filePath}`);
  }
}

export interface RunReviewOptions {
  verbose?: boolean;
  reviewer?: 'claude' | 'codex' | 'copilot';
  allReviewers?: boolean;
}

export interface RunReviewDeps {
  getStagedDiff: () => string;
  buildPrompt: (diff: string, cwd: string) => string;
  runClaude: (prompt: string, verbose: boolean, skipPreflight?: boolean) => Promise<ReviewRunnerResult>;
  runCodex: (prompt: string, verbose: boolean, skipPreflight?: boolean) => Promise<ReviewRunnerResult>;
  runCopilot: (prompt: string, verbose: boolean, skipPreflight?: boolean) => Promise<ReviewRunnerResult>;
  writeReport: (reportPath: string, report: ReviewReport) => void;
  log: (message: string) => void;
}

export interface VerboseRunnerOutput {
  model: string;
  stdout: string;
  stderr: string;
  responseFile?: string;
}

export function logVerboseRunnerOutput(
  output: VerboseRunnerOutput,
  log: (message: string) => void = console.log,
): void {
  const label = output.model.toUpperCase();
  log(`\n----- ${label} STDOUT (RAW) -----`);
  log(output.stdout || '');
  log(`----- ${label} STDERR (RAW) -----`);
  log(output.stderr || '');
  if (output.responseFile !== undefined) {
    log(`----- ${label} RESPONSE FILE (RAW) -----`);
    log(output.responseFile);
  }
  log(`----- END ${label} RAW OUTPUT -----\n`);
}

export function needsShellForBinary(binary: string, osPlatform = process.platform): boolean {
  return osPlatform === 'win32' && /\.(cmd|bat)$/i.test(binary);
}

function canReach(url: string): boolean {
  try {
    const out = execFileSync(
      'curl',
      ['-I', '--max-time', String(PREFLIGHT_TIMEOUT_SEC), '-sS', url],
      { encoding: 'utf8' },
    );
    return /HTTP\/[0-9.]+\s+\d{3}/i.test(out);
  } catch {
    return false;
  }
}

export function hasApiToken(envVarName: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[envVarName]?.trim());
}

export function checkPreflight(
  name: string,
  tokenEnvVar: string,
  urls: string[],
  verbose: boolean,
  reach: (url: string) => boolean = canReach,
): boolean {
  if (hasApiToken(tokenEnvVar)) {
    if (verbose) console.log(`${name}: using API token (${tokenEnvVar}) — skipping network preflight.`);
    return true;
  }
  if (urls.some(reach)) return true;
  console.error(`${name}: network preflight failed — skipping.`);
  return false;
}

export function resolveCommandFromPath(candidate: string): string | null {
  if (!/^[a-zA-Z0-9_./-]+$/.test(candidate)) {
    return null;
  }
  try {
    if (process.platform === 'win32') {
      const lines = execFileSync('where', [candidate], { encoding: 'utf8', stdio: 'pipe' })
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const exe = lines.find((l) => /\.(exe|cmd|bat)$/i.test(l));
      return exe || lines[0] || null;
    }
    const path = execFileSync('sh', ['-lc', `command -v ${candidate}`], { encoding: 'utf8' }).trim();
    return path || null;
  } catch {
    return null;
  }
}

export function resolveCodexMacAppBinary(
  osPlatform = platform(),
  pathExists: (path: string) => boolean = existsSync,
): string | null {
  if (osPlatform !== 'darwin' || !pathExists('/Applications/Codex.app')) {
    return null;
  }

  const bundleCandidates = [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/Codex',
  ];

  for (const candidate of bundleCandidates) {
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export interface ResolveBinaryOptions {
  env?: NodeJS.ProcessEnv;
  resolveFromPath?: (candidate: string) => string | null;
  resolveCodexFallback?: () => string | null;
}

export function resolveBinary(
  envName: string,
  candidates: string[],
  options: ResolveBinaryOptions = {},
): string | null {
  const env = options.env ?? process.env;
  const resolveFromPath = options.resolveFromPath ?? resolveCommandFromPath;
  const resolveCodexFallback = options.resolveCodexFallback ?? resolveCodexMacAppBinary;

  const envBinary = env[envName]?.trim();
  if (envBinary) {
    return envBinary;
  }

  for (const candidate of candidates) {
    const path = resolveFromPath(candidate);
    if (path) {
      return path;
    }
  }

  if (envName === 'CODEX_BIN') {
    const codexAppBinary = resolveCodexFallback();
    if (codexAppBinary) {
      return codexAppBinary;
    }
  }

  return null;
}

function getStagedDiff(): string {
  return git(['diff', '--cached', '--no-color']);
}

export function buildPrompt(diff: string, cwd = process.cwd(), diffLabel = 'Staged diff'): string {
  const context = buildAgentsContext(cwd);
  return [
    ...resolvePromptHeaderLines(process.env.AI_REVIEW_PROMPT_HEADER, Boolean(context.agents)),
    ...(context.agents
      ? ['', 'Here is the full AGENTS.md for reference:', context.agents]
      : []),
    ...(context.referenced.length > 0
      ? [
        '',
        'Additional markdown files referenced by AGENTS.md (full contents):',
        ...context.referenced,
      ]
      : []),
    '',
    'Respond with ONLY a JSON object matching this schema (no markdown, no backticks, no explanation):',
    JSON.stringify(REVIEW_SCHEMA, null, 2),
    '',
    `${diffLabel}:`,
    diff,
  ].join('\n');
}

function validateParsedReview(parsed: unknown): ParsedReview {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Subagent output is not a JSON object.');
  }
  if (!['pass', 'fail'].includes((parsed as ParsedReview).status)) {
    throw new Error('Subagent output has an invalid status.');
  }
  if (!Array.isArray((parsed as ParsedReview).findings)) {
    throw new Error('Subagent output has an invalid findings list.');
  }
  return parsed as ParsedReview;
}

export function extractTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === 'number' ? u.input_tokens : undefined;
  const output = typeof u.output_tokens === 'number' ? u.output_tokens : undefined;
  if (input === undefined && output === undefined) return undefined;
  return { input_tokens: input, output_tokens: output };
}

export function extractTokenUsageFromText(text: string): TokenUsage | undefined {
  // Find a JSON object that contains both input_tokens and output_tokens as siblings
  const objectPattern = /\{[^{}]*"input_tokens"\s*:\s*(\d+)[^{}]*"output_tokens"\s*:\s*(\d+)[^{}]*\}/;
  const match = text.match(objectPattern);
  if (!match) return undefined;
  return { input_tokens: Number(match[1]), output_tokens: Number(match[2]) };
}

export function parseSubagentOutput(raw: string): ParsedReview {
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    throw new Error('Subagent returned an empty response.');
  }

  let cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  // Try direct parse first (handles clean JSON without extraction)
  try {
    return validateParsedReview(JSON.parse(cleaned));
  } catch {
    // not valid or not a review — try extraction
  }

  // Extract JSON object from surrounding text
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
  }

  return validateParsedReview(JSON.parse(cleaned));
}

export function buildSpawnOptions(
  cwd: string,
  env: Record<string, string>,
  osPlatform = process.platform,
): { cwd: string; env: Record<string, string>; stdio: ['pipe', 'pipe', 'pipe']; detached: boolean; windowsHide: boolean } {
  return {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: osPlatform !== 'win32',
    windowsHide: true,
  };
}

function spawnClaude(
  bin: string,
  args: string[],
  prompt: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, buildSpawnOptions(cwd, env));

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, 'SIGTERM');
          } else {
            child.kill();
          }
        } catch { /* ignore */ }
        reject(new Error(`spawn ${bin} ETIMEDOUT`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('error', (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    child.on('close', (code: number | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      }
    });

    child.stdin.on('error', () => { /* EPIPE if child exits before consuming stdin */ });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function runClaude(prompt: string, verbose: boolean, skipPreflight = false): Promise<ReviewRunnerResult> {
  const claude = resolveBinary('CLAUDE_BIN', ['claude']);
  if (!claude) {
    console.error('Claude: binary not found in PATH (or CLAUDE_BIN not set) — skipping.');
    return { available: false };
  }

  if (!skipPreflight && !checkPreflight('Claude', 'ANTHROPIC_API_KEY', ['https://api.anthropic.com'], verbose)) {
    return { available: false };
  }

  try {
    const claudeArgs = [
      '--print',
      '--output-format', 'json',
      '--no-session-persistence',
      '--allowedTools', '',
    ];

    if (verbose) {
      console.log(claude, claudeArgs.join(' '), '< <prompt via stdin>');
    }

    const CLAUDE_ENV_ALLOWLIST = new Set(['CLAUDE_BIN', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN']);
    const cleanEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      const upperKey = key.toUpperCase();
      if (val !== undefined && !(upperKey.startsWith('CLAUDE') && !CLAUDE_ENV_ALLOWLIST.has(upperKey))) {
        cleanEnv[key] = val;
      }
    }

    const { stdout, stderr, exitCode } = await spawnClaude(
      claude, claudeArgs, prompt, cleanEnv, process.cwd(), TIMEOUT_MS,
    );

    if (verbose) {
      logVerboseRunnerOutput({ model: 'Claude', stdout, stderr });
    }

    if (exitCode !== 0) {
      const err = stderr.trim() || stdout.trim();
      console.error(`Claude: execution failed${err ? `: ${err}` : ''} — skipping.`);
      return { available: false };
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      console.error('Claude: empty response — skipping.');
      return { available: false };
    }

    let reviewPayload = trimmed;
    let usage: TokenUsage | undefined;
    try {
      const envelope = JSON.parse(trimmed);
      if (envelope && typeof envelope === 'object' && typeof envelope.result === 'string') {
        reviewPayload = envelope.result;
        usage = extractTokenUsage(envelope.usage);
      }
    } catch {
      // not an envelope — use raw output
    }

    return { available: true, result: parseSubagentOutput(reviewPayload), usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Claude: ${message} — skipping.`);
    return { available: false };
  }
}

function runCodex(prompt: string, verbose: boolean, skipPreflight = false): ReviewRunnerResult {
  const codex = resolveBinary('CODEX_BIN', ['codex']);
  if (!codex) {
    console.error('Codex: binary not found in PATH (or CODEX_BIN not set) — skipping.');
    return { available: false };
  }

  if (!skipPreflight && !checkPreflight('Codex', 'OPENAI_API_KEY', ['https://api.openai.com/v1/models', 'https://chatgpt.com'], verbose)) {
    return { available: false };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'ai-review-codex-'));
  const promptPath = join(tempDir, 'prompt.txt');
  const schemaPath = join(tempDir, 'schema.json');
  const resultPath = join(tempDir, 'result.json');
  writeFileSync(promptPath, prompt, 'utf8');
  writeFileSync(schemaPath, JSON.stringify(REVIEW_SCHEMA, null, 2), 'utf8');

  try {
    const codexCommand = [
        'exec',
        '--ephemeral',
        '--sandbox', 'read-only',
        '--output-schema', schemaPath,
        '--output-last-message', resultPath,
        '-'
    ];

    if (verbose) {
      console.log(codex, codexCommand.join(' '))
    }
    const run = spawnSync(
      codex,
      codexCommand,
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        input: readFileSync(promptPath, 'utf8'),
        ...(needsShellForBinary(codex) ? { shell: true } : {}),
      },
    );

    if (verbose) {
      logVerboseRunnerOutput({
        model: 'Codex',
        stdout: run.stdout || '',
        stderr: run.stderr || '',
        responseFile: existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : undefined,
      });
    }

    if (run.status !== 0 || !existsSync(resultPath)) {
      const err = (run.stderr || run.stdout || '').trim();
      console.error(`Codex: execution failed${err ? `: ${err}` : ''} — skipping.`);
      return { available: false };
    }

    const usage = extractTokenUsageFromText(run.stdout || '');
    return { available: true, result: parseSubagentOutput(readFileSync(resultPath, 'utf8')), usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Codex: ${message} — skipping.`);
    return { available: false };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCopilot(prompt: string, verbose: boolean, skipPreflight = false): ReviewRunnerResult {
  const copilot = resolveBinary('COPILOT_BIN', ['copilot']);
  if (!copilot) {
    console.error('Copilot: binary not found in PATH (or COPILOT_BIN not set) — skipping.');
    return { available: false };
  }

  if (!skipPreflight && !checkPreflight('Copilot', 'GITHUB_TOKEN', ['https://api.github.com'], verbose)) {
    return { available: false };
  }

  try {
    const run = spawnSync(
      copilot,
      ['--model', COPILOT_MODEL, '-s'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        input: prompt,
        ...(needsShellForBinary(copilot) ? { shell: true } : {}),
      },
    );

    if (verbose) {
      logVerboseRunnerOutput({
        model: 'Copilot',
        stdout: run.stdout || '',
        stderr: run.stderr || '',
      });
    }

    if (run.status !== 0) {
      const err = (run.stderr || run.stdout || '').trim();
      console.error(`Copilot: execution failed${err ? `: ${err}` : ''} — skipping.`);
      return { available: false };
    }

    const stdout = (run.stdout || '').trim();
    if (!stdout) {
      console.error('Copilot: empty response — skipping.');
      return { available: false };
    }

    const usage = extractTokenUsageFromText(run.stderr || '');
    return { available: true, result: parseSubagentOutput(stdout), usage };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Copilot: ${message} — skipping.`);
    return { available: false };
  }
}

export function evaluateResults(claude: ReviewRunnerResult, codex: ReviewRunnerResult, copilot: ReviewRunnerResult): { pass: boolean; reason: string } {
  if (!claude.available && !codex.available && !copilot.available) {
    return { pass: false, reason: 'All reviewers (Claude, Codex, Copilot) are unavailable. At least one AI review is required.' };
  }

  const runners: Array<[string, ReviewRunnerResult]> = [['Claude', claude], ['Codex', codex], ['Copilot', copilot]];

  const failures: string[] = [];
  for (const [name, runner] of runners) {
    if (runner.available && runner.result.status === 'fail') failures.push(name);
  }
  if (failures.length > 0) {
    return { pass: false, reason: `AI review rejected by: ${failures.join(', ')}.` };
  }

  const withFindings: string[] = [];
  for (const [name, runner] of runners) {
    if (runner.available && runner.result.findings.some(f => f.severity !== 'info')) withFindings.push(name);
  }
  if (withFindings.length > 0) {
    return { pass: false, reason: `AI review has unresolved findings from: ${withFindings.join(', ')}. Pass requires zero non-info findings.` };
  }

  const passed: string[] = [];
  for (const [name, runner] of runners) {
    if (runner.available) passed.push(name);
  }
  return { pass: true, reason: `AI review approved by: ${passed.join(', ')}.` };
}

function printReview(model: string, result: ParsedReview, usage?: TokenUsage): void {
  const label = result.status === 'fail'
    ? `${model} review FAILED`
    : result.findings.length > 0
      ? `${model} review has findings (pass requires zero)`
      : `${model} review PASSED`;

  console.log(`\n${label}:`);
  console.log(`Summary: ${result.summary}`);

  for (const finding of result.findings) {
    const at = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : 'n/a';
    console.log(`- [${finding.severity}] ${finding.title} (${at})`);
    console.log(`  ${finding.details}`);
  }

  if (usage) {
    const parts: string[] = [];
    if (usage.input_tokens !== undefined) parts.push(`input: ${usage.input_tokens}`);
    if (usage.output_tokens !== undefined) parts.push(`output: ${usage.output_tokens}`);
    if (parts.length > 0) console.log(`Tokens: ${parts.join(', ')}`);
  }
}

export async function runReview(
  cwd = process.cwd(),
  options: RunReviewOptions = {},
  deps: Partial<RunReviewDeps> = {},
): Promise<{ pass: boolean; reportPath: string; reason: string }> {
  const verbose = options.verbose === true;
  const reviewer = options.reviewer;
  const allReviewers = options.allReviewers === true;
  const verboseLogPath = verbose ? resolve(cwd, getGitPath('ai-review-verbose.log')) : null;
  const verboseLines: string[] = [];
  const appendVerbose = (line: string): void => {
    if (verbose) verboseLines.push(line);
  };
  const runtimeDeps: RunReviewDeps = {
    getStagedDiff,
    buildPrompt,
    runClaude,
    runCodex: (p, v, s) => Promise.resolve(runCodex(p, v, s)),
    runCopilot: (p, v, s) => Promise.resolve(runCopilot(p, v, s)),
    writeReport: (reportPath, report) => {
      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    },
    log: (message) => console.log(message),
    ...deps,
  };

  const diff = runtimeDeps.getStagedDiff();
  if (!diff || !diff.trim()) {
    runtimeDeps.log('AI review: diff is empty — nothing to review.');
    return { pass: true, reportPath: resolve(cwd, getGitPath('ai-review-last.json')), reason: 'Empty diff.' };
  }

  const prompt = runtimeDeps.buildPrompt(diff, cwd);

  if (verbose) {
    appendVerbose(`[${new Date().toISOString()}] ----- REVIEW PROMPT (FULL) -----`);
    appendVerbose(prompt);
    appendVerbose('----- END REVIEW PROMPT -----\n');
    runtimeDeps.log('----- REVIEW PROMPT (FULL) -----');
    runtimeDeps.log(prompt);
    runtimeDeps.log('----- END REVIEW PROMPT -----');
  }

  let claude: ReviewRunnerResult = { available: false };
  let codex: ReviewRunnerResult = { available: false };
  let copilot: ReviewRunnerResult = { available: false };

  if (reviewer === 'claude') {
    runtimeDeps.log('Running Claude review (--claude)...');
    claude = await runtimeDeps.runClaude(prompt, verbose, true);
  } else if (reviewer === 'copilot') {
    runtimeDeps.log('Running Copilot review (--copilot)...');
    copilot = await runtimeDeps.runCopilot(prompt, verbose, true);
  } else if (reviewer === 'codex') {
    runtimeDeps.log('Running Codex review (--codex)...');
    codex = await runtimeDeps.runCodex(prompt, verbose, true);
  } else if (allReviewers) {
    const runners: Array<[ReviewerName, string, (p: string, v: boolean, s?: boolean) => Promise<ReviewRunnerResult>]> = [
      ['codex', 'Codex', runtimeDeps.runCodex],
      ['copilot', 'Copilot', runtimeDeps.runCopilot],
      ['claude', 'Claude', runtimeDeps.runClaude],
    ];
    const results: Record<ReviewerName, ReviewRunnerResult> = {
      codex: { available: false },
      copilot: { available: false },
      claude: { available: false },
    };

    for (const [name, label, runner] of runners) {
      runtimeDeps.log(`Running ${label} review...`);
      appendVerbose(`[${new Date().toISOString()}] Running ${label} review...`);
      results[name] = await runner(prompt, verbose);
      appendVerbose(`[${new Date().toISOString()}] ${label}: ${results[name].available ? 'completed' : 'unavailable'}`);
    }

    claude = results.claude;
    codex = results.codex;
    copilot = results.copilot;
  } else {
    const lastUnavailable = readLastUnavailable(cwd);
    const fallbackOrder = buildFallbackOrder(lastUnavailable);

    const runners: Record<ReviewerName, (p: string, v: boolean, s?: boolean) => Promise<ReviewRunnerResult>> = {
      codex: runtimeDeps.runCodex,
      copilot: runtimeDeps.runCopilot,
      claude: runtimeDeps.runClaude,
    };
    const results: Record<ReviewerName, ReviewRunnerResult> = {
      codex: { available: false },
      copilot: { available: false },
      claude: { available: false },
    };
    const labels: Record<ReviewerName, string> = { codex: 'Codex', copilot: 'Copilot', claude: 'Claude' };

    let firstUnavailable: ReviewerName | null = null;
    for (let i = 0; i < fallbackOrder.length; i++) {
      const name = fallbackOrder[i];
      if (i === 0) {
        runtimeDeps.log(`Running ${labels[name]} review...`);
      } else {
        runtimeDeps.log(`${labels[fallbackOrder[i - 1]]} unavailable — falling back to ${labels[name]} review...`);
      }
      results[name] = await runners[name](prompt, verbose);
      if (results[name].available) break;
      if (!firstUnavailable) firstUnavailable = name;
    }

    claude = results.claude;
    codex = results.codex;
    copilot = results.copilot;

    if (firstUnavailable) {
      writeLastUnavailable(cwd, firstUnavailable);
    } else if (!lastUnavailable || !DEFAULT_FALLBACK_ORDER.includes(lastUnavailable as ReviewerName) || results[lastUnavailable as ReviewerName].available) {
      clearLastUnavailable(cwd);
    }
  }

  const report: ReviewReport = {
    claude: claude.available ? claude.result : { status: 'unavailable' },
    codex: codex.available ? codex.result : { status: 'unavailable' },
    copilot: copilot.available ? copilot.result : { status: 'unavailable' },
  };

  const reportPath = resolve(cwd, process.env.AI_REVIEW_REPORT_PATH || getGitPath('ai-review-last.json'));
  runtimeDeps.writeReport(reportPath, report);
  runtimeDeps.log(`AI review raw report saved: ${reportPath}`);

  if (claude.available) {
    printReview('Claude', claude.result, claude.usage);
  } else {
    console.log('\nClaude: unavailable — skipped.');
  }
  if (codex.available) {
    printReview('Codex', codex.result, codex.usage);
  } else {
    console.log('\nCodex: unavailable — skipped.');
  }
  if (copilot.available) {
    printReview('Copilot', copilot.result, copilot.usage);
  } else {
    console.log('\nCopilot: unavailable — skipped.');
  }

  const verdict = evaluateResults(claude, codex, copilot);
  console.log(`\n${verdict.reason}`);

  if (verboseLogPath && verboseLines.length > 0) {
    appendVerbose(`\n[${new Date().toISOString()}] Verdict: ${verdict.reason}`);
    appendVerbose(`Report: ${JSON.stringify(report, null, 2)}`);
    try {
      writeFileSync(verboseLogPath, verboseLines.join('\n'), 'utf8');
      console.log(`Verbose log written to: ${verboseLogPath}`);
    } catch {
      console.error(`Warning: could not write verbose log to ${verboseLogPath}`);
    }
  }

  return { pass: verdict.pass, reportPath, reason: verdict.reason };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReview().then((result) => {
    if (!result.pass) process.exit(1);
  }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
