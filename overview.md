# ReARM CLI Tasks for Azure DevOps

This extension provides pipeline tasks to download and use the ReARM CLI tool.

## Prerequisites

For full functionality (branch synchronization and change detection), configure your pipeline checkout step with:

```yaml
steps:
  - checkout: self
    fetchDepth: 0
```

- **fetchDepth: 0** - Fetches full git history, required for accurate change detection between releases

Without these settings, the tasks will still work but branch sync will be skipped, builds will always be triggered and commit history will not be uploaded to ReARM properly.

## Tasks

### RearmCliInstall

Downloads and installs the ReARM CLI.

- Downloads from CloudFront CDN
- Supports both Windows and Linux agents
- Automatically detects the agent OS and downloads the appropriate binary
- Adds ReARM CLI to PATH
- Sets `RearmCli` output variable with the full path to the executable

**Using RearmCli in Bash Scripts:**

To use the `RearmCli` variable in subsequent bash tasks, you must give the task a `name` and reference the variable using that name:

```yaml
steps:
  - task: RearmCliInstall@1
    name: RearmCliInstall  # Required to reference output variables
    inputs:
      rearmCliVersion: '25.12.7'

  - bash: |
      echo "RearmCli path: $(RearmCliInstall.RearmCli)"
      "$(RearmCliInstall.RearmCli)" --version
    displayName: 'Use ReARM CLI'
```

### RearmReleaseInitialize

Synchronizes branches, checks for changes since last release, and initializes a pending release with ReARM. Sets `DO_BUILD` variable to indicate if a build is needed.

- If `version` is provided, uses `addrelease` command with the specified version
- If `version` is not provided, uses `getversion` command to obtain version from ReARM
- Exposes `REARM_FULL_VERSION` and `REARM_SHORT_VERSION` variables for use in subsequent tasks

### RearmReleaseFinalize

Finalizes a release in ReARM with deliverable metadata, artifacts, and runs the release finalizer. Supports:
- Deliverable metadata (container images, binaries, etc.)
- Source code entry artifacts (SCE artifacts)
- Release artifacts (release notes, security reports)
- Deliverable artifacts (SBOMs, attestations)
- Automatic release finalization

## Usage

### Install ReARM CLI

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '25.12.7'

  - script: |
      rearm --version
    displayName: 'Run ReARM CLI'
```

### Initialize Release

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '25.12.7'

  - task: RearmReleaseInitialize@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      repoPath: '.'
      # version: '$(GitVersion.SemVer)'  # Optional - if not provided, version is obtained from ReARM

  - script: |
      echo "Version: $(REARM_FULL_VERSION)"
      echo "Short Version: $(REARM_SHORT_VERSION)"
      echo "Building..."
    condition: eq(variables['DO_BUILD'], 'true')
    displayName: 'Build (only if changes detected)'
```

### Finalize Release

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '25.12.7'

  - task: RearmReleaseInitialize@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'

  # ... your build steps (use $(REARM_FULL_VERSION) or $(REARM_SHORT_VERSION) for tagging) ...

  - task: RearmReleaseFinalize@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      lifecycle: 'ASSEMBLED'
      odelId: 'myregistry.azurecr.io/myapp'
      odelType: 'CONTAINER'
      odelDigests: '$(DOCKER_SHA_256)'
      odelPurl: 'pkg:oci/myapp@sha256:abc123'
      odelArtsJson: '[{"bomFormat":"CYCLONEDX","type":"BOM","filePath":"./sbom.json"}]'
      sceArts: '[{"bomFormat":"CYCLONEDX","type":"BOM","filePath":"./source-sbom.json"}]'
      releaseArts: '[{"displayIdentifier":"release-notes","type":"RELEASE_NOTES","storedIn":"REARM","filePath":"./CHANGELOG.md"}]'
```

## Task Reference

### RearmCliInstall Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmCliVersion` | No | `25.12.7` | Version of the ReARM CLI to install |

### RearmReleaseInitialize Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmApiKey` | Yes | - | API Key for ReARM authentication |
| `rearmApiKeyId` | Yes | - | API Key ID for ReARM authentication |
| `rearmUrl` | Yes | - | ReARM server URL |
| `repoPath` | No | `.` | Path to the repository |
| `branch` | No | Current branch | Branch name |
| `version` | No | - | Version string. If not provided, version is obtained from ReARM via getversion. |
| `createComponent` | No | `false` | Create component if it doesn't exist. Requires organization-wide read-write API key. |
| `createComponentVersionSchema` | No | `semver` | Version schema for new component (semver, calver_reliza, calver_ubuntu, etc.) |
| `createComponentBranchVersionSchema` | No | `semver` | Feature branch version schema for new component |
| `allowRebuild` | No | `false` | Allow rebuilding release on CI reruns. If true, existing releases will be rebuilt instead of rejected. |

### RearmReleaseInitialize Outputs

| Variable | Description |
|----------|--------------|
| `DO_BUILD` | Whether a build should be performed (`true`/`false`) |
| `LAST_COMMIT` | The last commit from the previous release |
| `REARM_FULL_VERSION` | Full version string from ReARM |
| `REARM_SHORT_VERSION` | Docker-tag-safe version string from ReARM |

### RearmReleaseFinalize Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmApiKey` | Yes | - | API Key for ReARM authentication |
| `rearmApiKeyId` | Yes | - | API Key ID for ReARM authentication |
| `rearmUrl` | Yes | - | ReARM server URL |
| `repoPath` | No | `.` | Path to the repository |
| `lifecycle` | No | `ASSEMBLED` | Release lifecycle (ASSEMBLED, DRAFT, REJECTED) |
| `odelId` | No | - | Deliverable identifier (e.g., container image name) |
| `odelType` | No | - | Deliverable type (CONTAINER, APPLICATION, LIBRARY, etc.) |
| `odelDigests` | No | - | Deliverable digests (e.g., sha256:abc123) |
| `odelPurl` | No | - | Package URL (PURL) for the deliverable |
| `odelBuildId` | No | Azure build number | Build ID for the deliverable |
| `odelBuildUri` | No | Azure build URI | URI of the build |
| `odelCiMeta` | No | `azuredevops` | CI system metadata |
| `odelArtsJson` | No | - | JSON array of deliverable artifacts |
| `sceArts` | No | - | JSON array of source code entry artifacts |
| `releaseArts` | No | - | JSON array of release artifacts |
| `runOnCondition` | No | `true` | Only run if DO_BUILD is true |
| `createComponent` | No | `false` | Create component if it doesn't exist. Requires organization-wide read-write API key. |
| `createComponentVersionSchema` | No | `semver` | Version schema for new component (semver, calver_reliza, calver_ubuntu, etc.) |
| `createComponentBranchVersionSchema` | No | `semver` | Feature branch version schema for new component |
| `allowRebuild` | No | `false` | Allow rebuilding release on CI reruns. If true, existing releases will be rebuilt instead of rejected. |

## Support

For issues and feature requests, visit the [GitHub repository](https://github.com/relizaio/rearm-ado-extension).
