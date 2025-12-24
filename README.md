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
      rearmCliVersion: '25.12.8'

  - script: |
      $(RearmCli) --version
    displayName: 'Run Rearm CLI'
```

### Task Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `rearmCliVersion` | Yes | `25.12.8` | Version of the Rearm CLI to install |

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
