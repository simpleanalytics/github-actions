# GitHub Action Workflows

This repo contains GitHub Action workflows that can be re-used by other apps.

## Pull request reviews

Use the shared pull-request workflow to run Claude PR review, SDLC risk labeling, and review-required PR template enforcement.

```yaml
name: Pull Request

on:
  pull_request:
    types: [opened, reopened, synchronize]

jobs:
  pull-request:
    uses: simpleanalytics/github-actions/.github/workflows/pull-request.yml@main
    secrets: inherit
    with:
      internal_app: false
```

Claude reviews full PR diffs on `opened` and `reopened`, and only the newly pushed commit range on `synchronize` unless a critical issue is still present. The workflow creates and applies exactly one SDLC label:

- `change: routine` is the default for ordinary product work, bug fixes, UI and display changes, copy, design, refactors, tests, documentation, tooling, and dependency maintenance.
- `change: needs review` is reserved for a concrete material change to sensitive-data handling or access, authentication or authorization, privacy or security boundaries, billing, database migrations or destructive data operations, production infrastructure or deployment safety, credible outage or data-loss risks, or similarly critical functionality.

Uncertainty does not escalate a pull request by itself: when Claude cannot name a concrete material impact, or when it fails to apply either label, the workflow uses `change: routine`. If both labels are present, the explicit `change: needs review` classification wins.

For `change: needs review`, the workflow ensures the required `Summary`, `Security implications`, `Testing`, and `Checklist` sections exist. Human-authored descriptions remain authoritative: their wording, extra sections, and images are preserved while missing required sections are added. Bot- or AI-authored descriptions may be normalized from their existing content. Images and attachments are preserved in either case, and automation never creates checklist items beyond `Linked to an issue`, `Tested`, and `Asked for a review`.

Claude separately drafts a problem-focused tracking issue with `Problem` and `Suggested changes` sections, so completed PR details are not copied into the issue. The PR links to the issue with a `Closes` reference; the issue does not link back to the PR. Later review runs reuse that issue instead of creating duplicates.

The workflow first tries to create the issue in `simpleanalytics/dashboard`; if that is not accessible, it falls back to the current repository. If issue creation still fails, the workflow continues and posts the suggested issue content in a collapsed PR comment.

Set `internal_app: true` for internal apps where low-risk changes that do not touch customer/user data, security, privacy, or critical functionality should stay `change: routine` and skip approval-oriented enforcement.

The workflow defaults to `claude-opus-4-8`. It can clone read-only cross-repo context when the caller has a `SA_PAT_ADRIAAN_READ_REPOS` secret. If the secret is missing, the workflow continues with a warning; the token is stored in 1Password under that name. Context repositories clone in parallel with `context_clone_concurrency`, which defaults to `8`.

## Manual Claude requests

Use the shared Claude workflow to keep `@claude` requests consistent across repositories.

```yaml
name: Claude Code

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

jobs:
  claude:
    uses: simpleanalytics/github-actions/.github/workflows/claude.yml@main
    secrets: inherit
```

The workflow defaults to `claude-opus-4-8` and exposes `test_ref` so caller repositories can run their own local CI workflow after Claude handles a PR comment or review thread.

Make sure to set a secret in your repo called `DEPLOY_TOKEN`. The value can be found in infra repo secrets.

Example usage:

```yaml
  deploy:
    name: Deploy
    needs: [build, test]
    if: github.event_name != 'pull_request'
    uses: simpleanalytics/github-actions/.github/workflows/deploy.yml@main
    secrets: inherit
    timeout-minutes: 10
    with:
      app: esapi
      hosts: "esapp1 esapp02 esapp03"
      strategy: blue_green
      image_repo: ghcr.io/${{ github.repository }}
      image_tag: ${{ github.sha }}
```
