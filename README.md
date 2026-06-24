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

- `change: needs review` for changes affecting security, data protection, system stability, customer/user data, or critical functionality.
- `change: routine` for internal tools or low-risk changes such as design updates or content modifications.

For `change: needs review`, the workflow ensures the Simple Analytics PR template is used and tries to create a linked tracking issue that describes the problem the PR is fixing. It first tries `simpleanalytics/dashboard`; if that is not accessible, it falls back to the current repository. If issue creation still fails, the workflow continues and posts the suggested issue content in a collapsed PR comment.

Set `internal_app: true` for internal apps where low-risk changes that do not touch customer/user data, security, privacy, or critical functionality should stay `change: routine` and skip approval-oriented enforcement.

The workflow defaults to `claude-opus-4-8`. It can clone read-only cross-repo context when the caller has a `PERSONAL_ACCESS_TOKEN_ADRIAAN_READ_PACKAGES` secret. If the secret is missing, the workflow continues with a warning; the token is stored in 1Password under that name.

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
