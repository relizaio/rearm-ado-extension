# ReARM CLI Tasks for Azure DevOps

This extension provides pipeline tasks to download and use the ReARM CLI tool.

## Tasks

### RearmCliInstall

Downloads and installs the ReARM CLI.

- Downloads from CloudFront CDN
- Supports both Windows and Linux agents
- Automatically detects the agent OS and downloads the appropriate binary
- Adds ReARM CLI to PATH

### RearmReleaseInitialize

Synchronizes branches, checks for changes since last release, and initializes a pending release with ReARM. Sets `DO_BUILD` variable to indicate if a build is needed.

## Usage

### Install ReARM CLI

```yaml
steps:
  - task: RearmCliInstall@0
    inputs:
      rearmCliVersion: '25.10.10'

  - script: |
      rearm --version
    displayName: 'Run ReARM CLI'
```

### Initialize Release

```yaml
steps:
  - task: RearmCliInstall@0
    inputs:
      rearmCliVersion: '25.10.10'

  - task: RearmReleaseInitialize@0
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      repoPath: '.'
      version: '$(GitVersion.SemVer)'

  - script: |
      echo "Building..."
    condition: eq(variables['DO_BUILD'], 'true')
    displayName: 'Build (only if changes detected)'
```

## Task Reference

### RearmCliInstall Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmCliVersion` | No | `25.10.10` | Version of the ReARM CLI to install |

### RearmReleaseInitialize Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmApiKey` | Yes | - | API Key for ReARM authentication |
| `rearmApiKeyId` | Yes | - | API Key ID for ReARM authentication |
| `rearmUrl` | Yes | - | ReARM server URL |
| `repoPath` | No | `.` | Path to the repository |
| `branch` | No | Current branch | Branch name |
| `version` | Yes | - | Version string for the release |

### RearmReleaseInitialize Outputs

| Variable | Description |
|----------|-------------|
| `DO_BUILD` | Whether a build should be performed (`true`/`false`) |
| `LAST_COMMIT` | The last commit from the previous release |

## Support

For issues and feature requests, visit the [GitHub repository](https://github.com/relizaio/rearm-ado-extension).
