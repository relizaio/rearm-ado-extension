# ReARM CLI Tasks for Azure DevOps

This extension provides a pipeline task to download and install the ReARM CLI tool.

## Features

- Downloads the ReARM CLI from CloudFront CDN
- Supports both Windows and Linux agents
- Automatically detects the agent OS and downloads the appropriate binary
- Sets the `RearmCli` variable for use in subsequent pipeline steps
- Adds ReARM CLI to PATH

## Usage

```yaml
steps:
  - task: RearmCliInstall@0
    inputs:
      rearmCliVersion: '25.10.10'

  - script: |
      $(RearmCli) --version
    displayName: 'Run ReARM CLI'
```

## Task Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmCliVersion` | No | `25.10.10` | Version of the ReARM CLI to install |

## Task Outputs

| Variable | Description |
|----------|-------------|
| `RearmCli` | Full path to the ReARM CLI executable |

## Support

For issues and feature requests, visit the [GitHub repository](https://github.com/relizaio/rearm-ado-extension).
