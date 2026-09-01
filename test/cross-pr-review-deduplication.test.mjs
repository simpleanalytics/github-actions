import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(fileURLToPath(new URL('../README.md', import.meta.url)));

const workflow = await readFile(
  new URL('../.github/workflows/pull-request.yml', import.meta.url),
  'utf8',
);

function githubScriptFor(stepName) {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(stepStart, -1, `Missing workflow step: ${stepName}`);

  const scriptMarker = '          script: |\n';
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  assert.notEqual(scriptStart, -1, `Missing script for workflow step: ${stepName}`);

  const bodyStart = scriptStart + scriptMarker.length;
  const nextStep = workflow.indexOf('\n\n      - name:', bodyStart);
  const body = workflow.slice(bodyStart, nextStep === -1 ? undefined : nextStep);
  return body.replace(/^ {12}/gm, '');
}

function shellScriptFor(stepName) {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(stepStart, -1, `Missing workflow step: ${stepName}`);

  const scriptMarker = '        run: |\n';
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  assert.notEqual(scriptStart, -1, `Missing shell script for workflow step: ${stepName}`);

  const bodyStart = scriptStart + scriptMarker.length;
  const nextStep = workflow.indexOf('\n\n      - name:', bodyStart);
  const body = workflow.slice(bodyStart, nextStep === -1 ? undefined : nextStep);
  return body.replace(/^ {10}/gm, '');
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const relatedReviewScript = new AsyncFunction(
  'github',
  'context',
  'core',
  githubScriptFor('Find reviewed patches in related pull requests'),
);

function markerComment({
  author = 'github-actions',
  version = 2,
  pullRequest,
  patchIds = [],
  id = `comment-${pullRequest}`,
}) {
  const checkpoint = {
    version,
    repository: 'simpleanalytics/dashboard',
    pull_request: pullRequest,
    base_sha: 'c'.repeat(40),
    head_sha: 'd'.repeat(40),
    reviewed_patch_ids: patchIds,
    reviewed_at: '2026-09-01T10:00:00Z',
  };

  return {
    id,
    author: { login: author },
    body: `<!-- simpleanalytics-claude-pr-review-checkpoint\n${JSON.stringify(checkpoint)}\n-->`,
    updatedAt: checkpoint.reviewed_at,
  };
}

async function runRelatedReviewScript({ open = [], merged = [], patches, requestError } = {}) {
  const previousEnv = {
    CURRENT_PATCHES_JSON: process.env.CURRENT_PATCHES_JSON,
    CURRENT_PR_NUMBER: process.env.CURRENT_PR_NUMBER,
    LOOKUP_TIMEOUT_MS: process.env.LOOKUP_TIMEOUT_MS,
  };
  process.env.CURRENT_PATCHES_JSON = JSON.stringify(patches || []);
  process.env.CURRENT_PR_NUMBER = '99';
  process.env.LOOKUP_TIMEOUT_MS = '30000';

  const outputs = new Map();
  const warnings = [];
  const core = {
    info() {},
    setOutput(name, value) {
      outputs.set(name, String(value));
    },
    warning(message) {
      warnings.push(String(message));
    },
  };
  const github = {
    async request(route, options) {
      assert.equal(route, 'POST /graphql');
      assert.equal(options.variables.owner, 'simpleanalytics');
      assert.equal(options.variables.repo, 'dashboard');
      assert.ok(options.request.signal instanceof AbortSignal);
      if (requestError) throw requestError;

      return {
        data: {
          data: {
            repository: {
              openPullRequests: { nodes: open },
              mergedPullRequests: { nodes: merged },
            },
          },
        },
      };
    },
  };

  try {
    await relatedReviewScript(
      github,
      { repo: { owner: 'simpleanalytics', repo: 'dashboard' } },
      core,
    );
  } finally {
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  return { outputs, warnings };
}

test('cross-PR lookup is bounded and abortable after 30 seconds', () => {
  assert.match(workflow, /LOOKUP_TIMEOUT_MS: 30000/);
  assert.match(workflow, /states: OPEN\n\s+first: 50/);
  assert.match(workflow, /states: MERGED\n\s+first: 20/);
  assert.match(workflow, /14 \* 24 \* 60 \* 60 \* 1000/);
  assert.match(workflow, /new AbortController\(\)/);
  assert.match(workflow, /setTimeout\(\(\) => controller\.abort\(\), timeoutMs\)/);
});

test('trusted version-2 checkpoints match identical patches', async () => {
  const patchId = 'a'.repeat(40);
  const commitSha = 'b'.repeat(40);
  const trusted = markerComment({ pullRequest: 12, patchIds: [patchId] });
  const result = await runRelatedReviewScript({
    patches: [{ patch_id: patchId, commit_sha: commitSha }],
    open: [{
      number: 12,
      firstComments: { nodes: [trusted] },
      lastComments: { nodes: [trusted] },
    }],
  });

  assert.deepEqual(JSON.parse(result.outputs.get('reviewed_commit_shas')), [commitSha]);
  assert.deepEqual(JSON.parse(result.outputs.get('source_pull_requests')), [12]);
  assert.equal(result.outputs.get('matched_patch_count'), '1');
  assert.equal(result.outputs.get('lookup_status'), 'matched');
});

test('untrusted and old merged checkpoints do not suppress review', async () => {
  const patchId = 'a'.repeat(40);
  const commitSha = 'b'.repeat(40);
  const untrusted = markerComment({
    author: 'someone-else',
    pullRequest: 13,
    patchIds: [patchId],
  });
  const oldMerged = markerComment({ pullRequest: 14, patchIds: [patchId] });
  const result = await runRelatedReviewScript({
    patches: [{ patch_id: patchId, commit_sha: commitSha }],
    open: [{
      number: 13,
      firstComments: { nodes: [untrusted] },
      lastComments: { nodes: [] },
    }],
    merged: [{
      number: 14,
      mergedAt: new Date(Date.now() - (15 * 24 * 60 * 60 * 1000)).toISOString(),
      firstComments: { nodes: [oldMerged] },
      lastComments: { nodes: [] },
    }],
  });

  assert.deepEqual(JSON.parse(result.outputs.get('reviewed_commit_shas')), []);
  assert.deepEqual(JSON.parse(result.outputs.get('source_pull_requests')), []);
});

test('version-1 checkpoints are exposed for safe ancestry matching', async () => {
  const legacy = markerComment({ version: 1, pullRequest: 15 });
  const result = await runRelatedReviewScript({
    patches: [{ patch_id: 'a'.repeat(40), commit_sha: 'b'.repeat(40) }],
    open: [{
      number: 15,
      firstComments: { nodes: [legacy] },
      lastComments: { nodes: [] },
    }],
  });

  assert.deepEqual(JSON.parse(result.outputs.get('legacy_checkpoints')), [{
    base_sha: 'c'.repeat(40),
    head_sha: 'd'.repeat(40),
    pull_request: 15,
  }]);
});

test('lookup failure falls back without suppressing commits', async () => {
  const result = await runRelatedReviewScript({
    patches: [{ patch_id: 'a'.repeat(40), commit_sha: 'b'.repeat(40) }],
    requestError: new Error('temporary GitHub failure'),
  });

  assert.deepEqual(JSON.parse(result.outputs.get('reviewed_commit_shas')), []);
  assert.deepEqual(JSON.parse(result.outputs.get('legacy_checkpoints')), []);
  assert.equal(result.outputs.get('lookup_status'), 'failed');
  assert.match(result.warnings[0], /reviewing normally/);
});

test('review scope excludes a commit matched by a version-2 patch checkpoint', async () => {
  const [baseSha, headSha] = execFileSync('git', ['rev-parse', 'HEAD^', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim().split('\n');
  const temporaryDirectory = await mkdtemp(join(repositoryRoot, '.tmp-cross-pr-review-scope-'));
  const outputPath = join(temporaryDirectory, 'github-output');
  const summaryPath = join(temporaryDirectory, 'github-summary');

  try {
    const result = spawnSync('bash', ['-e'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: shellScriptFor('Resolve review scope'),
      env: {
        ...process.env,
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        LAST_REVIEWED_SHA: '',
        LAST_REVIEWED_AT: '',
        LAST_REVIEW_SOURCE: '',
        CURRENT_MERGE_BASE: baseSha,
        RELATED_REVIEWED_SHAS_JSON: JSON.stringify([headSha]),
        RELATED_REVIEW_SOURCE_PRS: '[12]',
        RELATED_LEGACY_CHECKPOINTS: '[]',
        RELATED_LOOKUP_STATUS: 'matched',
        RELATED_LOOKUP_MESSAGE: 'Matched one patch.',
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        RUNNER_TEMP: temporaryDirectory,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const output = await readFile(outputPath, 'utf8');
    assert.match(output, /^mode=cross-pr-deduplicated$/m);
    assert.match(output, new RegExp(`^reviewed_commit_shas=${headSha}$`, 'm'));
    assert.match(output, /^unreviewed_commit_shas=$/m);
    assert.match(output, /^related_review_source_prs=#12$/m);
    assert.match(result.stdout, /::notice title=Cross-PR review deduplication::Skipped 1 already-reviewed commit/);
    assert.match(await readFile(summaryPath, 'utf8'), /Source PRs: #12/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('version-1 checkpoint ancestry is reused only when it covers the current range', async () => {
  const [baseSha, headSha] = execFileSync('git', ['rev-parse', 'HEAD^', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim().split('\n');
  const temporaryDirectory = await mkdtemp(join(repositoryRoot, '.tmp-legacy-review-scope-'));
  const outputPath = join(temporaryDirectory, 'github-output');
  const summaryPath = join(temporaryDirectory, 'github-summary');

  try {
    const result = spawnSync('bash', ['-e'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input: shellScriptFor('Resolve review scope'),
      env: {
        ...process.env,
        BASE_SHA: baseSha,
        HEAD_SHA: headSha,
        LAST_REVIEWED_SHA: '',
        LAST_REVIEWED_AT: '',
        LAST_REVIEW_SOURCE: '',
        CURRENT_MERGE_BASE: baseSha,
        RELATED_REVIEWED_SHAS_JSON: '[]',
        RELATED_REVIEW_SOURCE_PRS: '[]',
        RELATED_LEGACY_CHECKPOINTS: JSON.stringify([{
          base_sha: baseSha,
          head_sha: headSha,
          pull_request: 13,
        }]),
        RELATED_LOOKUP_STATUS: 'no-match',
        RELATED_LOOKUP_MESSAGE: 'No matching version-2 patches.',
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        RUNNER_TEMP: temporaryDirectory,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const output = await readFile(outputPath, 'utf8');
    assert.match(output, /^mode=cross-pr-deduplicated$/m);
    assert.match(output, new RegExp(`^reviewed_commit_shas=${headSha}$`, 'm'));
    assert.match(output, /^related_review_source_prs=#13$/m);
    assert.match(result.stdout, /::notice title=Cross-PR review deduplication::Skipped 1 already-reviewed commit/);
    assert.match(await readFile(summaryPath, 'utf8'), /Source PRs: #13/);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('version-2 checkpoints and prompt rules preserve reviewed patches as context only', () => {
  assert.match(workflow, /version: 2,/);
  assert.match(workflow, /reviewed_patch_ids: reviewedPatchIds/);
  assert.match(workflow, /For cross-pr-deduplicated mode, review only UNREVIEWED COMMITS/);
  assert.match(workflow, /do not report code or documentation findings solely from those commits/);
});

test('workflow annotations explain matches and lookup failures', () => {
  assert.match(workflow, /core\.warning\(message, \{ title: 'Cross-PR review deduplication' \}\)/);
  assert.match(workflow, /::notice title=Cross-PR review deduplication::Skipped/);
  assert.match(workflow, /lookup failed; retained the normal review scope/);
  assert.match(workflow, /### Cross-PR review deduplication/);
});
