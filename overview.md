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
      rearmCliVersion: '26.04.2'

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

### RearmAddMultiRelease

Self-sufficient task to add multiple releases to ReARM in a single pipeline step. Does not require `RearmReleaseInitialize` or `RearmReleaseFinalize`. Each release entry must supply its own version. Supports:
- Multiple releases in one task invocation, each with independent repo path, VCS URI, branch, and lifecycle
- Multiple deliverables per release (container images, libraries, etc.)
- Per-release change detection — skips a release if no changes are detected since the last release (same logic as `RearmReleaseInitialize`)
- Automatic release finalization when lifecycle is `ASSEMBLED`
- Component auto-creation per release

## Usage

### Install ReARM CLI

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.2'

  - script: |
      rearm --version
    displayName: 'Run ReARM CLI'
```

### Initialize Release

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.2'

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
      rearmCliVersion: '26.04.2'

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

### Add Multiple Releases

Use `RearmAddMultiRelease` as a standalone task when you want to register one or more releases without a separate initialize/finalize pair. The `releases` input is a JSON array where each element configures one release independently.

The only mandatory field in each release object is `version`. All other fields are optional — `vcsUri`, `branch`, and `commit` are auto-resolved from the pipeline context (`Build.Repository.Uri`, `Build.SourceBranch`, `Build.SourceVersion`) and will only need to be set explicitly in multi-repo scenarios or when overrides are required. For the full field reference with defaults and descriptions, see the [RearmAddMultiRelease reference tables](#rearmaddmultirelease-inputs) at the bottom of this document.

**Single release, no deliverable:**

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.2'

  - task: RearmAddMultiRelease@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      releases: |
        [
          {
            "version": "$(MY_VERSION)"
          }
        ]
```

**Multiple releases from different repository paths:**

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.2'

  - task: RearmAddMultiRelease@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      releases: |
        [
          {
            "version": "$(VERSION_BACKEND)",
            "repoPath": "backend"
          },
          {
            "version": "$(VERSION_FRONTEND)",
            "repoPath": "frontend"
          }
        ]
```

**Release with a container deliverable:**

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.2'

  - task: RearmAddMultiRelease@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      releases: |
        [
          {
            "version": "$(MY_VERSION)",
            "lifecycle": "ASSEMBLED",
            "repoPath": ".",
            "sceArts": [{"bomFormat": "CYCLONEDX", "type": "BOM", "filePath": "./source-sbom.json"}],
            "releaseArts": [{"displayIdentifier": "release-notes", "type": "RELEASE_NOTES", "storedIn": "REARM", "filePath": "./CHANGELOG.md"}],
            "deliverables": [
              {
                "odelId": "myregistry.azurecr.io/myapp",
                "odelType": "CONTAINER",
                "odelDigests": ["$(DOCKER_SHA_256)"],
                "odelPurl": "pkg:oci/myapp@$(DOCKER_SHA_256)",
                "odelArtsJson": [{"bomFormat": "CYCLONEDX", "type": "BOM", "filePath": "./sbom.json"}]
              }
            ]
          }
        ]
```

**All fields populated — one release, one deliverable:**

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.2'

  - task: RearmAddMultiRelease@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      allowRebuild: false
      releases: |
        [
          {
            "version": "$(MY_VERSION)",
            "lifecycle": "ASSEMBLED",
            "repoPath": ".",
            "vcsUri": "https://github.com/myorg/myrepo",
            "vcsDisplayName": "My GitHub Repo",
            "branch": "main",
            "createComponent": true,
            "createComponentName": "My Application",
            "createComponentVersionSchema": "semver",
            "createComponentBranchVersionSchema": "semver",
            "runOnCondition": true,
            "datestart": "2026-04-11T10:00:00.000Z",
            "dateend": "2026-04-11T10:05:00.000Z",
            "sceArts": [{"bomFormat": "CYCLONEDX", "type": "BOM", "filePath": "./source-sbom.json"}],
            "releaseArts": [{"displayIdentifier": "release-notes", "type": "RELEASE_NOTES", "storedIn": "REARM", "filePath": "./CHANGELOG.md"}],
            "deliverables": [
              {
                "odelId": "myregistry.azurecr.io/myapp",
                "odelType": "CONTAINER",
                "odelDigests": ["sha256:abc123def456"],
                "odelPurl": "pkg:oci/myapp@sha256:abc123def456",
                "odelBuildId": "azuredevops$(Build.BuildNumber)",
                "odelBuildUri": "$(Build.BuildUri)",
                "odelCiMeta": "azuredevops",
                "odelArtsJson": [{"bomFormat": "CYCLONEDX", "type": "BOM", "filePath": "./sbom.json"}]
              }
            ]
          }
        ]
```

**Release with multiple deliverables:**

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.2'

  - task: RearmAddMultiRelease@1
    inputs:
      rearmApiKey: '$(REARM_API_KEY)'
      rearmApiKeyId: '$(REARM_API_KEY_ID)'
      rearmUrl: 'https://your-rearm-server.com'
      releases: |
        [
          {
            "version": "$(MY_VERSION)",
            "lifecycle": "ASSEMBLED",
            "deliverables": [
              {
                "odelId": "myregistry.azurecr.io/myapp-amd64",
                "odelType": "CONTAINER",
                "odelDigests": ["$(AMD64_DIGEST)"]
              },
              {
                "odelId": "myregistry.azurecr.io/myapp-arm64",
                "odelType": "CONTAINER",
                "odelDigests": ["$(ARM64_DIGEST)"]
              }
            ]
          }
        ]
```

## Task Reference

### RearmCliInstall Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmCliVersion` | No | `26.04.2` | Version of the ReARM CLI to install |

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
| `vcsDisplayName` | No | - | Display name for the VCS. Only used with createComponent. If not supplied, ReARM default logic will be used. |
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
| `vcsDisplayName` | No | - | Display name for the VCS. Only used with createComponent. If not supplied, ReARM default logic will be used. |
| `allowRebuild` | No | `false` | Allow rebuilding release on CI reruns. If true, existing releases will be rebuilt instead of rejected. |

### RearmAddMultiRelease Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmApiKey` | Yes | - | API Key for ReARM authentication |
| `rearmApiKeyId` | Yes | - | API Key ID for ReARM authentication |
| `rearmUrl` | Yes | - | ReARM server URL |
| `allowRebuild` | No | `false` | Allow rebuilding releases on CI reruns. Applies to all releases. |
| `releases` | Yes | - | JSON array of release objects (see schema below) |

### RearmAddMultiRelease — Per-Release Object Schema

Each element of the `releases` JSON array supports the following fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `version` | Yes | - | Version string for this release |
| `lifecycle` | No | `ASSEMBLED` | Release lifecycle: `ASSEMBLED`, `DRAFT`, or `REJECTED` |
| `repoPath` | No | `.` | Path to the repository for this release |
| `vcsUri` | No | `Build.Repository.Uri` | Override the VCS URI. Defaults to the pipeline's repository URI. |
| `vcsDisplayName` | No | - | Display name for the VCS. Only used with `createComponent`. All entries sharing the same `vcsUri` must use the same `vcsDisplayName`. |
| `branch` | No | Auto-detected | Branch name. Auto-detected via `git rev-parse --abbrev-ref HEAD` at `repoPath` if not provided. |
| `createComponent` | No | `false` | Create component if it doesn't exist. Requires organization-wide read-write API key. |
| `createComponentName` | No | - | Name for the new component. Only used with `createComponent`. |
| `createComponentVersionSchema` | No | `semver` | Version schema for the new component (`semver`, `calver_reliza`, `calver_ubuntu`, etc.) |
| `createComponentBranchVersionSchema` | No | `semver` | Feature branch version schema for the new component |
| `commits` | No | Auto-fetched | Base64-encoded commits history. Auto-fetched from git (last 100 commits since previous release) if not provided. |
| `releaseArts` | No | - | JSON array of release artifacts (release notes, security reports, etc.). Must be a JSON array, not a string. |
| `sceArts` | No | - | JSON array of source code entry artifacts. Must be a JSON array, not a string. |
| `runOnCondition` | No | `true` | When `true`, performs change detection (same logic as `RearmReleaseInitialize`): calls `getlatestrelease` and runs a git diff. The release is skipped if no changes are detected since the last release. Set to `false` to always submit regardless of changes. |
| `datestart` | No | Task start time | ISO 8601 build start timestamp. Defaults to the time the task began executing. |
| `dateend` | No | Time of submission | ISO 8601 build end timestamp. Defaults to the time just before each `addrelease` call. |
| `deliverables` | No | `[]` | Array of deliverable objects (see schema below). If empty, the release is submitted with no deliverable. |

### RearmAddMultiRelease — Per-Deliverable Object Schema

Each element of a release's `deliverables` array supports the following fields:

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `odelId` | Yes | - | Deliverable identifier (e.g., container image name such as `registry.example.com/myapp`). Entry is skipped if absent. |
| `odelType` | Yes | - | CycloneDX deliverable type: `CONTAINER`, `APPLICATION`, `LIBRARY`, `FILE`, `FRAMEWORK`, or `PLATFORM` |
| `odelDigests` | No | - | Digest(s) for the deliverable (e.g., `sha256:abc123`). String or array of strings. |
| `odelPurl` | No | - | Package URL (PURL) for the deliverable. Prefixed with `PURL:` when submitted to ReARM. |
| `odelBuildId` | No | `azuredevops<BuildNumber>` | Build identifier for the deliverable |
| `odelBuildUri` | No | `Build.BuildUri` | URI of the build |
| `odelCiMeta` | No | `azuredevops` | CI system metadata |
| `odelArtsJson` | No | - | JSON array of deliverable artifacts (SBOMs, attestations, etc.). Must be a JSON array, not a string. |

**Validation rules:**
- No two releases may share the same combination of `vcsUri`, `repoPath`, and `version`.
- All releases that share the same `vcsUri` must use the same `vcsDisplayName` (or omit it entirely).

## Support

For issues and feature requests, visit the [GitHub repository](https://github.com/relizaio/rearm-ado-extension).
