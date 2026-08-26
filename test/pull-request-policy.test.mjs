import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/pull-request.yml', import.meta.url),
  'utf8',
);

const labelRules = workflow.match(
  /            SDLC label rules:\n([\s\S]*?)\n            PR description rules:/,
)?.[1];

test('the SDLC prompt defaults uncertain and ordinary changes to routine', () => {
  assert.ok(labelRules, 'SDLC label rules should be present');
  assert.match(labelRules, /Start with `change: routine`/);
  assert.match(labelRules, /ordinary product features and bug fixes/);
  assert.match(labelRules, /relabeling an existing analytics field/);
  assert.match(labelRules, /view display settings while preserving existing authorization/);
  assert.match(labelRules, /If the evidence is uncertain[^\n]+use `change: routine`/);
  assert.doesNotMatch(labelRules, /If uncertain, use `change: needs review`/);
});

test('needs-review classification requires concrete material impact', () => {
  assert.ok(labelRules, 'SDLC label rules should be present');
  assert.match(labelRules, /only when the full PR diff establishes at least one concrete, material impact/);
  assert.match(labelRules, /authentication, authorization, permissions/);
  assert.match(labelRules, /database schemas, data migrations/);
  assert.match(labelRules, /credible outage, data-loss, or corruption risk/);
  assert.match(labelRules, /changing tenant or JWT authorization scope/);
  assert.match(labelRules, /Merely touching production code[^\n]+is not enough to require review/);
});

test('missing labels fall back to routine while an explicit escalation still wins', () => {
  assert.match(workflow, /if \(hasNeedsReview && hasRoutine\)[\s\S]*?finalLabel = needsReview/);
  assert.match(
    workflow,
    /labels: \[routine\],[\s\S]*?finalLabel = routine;[\s\S]*?Added default '\$\{routine\}'/,
  );
});
