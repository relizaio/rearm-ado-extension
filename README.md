# Rearm CLI Azure DevOps Extension

Azure DevOps extension that provides a pipeline task to download and install the Rearm CLI.

Listing on Azure DevOps Marketplace is [here](https://marketplace.visualstudio.com/items?itemName=Reliza.rearm-cli-tasks).

## Features

- Downloads the Rearm CLI from CloudFront CDN
- Supports both Windows and Linux agents
- Automatically detects the agent OS and downloads the appropriate binary
- Sets the `RearmCli` variable for use in subsequent pipeline steps
- Adds Rearm CLI to PATH

## Installation

### Prerequisites

- Node.js 16+ 
- npm
- [tfx-cli](https://github.com/microsoft/tfs-cli) for packaging

### Build

```bash
# Install root dependencies
npm install

# Build the task
npm run build

# Package the extension
npm run package
```

This will create a `.vsix` file that can be uploaded to the Visual Studio Marketplace.

## Usage

### In Azure Pipelines YAML

```yaml
steps:
  - task: RearmCliInstall@1
    inputs:
      rearmCliVersion: '26.04.3'

  - script: |
      $(RearmCli) --version
    displayName: 'Run Rearm CLI'
```

### Task Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmCliVersion` | Yes | `26.04.3` | Version of the Rearm CLI to install |

### Task Outputs

| Variable | Description |
|----------|-------------|
| `RearmCli` | Full path to the Rearm CLI executable (also available as output variable for cross-job use) |

## Publishing to Marketplace

```bash
# Login to your publisher
tfx extension publish --manifest-globs vss-extension.json --token <your-pat>
```

## Development

### Project Structure

```
├── vss-extension.json      # Extension manifest
├── package.json            # Root package.json
├── images/
│   └── icon.png           # Extension icon (128x128)
└── tasks/
    └── RearmCliInstall/
        ├── task.json      # Task manifest
        ├── index.ts       # Task implementation
        ├── package.json   # Task dependencies
        └── tsconfig.json  # TypeScript config
```

### Testing Locally

You can test the task locally using the `tfx` CLI:

```bash
tfx build tasks upload --task-path tasks/RearmCliInstall
```

This requires a Personal Access Token (PAT) with the correct scopes. When you run `tfx` for the first time (or without a cached token) it will prompt you interactively, but you can also pass it explicitly via `--token`.

#### Obtaining a PAT

1. Go to your Azure DevOps organization: `https://dev.azure.com/<your-org>`
2. Click your profile avatar (top-right, "User Settings") → **Personal access tokens**
3. Click **New Token**
4. Set the following:
   - **Name**: anything descriptive (e.g. `tfx-local-dev`)
   - **Organization**: your target org
   - **Expiration**: as needed
   - **Scopes**: select **Custom defined**, then enable:
     - **Agent Pools** → Read & manage
     - **Build** → Read & execute
     - **Extensions** → Read & manage *(required for publishing/uploading)*
5. Click **Create** and copy the token — it is only shown once

#### Configuring tfx with the token

**Option 1 — pass inline (one-off):**
```bash
tfx build tasks upload --task-path tasks/RearmCliInstall \
  --service-url https://dev.azure.com/<your-org> \
  --token <your-pat>
```

**Option 2 — login once and cache credentials:**
```bash
tfx login --service-url https://dev.azure.com/<your-org> --token <your-pat>
# subsequent tfx commands in the same directory will reuse the cached token
tfx build tasks upload --task-path tasks/RearmCliInstall
```

**Option 3 — environment variable (useful in CI or shell profiles):**
```bash
export TFX_TOKEN=<your-pat>
export TFX_SERVICE_URL=https://dev.azure.com/<your-org>
tfx build tasks upload --task-path tasks/RearmCliInstall
```

The same token and setup applies to `tfx extension publish` used in the [Publishing to Marketplace](#publishing-to-marketplace) section.
