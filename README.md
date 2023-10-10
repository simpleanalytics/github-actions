# GitHub Action Workflows

This repo contains GitHub Action workflows that can be re-used by other apps.

Example usage:

```yaml
  deploy:
    name: Deploy
    needs: [build, test]
    if: github.event_name != 'pull_request'
    uses: simpleanalytics/github-actions/.github/workflows/deploy.yaml@main
    secrets: inherit
    timeout-minutes: 10
    with:
      app: esapi
```
