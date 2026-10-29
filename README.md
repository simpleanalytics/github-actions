# GitHub Action Workflows

This repo contains GitHub Action workflows that can be re-used by other apps.

## Pull request risk labels

Use the shared pull-request workflow to apply an SDLC risk label to every pull request. The calling repository needs access to an `ANTHROPIC_API_KEY` secret.

```yaml
name: Pull Request

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review, labeled]

jobs:
  pull-request:
    uses: simpleanalytics/github-actions/.github/workflows/pull-request.yml@main
    secrets: inherit
```

On the first run, Claude reads the full PR diff and returns `change: routine` or `change: needs review` with a one-sentence reason. On later pushes, Claude only reads the changes since the last successful assessment, and earlier review triggers stay until a new diff removes them. The workflow posts the reason when the label changes; a `change: needs review` reason links to the lines of the most critical change. A label set by hand is kept as the assessment of the earlier code. If Claude returns an incomplete assessment, the run fails and leaves the labels unchanged.

Draft PRs are skipped until they are ready for review. When a PR gets `change: needs review`, from Claude or by hand, the workflow requests a human reviewer.

The prompt maps the four release risk levels of the Software Release and Deployment Procedure onto the two labels and includes notes per repository. Add a note to the prompt when a repository needs specific guidance.

Set `internal_app: true` for an internal app without a repository note, so changes that do not touch personal data or security stay `change: routine`. The workflow defaults to `claude-haiku-5-5`; override it with `claude_model`.

## Deploy

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
