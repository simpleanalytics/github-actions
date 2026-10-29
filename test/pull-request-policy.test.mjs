import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/pull-request.yml", import.meta.url),
  "utf8",
);

test("the signed Simple Analytics bot can trigger classification by default", () => {
  const allowedBots = workflow.match(
    /      claude_allowed_bots:[\s\S]*?        default: "([^"]+)"/,
  )?.[1];

  assert.equal(
    allowedBots,
    "github-actions,github-actions[bot],simple-analytics-ai",
  );
});

test("the prompt quotes the release risk levels and maps them to the two labels", () => {
  for (const row of [
    "| Routine Change | Standard, repeatable, low-risk changes with minimal operational impact | No formal review required |",
    "| Review Required Change | Changes affecting application behavior, infrastructure, integrations, or customer experience | One review required (human or approved AI-assisted review) |",
    "| Significant Change | High-impact changes, infrastructure modifications, security-sensitive changes, or changes with potential customer impact | Two reviews required, where at least one reviewer is human |",
    "| Emergency Change | Critical changes required to restore service availability or address security issues | May be implemented by authorized personnel with post-deployment review required |",
  ]) {
    assert.ok(workflow.includes(row), row);
  }
  assert.match(
    workflow,
    /`change: routine`: a Routine Change or Review Required Change\./,
  );
  assert.match(
    workflow,
    /`change: needs review`: a Significant Change or Emergency Change\./,
  );
  assert.match(workflow, /When in doubt, choose `change: routine`\./);
});

test("needs-review reasons link to the most critical lines", () => {
  assert.match(
    workflow,
    /For a new `change: needs review` classification, end `sdlc_reason` with a link to the lines of the most critical change[^\n]+https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/blob\/\$\{\{ github\.event\.pull_request\.head\.sha \}\}\//,
  );
});

test("Claude uses Haiku and classifies new commits with read-only tools", () => {
  assert.match(workflow, /claude_model:[\s\S]*?default: claude-haiku-5-5\n/);
  assert.match(
    workflow,
    /      - name: Classify SDLC risk with Claude\n        id: claude\n        if: \$\{\{ steps\.classification\.outputs\.classify == 'true' \}\}\n/,
  );
  assert.match(
    workflow,
    /--allowedTools "Bash\(git diff:\*\),Bash\(git log:\*\),Bash\(git show:\*\),Glob,Grep,Read"/,
  );
  assert.doesNotMatch(
    workflow,
    /mcp__github|include_fix_links|SA_PAT_ADRIAAN_READ_REPOS/,
  );
  const schema = JSON.parse(workflow.match(/--json-schema '([^']+)'/)[1]);
  assert.deepEqual(schema.properties.sdlc_label.enum, [
    "change: routine",
    "change: needs review",
  ]);
  assert.deepEqual(schema.required, [
    "sdlc_label",
    "sdlc_reason",
    "review_reasons",
  ]);
  assert.deepEqual(schema.properties.review_reasons, {
    type: "array",
    items: { type: "string" },
  });
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function githubScriptFor(stepName) {
  const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
  assert.notEqual(stepStart, -1);
  const scriptMarker = "          script: |\n";
  const scriptStart = workflow.indexOf(scriptMarker, stepStart);
  assert.notEqual(scriptStart, -1);
  const bodyStart = scriptStart + scriptMarker.length;
  const nextStep = workflow.indexOf("\n\n      - name:", bodyStart);
  const bodyEnd = nextStep === -1 ? workflow.length : nextStep;
  return new AsyncFunction(
    "github",
    "context",
    "core",
    "process",
    "require",
    workflow.slice(bodyStart, bodyEnd).replace(/^ {12}/gm, ""),
  );
}

const prepareClassification = githubScriptFor("Prepare SDLC classification");
const finalizeLabel = githubScriptFor("Finalize SDLC label");
const requestReview = githubScriptFor("Request human review");
const routine = "change: routine";
const needsReview = "change: needs review";

function fixture({
  labels = [],
  capturedLabel,
  comments = [],
  reviews = [],
  assessment = {
    sdlc_label: routine,
    sdlc_reason: "it changes only display text.",
    review_reasons: [],
  },
  runs = [],
  artifacts = {},
  listError,
  author = "adriaandotcom",
  requestedReviewers = [],
  state = "open",
  draft = false,
  headSha = "current-head",
  eventHeadSha = "current-head",
  action = "synchronize",
  classified = true,
  requestError,
} = {}) {
  const issue = { labels: [...labels] };
  const mutations = [];
  const outputs = {};
  const warnings = [];
  const errors = [];
  const files = {};
  const lookups = [];
  const requested = requestedReviewers.map((login) => ({ login }));
  const github = {
    rest: {
      issues: {
        async addLabels({ labels: added }) {
          mutations.push({ type: "label", labels: added });
          issue.labels.push(...added);
        },
        async removeLabel({ name }) {
          mutations.push({ type: "remove-label", name });
          issue.labels = issue.labels.filter(
            (label) =>
              (typeof label === "string" ? label : label.name) !== name,
          );
        },
        async createComment({ body }) {
          mutations.push({ type: "comment", body });
          comments.push({ body });
        },
      },
      pulls: {
        listReviews: "reviews",
        async get() {
          return {
            data: {
              state,
              draft,
              user: { login: author },
              head: { sha: headSha, ref: "feature/test" },
              labels: issue.labels.map((label) =>
                typeof label === "string" ? { name: label } : label,
              ),
              requested_reviewers: requested,
            },
          };
        },
        async requestReviewers({ reviewers }) {
          if (requestError) throw requestError;
          mutations.push({ type: "review-request", reviewers });
          requested.push(...reviewers.map((login) => ({ login })));
        },
      },
      actions: {
        async listWorkflowRunsForRepo(options) {
          if (listError) throw listError;
          assert.equal(options.branch, "feature/test");
          assert.equal(options.event, "pull_request");
          assert.equal(options.status, "success");
          lookups.push({ type: "runs" });
          return {
            data: {
              workflow_runs: runs.filter((run) => run.conclusion === "success"),
            },
          };
        },
        async listWorkflowRunArtifacts({ run_id, name }) {
          assert.equal(name, "sdlc-assessment-889");
          lookups.push({ type: "artifacts", runId: run_id });
          return { data: { artifacts: artifacts[run_id] || [] } };
        },
      },
    },
    async paginate(route, options) {
      assert.equal(options.per_page, 100);
      if (listError) throw listError;
      assert.equal(route, "reviews");
      return reviews;
    },
  };
  const context = {
    repo: { owner: "simpleanalytics", repo: "dashboard" },
    runId: 100,
    runNumber: 10,
    workflow: "Pull Request",
    payload: {
      action,
      pull_request: {
        number: 889,
        head: { sha: eventHeadSha },
        base: { sha: "base-head" },
      },
    },
  };
  const core = {
    setOutput(name, value) {
      outputs[name] = value;
    },
    warning(message) {
      warnings.push(message);
    },
    setFailed(message) {
      errors.push(message);
    },
    info() {},
  };
  const process = {
    env: {
      EXISTING_SDLC_LABEL:
        capturedLabel ??
        [needsReview, routine].find((name) =>
          labels.some(
            (label) =>
              (typeof label === "string" ? label : label.name) === name,
          ),
        ) ??
        "",
      CLASSIFIED: String(classified),
      CLAUDE_STRUCTURED_OUTPUT:
        typeof assessment === "string"
          ? assessment
          : JSON.stringify(assessment),
      RUNNER_TEMP: "/runner-temp",
    },
  };
  const require = (name) => {
    assert.equal(name, "node:fs/promises");
    return {
      async writeFile(path, contents) {
        files[path] = JSON.parse(contents);
      },
    };
  };
  return {
    mutations,
    outputs,
    warnings,
    errors,
    files,
    lookups,
    run: (script = finalizeLabel) =>
      script(github, context, core, process, require),
  };
}

function previousRun(overrides = {}) {
  return {
    id: 90,
    run_number: 9,
    name: "Pull Request",
    conclusion: "success",
    head_sha: "previous-head",
    pull_requests: [{ number: 889 }],
    ...overrides,
  };
}

const assessmentArtifact = { name: "sdlc-assessment-889", expired: false };

test("the first assessment uses the full PR base, even if a label already exists", async () => {
  const state = fixture({ labels: [{ name: routine }] });
  await state.run(prepareClassification);
  assert.equal(state.outputs.label, routine);
  assert.equal(state.outputs.classify, true);
  assert.equal(state.outputs.incremental, false);
  assert.equal(state.outputs.base_sha, "base-head");
  assert.deepEqual(state.mutations, []);
});

test("later pushes start at the latest successful assessment, skipping runs without a usable artifact", async () => {
  const state = fixture({
    labels: [routine],
    runs: [
      previousRun({ id: 100, run_number: 10 }),
      previousRun({ id: 110, run_number: 11 }),
      previousRun({ id: 99, name: "Unrelated workflow" }),
      previousRun({ id: 98, pull_requests: [{ number: 888 }] }),
      previousRun({ id: 97, conclusion: "failure" }),
      previousRun({ id: 96 }),
      previousRun({ id: 95 }),
      previousRun({ id: 94 }),
      previousRun(),
    ],
    artifacts: {
      96: [{ ...assessmentArtifact, expired: true }],
      95: [{ ...assessmentArtifact, name: "unrelated" }],
      90: [assessmentArtifact],
    },
  });
  await state.run(prepareClassification);
  assert.equal(state.outputs.classify, true);
  assert.equal(state.outputs.incremental, true);
  assert.equal(state.outputs.base_sha, "previous-head");
  assert.equal(state.outputs.previous_run_id, 90);
  assert.deepEqual(state.lookups, [
    { type: "runs" },
    ...[96, 95, 94, 90].map((runId) => ({ type: "artifacts", runId })),
  ]);
});

test("a rerun with the same classified head skips the model, but a missing label resets to the full PR", async () => {
  for (const labels of [[routine], []]) {
    const state = fixture({
      labels,
      runs: [previousRun({ head_sha: "current-head" })],
      artifacts: { 90: [assessmentArtifact] },
    });
    await state.run(prepareClassification);
    assert.equal(state.outputs.classify, labels.length === 0);
    assert.equal(state.outputs.incremental, labels.length > 0);
    assert.equal(
      state.outputs.base_sha,
      labels.length ? "current-head" : "base-head",
    );
  }
});

test("manual labels, closed or draft PRs, and obsolete head events skip classification", async () => {
  for (const options of [
    { action: "labeled" },
    { state: "closed" },
    { draft: true },
    { headSha: "newer-head" },
  ]) {
    const state = fixture(options);
    await state.run(prepareClassification);
    assert.equal(state.outputs.classify, false);
    assert.deepEqual(state.lookups, []);
    assert.deepEqual(state.mutations, []);
  }
});

test("unchanged labels are silent but save newly discovered review reasons", async () => {
  for (const [label, reasons] of [
    [routine, []],
    [
      needsReview,
      ["Original privacy risk", "New automatic customer-wide email"],
    ],
  ]) {
    const state = fixture({
      labels: [label],
      assessment: {
        sdlc_label: label,
        sdlc_reason: "an updated explanation.",
        review_reasons: reasons,
      },
    });
    await state.run();
    assert.deepEqual(state.mutations, []);
    assert.equal(state.outputs.label, label);
    assert.equal(state.outputs.request_review, false);
    assert.equal(state.outputs.checkpoint, true);
    assert.deepEqual(state.files["/runner-temp/sdlc-assessment.json"], {
      head_sha: "current-head",
      sdlc_label: label,
      sdlc_reason: "an updated explanation.",
      review_reasons: reasons,
    });
  }
});

test("review requests and saved assessments use separate gates so unchanged labels stay quiet", () => {
  for (const [stepName, output] of [
    ["Request human review", "request_review"],
    ["Save SDLC assessment", "checkpoint"],
  ]) {
    const stepStart = workflow.indexOf(`      - name: ${stepName}\n`);
    const expression = workflow
      .slice(stepStart)
      .match(/\$\{\{ (.+?) \}\}/)?.[1];
    assert.ok(expression);
    const shouldRun = new Function("steps", `return (${expression});`);
    for (const [requestReview, checkpoint] of [
      [true, true],
      [false, true],
      [false, false],
    ]) {
      const outputs = {
        request_review: String(requestReview),
        checkpoint: String(checkpoint),
      };
      assert.equal(
        shouldRun({ finalize_sdlc_label: { outputs } }),
        outputs[output] === "true",
      );
    }
  }
});

test("manual label changes during classification are preserved without advancing the checkpoint", async () => {
  const state = fixture({ labels: [routine], capturedLabel: needsReview });
  await state.run();
  assert.equal(state.outputs.label, routine);
  assert.deepEqual(state.mutations, []);
  assert.equal(state.outputs.checkpoint, false);
});

test("a label removed during classification is not restored", async () => {
  const state = fixture({ capturedLabel: needsReview });
  await state.run();
  assert.deepEqual(state.mutations, []);
  assert.equal(state.outputs.checkpoint, false);
});

for (const [before, after] of [
  [routine, needsReview],
  [needsReview, routine],
  ["", routine],
  ["", needsReview],
]) {
  test(`changing ${before || "no label"} to ${after} posts once even when earlier comments exist`, async () => {
    const state = fixture({
      labels: before ? ["bug", before] : ["bug"],
      comments: [
        { body: `SDLC label: \`${after}\` because a previous run found this.` },
      ],
      assessment: {
        sdlc_label: after,
        sdlc_reason: "the new diff establishes this impact.",
        review_reasons: after === needsReview ? ["Concrete risk"] : [],
      },
    });
    await state.run();
    assert.deepEqual(state.mutations, [
      { type: "label", labels: [after] },
      ...(before ? [{ type: "remove-label", name: before }] : []),
      {
        type: "comment",
        body: `SDLC label: \`${after}\` because the new diff establishes this impact.`,
      },
    ]);
    assert.equal(state.outputs.request_review, after === needsReview);
    assert.equal(state.outputs.checkpoint, true);
  });
}

test("duplicate risk labels are normalized without touching unrelated labels or posting a comment", async () => {
  const state = fixture({
    labels: ["bug", routine, needsReview],
    assessment: {
      sdlc_label: needsReview,
      sdlc_reason: "the risk remains.",
      review_reasons: ["Concrete risk"],
    },
  });
  await state.run();
  assert.deepEqual(state.mutations, [{ type: "remove-label", name: routine }]);
  assert.equal(state.outputs.request_review, false);
});

test("missing, invalid, or inconsistent assessments neither change labels nor advance the checkpoint", async () => {
  for (const assessment of [
    "",
    "invalid JSON",
    null,
    {},
    { sdlc_label: "unexpected", sdlc_reason: "a reason", review_reasons: [] },
    { sdlc_label: routine, sdlc_reason: "a reason" },
    { sdlc_label: routine, sdlc_reason: "", review_reasons: [] },
    {
      sdlc_label: routine,
      sdlc_reason: "a reason",
      review_reasons: ["Unresolved risk"],
    },
    { sdlc_label: needsReview, sdlc_reason: "a reason", review_reasons: [] },
    {
      sdlc_label: needsReview,
      sdlc_reason: "a reason",
      review_reasons: [null],
    },
  ]) {
    const state = fixture({ assessment });
    await state.run();
    assert.deepEqual(state.mutations, []);
    assert.equal(state.outputs.checkpoint, false);
    assert.equal(state.errors.length, 1);
    assert.deepEqual(state.files, {});
  }
});

test("stale, skipped, draft, and closed assessments are discarded without advancing the checkpoint", async () => {
  for (const options of [
    { headSha: "newer-head" },
    { classified: false },
    { draft: true },
    { state: "closed" },
  ]) {
    const state = fixture(options);
    await state.run();
    assert.deepEqual(state.mutations, []);
    assert.equal(state.outputs.checkpoint, false);
    assert.equal(state.outputs.request_review, false);
  }
});

test("manual needs-review labels route review without a model run, even after another commit arrived", async () => {
  const state = fixture({
    labels: [needsReview],
    action: "labeled",
    headSha: "newer-head",
    classified: false,
  });
  await state.run();
  assert.equal(state.outputs.request_review, true);
  assert.equal(state.outputs.checkpoint, false);
  await state.run(requestReview);
  assert.deepEqual(state.mutations, [
    { type: "review-request", reviewers: ["Maimunar"] },
  ]);
});

test("a failed baseline lookup is visible and does not mutate the PR", async () => {
  const state = fixture({ listError: new Error("GitHub unavailable") });
  await assert.rejects(state.run(prepareClassification), /GitHub unavailable/);
  assert.deepEqual(state.mutations, []);
});

for (const [author, reviewer] of [
  ["adriaandotcom", "Maimunar"],
  ["simpleanalytics-agent", "Maimunar"],
  ["simple-analytics-ai", "Maimunar"],
  ["simple-analytics-ai[bot]", "Maimunar"],
  ["github-actions[bot]", "Maimunar"],
  ["Maimunar", "adriaandotcom"],
]) {
  test(`needs-review PRs from ${author} request ${reviewer} once`, async () => {
    const state = fixture({ labels: [needsReview], author });
    await state.run(requestReview);
    await state.run(requestReview);
    assert.deepEqual(state.mutations, [
      { type: "review-request", reviewers: [reviewer] },
    ]);
  });
}

test("an automatic label requests review in the same run without a second label event", async () => {
  const state = fixture({
    assessment: {
      sdlc_label: needsReview,
      sdlc_reason: "a broad automatic effect.",
      review_reasons: ["Automatic email to all customers"],
    },
  });
  await state.run();
  assert.equal(state.outputs.label, needsReview);
  assert.equal(state.outputs.request_review, true);
  await state.run(requestReview);
  assert.deepEqual(
    state.mutations.map((mutation) => mutation.type),
    ["label", "comment", "review-request"],
  );
});

test("review requests recheck current labels and skip closed or draft pull requests", async () => {
  for (const options of [
    { labels: [] },
    { labels: [routine] },
    { labels: [needsReview], state: "closed" },
    { labels: [needsReview], draft: true },
    { labels: [needsReview], requestedReviewers: ["maimunar"] },
  ]) {
    const state = fixture(options);
    await state.run(requestReview);
    assert.deepEqual(state.mutations, [], JSON.stringify(options));
  }
});

test("an unrelated requested reviewer does not replace the designated reviewer", async () => {
  const state = fixture({
    labels: [routine, needsReview],
    requestedReviewers: ["someone-else"],
  });
  await state.run(requestReview);
  assert.deepEqual(state.mutations, [
    { type: "review-request", reviewers: ["Maimunar"] },
  ]);
});

for (const reviewState of ["APPROVED", "CHANGES_REQUESTED"]) {
  test(`a current ${reviewState} review is not requested again`, async () => {
    const state = fixture({
      labels: [needsReview],
      reviews: [
        {
          user: { login: "Maimunar" },
          state: reviewState,
          commit_id: "current-head",
        },
        {
          user: { login: "Maimunar" },
          state: "COMMENTED",
          commit_id: "current-head",
        },
      ],
    });
    await state.run(requestReview);
    assert.deepEqual(state.mutations, []);
  });
}

test("new commits, dismissed approvals, and comment-only reviews request a review", async () => {
  for (const reviews of [
    [{ user: { login: "Maimunar" }, state: "APPROVED", commit_id: "old-head" }],
    [
      {
        user: { login: "Maimunar" },
        state: "COMMENTED",
        commit_id: "current-head",
      },
    ],
    [
      {
        user: { login: "Maimunar" },
        state: "APPROVED",
        commit_id: "current-head",
      },
      {
        user: { login: "Maimunar" },
        state: "DISMISSED",
        commit_id: "current-head",
      },
    ],
    [
      {
        user: { login: "someone-else" },
        state: "APPROVED",
        commit_id: "current-head",
      },
    ],
  ]) {
    const state = fixture({ labels: [needsReview], reviews });
    await state.run(requestReview);
    assert.deepEqual(state.mutations, [
      { type: "review-request", reviewers: ["Maimunar"] },
    ]);
  }
});

test("an unmapped author is reported without guessing a reviewer", async () => {
  const state = fixture({ labels: [needsReview], author: "someone-else" });
  await state.run(requestReview);
  assert.deepEqual(state.mutations, []);
  assert.match(
    state.warnings[0],
    /No automatic reviewer configured for someone-else/,
  );
});

test("a failed reviewer request remains visible as a workflow failure", async () => {
  const state = fixture({
    labels: [needsReview],
    requestError: new Error("Missing permission"),
  });
  await assert.rejects(state.run(requestReview), /Missing permission/);
  assert.deepEqual(state.mutations, []);
});

test("manual needs-review labels and ready drafts trigger the shared job", () => {
  const expression = workflow.match(
    /^    if: >-\n      \$\{\{ (.+) \}\}$/m,
  )?.[1];
  assert.ok(expression);
  const shouldRun = new Function(
    "github",
    "contains",
    "fromJson",
    `return (${expression});`,
  );
  for (const [action, label, draft, expected] of [
    ["opened", undefined, false, true],
    ["reopened", undefined, false, true],
    ["synchronize", undefined, false, true],
    ["ready_for_review", undefined, false, true],
    ["labeled", needsReview, false, true],
    ["labeled", routine, false, false],
    ["labeled", "bug", false, false],
    ["labeled", needsReview, true, false],
    ["closed", undefined, false, false],
  ]) {
    const github = {
      event_name: "pull_request",
      event: { action, label: { name: label }, pull_request: { draft } },
    };
    assert.equal(
      shouldRun(github, (values, value) => values.includes(value), JSON.parse),
      expected,
      `${action}: ${label}, draft=${draft}`,
    );
  }
});
