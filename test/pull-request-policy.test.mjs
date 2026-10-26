import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/pull-request.yml', import.meta.url),
  'utf8',
);

test('the signed Simple Analytics bot can trigger classification by default', () => {
  const allowedBots = workflow.match(
    /      claude_allowed_bots:[\s\S]*?        default: "([^"]+)"/,
  )?.[1];

  assert.equal(
    allowedBots,
    'github-actions,github-actions[bot],simple-analytics-ai',
  );
});

test('the prompt quotes the release risk levels and maps them to the two labels', () => {
  for (const row of [
    '| Routine Change | Standard, repeatable, low-risk changes with minimal operational impact | No formal review required |',
    '| Review Required Change | Changes affecting application behavior, infrastructure, integrations, or customer experience | One review required (human or approved AI-assisted review) |',
    '| Significant Change | High-impact changes, infrastructure modifications, security-sensitive changes, or changes with potential customer impact | Two reviews required, where at least one reviewer is human |',
    '| Emergency Change | Critical changes required to restore service availability or address security issues | May be implemented by authorized personnel with post-deployment review required |',
  ]) {
    assert.ok(workflow.includes(row), row);
  }
  assert.match(workflow, /`change: routine`: a Routine Change or Review Required Change\./);
  assert.match(workflow, /`change: needs review`: a Significant Change or Emergency Change\./);
  assert.match(workflow, /When in doubt, choose `change: routine`\./);
});

test('needs-review reasons link to the most critical lines', () => {
  assert.match(
    workflow,
    /For `change: needs review`, end `sdlc_reason` with a link to the lines of the most critical change[^\n]+https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/blob\/\$\{\{ github\.event\.pull_request\.head\.sha \}\}\//,
  );
});

test('Claude only classifies unlabeled pull requests with read-only tools', () => {
  assert.match(
    workflow,
    /      - name: Classify SDLC risk with Claude\n        id: claude\n        if: \$\{\{ steps\.existing_sdlc_label\.outputs\.label == '' \}\}\n/,
  );
  assert.match(workflow, /--allowedTools "Bash\(git diff:\*\),Bash\(git log:\*\),Bash\(git show:\*\),Glob,Grep,Read"/);
  assert.doesNotMatch(workflow, /mcp__github|include_fix_links|SA_PAT_ADRIAAN_READ_REPOS/);
  const schema = JSON.parse(workflow.match(/--json-schema '([^']+)'/)[1]);
  assert.deepEqual(schema.properties.sdlc_label.enum, ['change: routine', 'change: needs review']);
  assert.deepEqual(schema.required, ['sdlc_label', 'sdlc_reason']);
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
