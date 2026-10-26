# GitHub Action Workflows

This repo contains GitHub Action workflows that can be re-used by other apps.

## Pull request risk labels

Use the shared pull-request workflow to apply an SDLC risk label to every pull request.

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

When a PR has neither SDLC label, Claude reads the full PR diff and returns `change: routine` or `change: needs review` with a one-sentence reason, which the workflow applies and posts once. A `change: needs review` reason links to the lines of the most critical change. Later pushes skip Claude because an existing label is authoritative. If Claude returns no valid label, the workflow uses `change: routine`; if both labels are present, `change: needs review` wins.

The prompt maps the four release risk levels of the Software Release and Deployment Procedure onto the two labels and includes notes per repository. Add a note to the prompt when a repository needs specific guidance.

Set `internal_app: true` for internal apps where changes that do not touch personal data or security should stay `change: routine`. The workflow defaults to `claude-sonnet-5-5`; override it with `claude_model`.

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
