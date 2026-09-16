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

test('the signed Simple Analytics bot can trigger reviews by default', () => {
  const allowedBots = workflow.match(
    /      claude_allowed_bots:[\s\S]*?        default: "([^"]+)"/,
  )?.[1];

  assert.equal(
    allowedBots,
    'github-actions,github-actions[bot],simple-analytics-ai',
  );
});

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

test('Claude returns the SDLC assessment without posting or changing labels', () => {
  assert.match(labelRules, /EXISTING SDLC LABEL is non-empty, treat it as authoritative/);
  assert.match(labelRules, /Never apply labels or post an SDLC label message yourself/);
  assert.doesNotMatch(labelRules, /using `gh issue edit`|Report the selected label|Remove the label/);
  assert.doesNotMatch(workflow, /only apply and briefly explain the SDLC label|one-sentence SDLC label reason/);
  const schema = JSON.parse(workflow.match(/--json-schema '([^']+)'/)[1]);
  assert.deepEqual(schema.properties.sdlc_label.enum, ['', 'change: routine', 'change: needs review']);
  assert.ok(schema.required.includes('sdlc_label'));
  assert.ok(schema.required.includes('sdlc_reason'));
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function githubScriptFor(stepName) {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(stepStart, -1);
  const scriptMarker = '          script: |\n';
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  assert.notEqual(scriptStart, -1);
  const bodyStart = scriptStart + scriptMarker.length;
  const nextStep = workflow.indexOf('\n\n      - name:', bodyStart);
  return new AsyncFunction('github', 'context', 'core', 'process', workflow.slice(bodyStart, nextStep).replace(/^ {12}/gm, ''));
}

const captureLabel = githubScriptFor('Capture existing SDLC label');
const finalizeLabel = githubScriptFor('Finalize SDLC label');
const routine = 'change: routine';
const needsReview = 'change: needs review';

function fixture({
  labels = [],
  capturedLabel = '',
  comments = [],
  reviews = [],
  assessment = { sdlc_label: routine, sdlc_reason: 'it changes only display text.' },
  listError,
} = {}) {
  const issue = { labels: [...labels] };
  const mutations = [];
  const outputs = {};
  const github = {
    rest: {
      issues: {
        async get() { return { data: issue }; },
        listComments: 'comments',
        async addLabels({ labels: added }) {
          mutations.push({ type: 'label', labels: added });
          issue.labels.push(...added);
        },
        async createComment({ body }) {
          mutations.push({ type: 'comment', body });
          comments.push({ body });
        },
      },
      pulls: { listReviews: 'reviews' },
    },
    async paginate(route, options) {
      assert.equal(options.per_page, 100);
      if (listError) throw listError;
      return route === 'comments' ? comments : reviews;
    },
  };
  const context = { repo: { owner: 'simpleanalytics', repo: 'dashboard' }, payload: { pull_request: { number: 889 } } };
  const core = { setOutput(name, value) { outputs[name] = value; }, warning() {} };
  const process = { env: {
    EXISTING_SDLC_LABEL: capturedLabel,
    CLAUDE_STRUCTURED_OUTPUT: typeof assessment === 'string' ? assessment : JSON.stringify(assessment),
  } };
  return { mutations, outputs, run: (script = finalizeLabel) => script(github, context, core, process) };
}

test('capture reads the current label from GitHub', async () => {
  const state = fixture({ labels: [{ name: routine }] });
  await state.run(captureLabel);
  assert.equal(state.outputs.label, routine);
  assert.deepEqual(state.mutations, []);
});

for (const labels of [[routine], [{ name: needsReview }], [routine, needsReview]]) {
  test(`existing labels are preserved without an SDLC message: ${JSON.stringify(labels)}`, async () => {
    const state = fixture({ labels });
    await state.run();
    assert.deepEqual(state.mutations, []);
    assert.equal(state.outputs.label, labels.length === 1 && labels[0] === routine ? routine : needsReview);
  });
}

test('a label set during the review takes precedence over the captured label and assessment', async () => {
  const state = fixture({ labels: [routine], capturedLabel: needsReview, assessment: { sdlc_label: needsReview, sdlc_reason: 'a new assessment' } });
  await state.run();
  assert.equal(state.outputs.label, routine);
  assert.equal(state.outputs.requires_review, 'false');
  assert.deepEqual(state.mutations, []);
});

test('a label present at the start prevents a message even if it is later removed', async () => {
  const state = fixture({ capturedLabel: needsReview });
  await state.run();
  assert.deepEqual(state.mutations, [{ type: 'label', labels: [needsReview] }]);
});

for (const location of ['comments', 'reviews']) {
  test(`an existing SDLC message in ${location} prevents another when the label is missing`, async () => {
    const state = fixture({ [location]: [{ body: 'SDLC label: `change: routine` because it only changes text.' }] });
    await state.run();
    assert.deepEqual(state.mutations, [{ type: 'label', labels: [routine] }]);
  });
}

for (const selectedLabel of [routine, needsReview]) {
  test(`the first ${selectedLabel} assessment posts once and a rerun is silent`, async () => {
    const state = fixture({
      comments: [{ body: 'An unrelated finding.' }, { body: '<details><summary>Claude review checkpoint</summary></details>' }],
      assessment: { sdlc_label: selectedLabel, sdlc_reason: 'the diff establishes this impact.' },
    });
    await state.run();
    await state.run();
    assert.deepEqual(state.mutations, [
      { type: 'label', labels: [selectedLabel] },
      { type: 'comment', body: `SDLC label: \`${selectedLabel}\` because the diff establishes this impact.` },
    ]);
    assert.equal(state.outputs.requires_review, String(selectedLabel === needsReview));
  });
}

test('missing or invalid structured output falls back to routine without an invented reason', async () => {
  for (const assessment of ['', 'invalid JSON', null, {}, { sdlc_label: 'unexpected', sdlc_reason: 'a reason' }]) {
    const state = fixture({ assessment });
    await state.run();
    assert.deepEqual(state.mutations, [{ type: 'label', labels: [routine] }]);
  }
});

test('a failed message lookup prevents posting or applying a new assessment', async () => {
  const state = fixture({ listError: new Error('GitHub unavailable') });
  await assert.rejects(state.run(), /GitHub unavailable/);
  assert.deepEqual(state.mutations, []);
});
