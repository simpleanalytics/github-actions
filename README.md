# GitHub Action Workflows

This repo contains GitHub Action workflows that can be re-used by other apps.

## Pull request risk labels

Use the shared pull-request workflow to apply an SDLC risk label and enforce the PR template for review-required changes. Code review is handled by CodeRabbit, not by this workflow.

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

When a PR has neither SDLC label, Claude reads the full PR diff and returns one label with a one-sentence reason, which the workflow applies and posts once. Claude does not review code, comment, or change the PR. Later pushes skip Claude because an existing label is authoritative. The labels follow the release risk levels of the Software Release and Deployment Procedure:

- `change: routine` covers routine changes and changes that need at most one human or AI-assisted review: ordinary product work, bug fixes, UI and display changes, copy, design, refactors, tests, documentation, internal tools, tooling, and dependency maintenance.
- `change: needs review` covers significant and emergency changes that need a human review: a concrete material change to sensitive-data handling or access, production data used outside production, authentication or authorization, privacy or security boundaries including security fixes, billing, database migrations or destructive data operations, production infrastructure or deployment safety, credible outage or data-loss risks, emergency fixes for production incidents, or similarly critical functionality.

Uncertainty does not escalate a pull request by itself: when Claude cannot name a concrete material impact, or when it fails to return either label, the workflow uses `change: routine`. If both labels are present, the explicit `change: needs review` classification wins.

For `change: needs review`, the workflow ensures the required `Summary`, `Security implications`, `Testing`, and `Checklist` sections exist, using Claude's reason as the security implication when none is written. Human-authored descriptions remain authoritative: their wording, extra sections, and images are preserved while missing required sections are added. Bot- or AI-authored descriptions may be normalized from their existing content. Images and attachments are preserved in either case, and automation never creates checklist items beyond `Linked to an issue`, `Tested`, and `Asked for a review`.

Claude separately drafts a problem-focused tracking issue with `Problem` and `Suggested changes` sections, so completed PR details are not copied into the issue. The PR links to the issue with a `Closes` reference; the issue does not link back to the PR. Later runs reuse that issue instead of creating duplicates.

The workflow first tries to create the issue in `simpleanalytics/dashboard`; if that is not accessible, it falls back to the current repository. If issue creation still fails, the workflow continues and posts the suggested issue content in a collapsed PR comment.

Set `internal_app: true` for internal apps where low-risk changes that do not touch customer/user data, security, privacy, or critical functionality should stay `change: routine` and skip approval-oriented enforcement.

The workflow defaults to `claude-sonnet-5-5`; override it with `claude_model`.

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
