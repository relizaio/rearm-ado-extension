import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// Default pinned ReARM CLI version shipped with this extension.
const DEFAULT_REARM_CLI_VERSION = '26.11.6';

// Hardcoded SHA256 digests for the default pinned version, keyed by
// platform-architecture suffix (e.g. 'linux-amd64'). These are the source of
// truth for verifying the downloaded archive — we do NOT trust a remote
// checksums file. To pin a different version, callers must supply the matching
// digest via the rearmCliSha256 input.
const DEFAULT_SHA256: Record<string, string> = {
    'darwin-amd64': '940dd8c981961c0d21477a466f6223642548136d0d857b1a42a4d4a29e73bbea',
    'darwin-arm64': '7b1d0ddb419ea9a61cf9e6d804def6422a7f67f4f6201ca4a0687a7f8dd1e241',
    'freebsd-386': 'e678299ca9424fd9865011843d9e64a98e500db80f6b82d8229307322cdbc791',
    'freebsd-amd64': 'ae01ec122c114ba14fea83e3627c55f62c672e20d5f6fce878dea095e5bae0a5',
    'freebsd-arm': 'fec443113c56ab827abaffb633e4b4dbfa764e15974f76d0c077a2706a1da5db',
    'linux-386': 'ba384c8d51c3bda0e2abb269efb411bfaa6ad559ac60954ad99f341f8c4ecacc',
    'linux-amd64': 'ee19bbaa995395e17d02fc1758b6c1326af2be806aa9d2bd9e1cec9d85a461f1',
    'linux-arm': 'df81f1366c4e05b78f33dc968a3ab43b769031bfaff650b0edc70e0316353200',
    'linux-arm64': '7409c965bf2399af162daa0436efa486f40bbe58943d5a17e79bc688b029b8b8',
    'openbsd-386': 'f46e02e441090f3b563797e2e87c645a8f8908f21ba3032838790885f6dbc026',
    'openbsd-amd64': '82aa7ef330b8b34183d0f5063b8a73365f8fce85cfa0d011ca3d113fb0de8db5',
    'solaris-amd64': 'a6e5133a0808cdf94f8fc2af8ad1a15cdbdd890637756a0be9f991838623a8ee',
    'windows-386': '95c73788a3bbf03651e1534b0736e3cc3c2258ae9bd121192b734bc12ed84e2e',
    'windows-amd64': '75405e814ab757e18c2511213987f0a03e030bba22cba254ffe31a543305e8f4'
};

// Map Node.js platform/arch to ReARM CLI platform suffix
function getPlatformSuffix(): string {
    const platform = os.platform();
    const arch = os.arch();
    
    // Platform mapping
    let platformName: string;
    switch (platform) {
        case 'win32':
            platformName = 'windows';
            break;
        case 'darwin':
            platformName = 'darwin';
            break;
        case 'linux':
            platformName = 'linux';
            break;
        case 'freebsd':
            platformName = 'freebsd';
            break;
        case 'openbsd':
            platformName = 'openbsd';
            break;
        case 'sunos':
            platformName = 'solaris';
            break;
        default:
            throw new Error(`Unsupported platform: ${platform}`);
    }
    
    // Architecture mapping
    let archName: string;
    switch (arch) {
        case 'x64':
            archName = 'amd64';
            break;
        case 'ia32':
        case 'x32':
            archName = '386';
            break;
        case 'arm':
            archName = 'arm';
            break;
        case 'arm64':
            archName = 'arm64';
            break;
        default:
            throw new Error(`Unsupported architecture: ${arch}`);
    }
    
    // Validate supported combinations
    const supported: Record<string, string[]> = {
        'darwin': ['amd64'],
        'freebsd': ['386', 'amd64', 'arm'],
        'linux': ['386', 'amd64', 'arm', 'arm64'],
        'openbsd': ['386', 'amd64'],
        'solaris': ['amd64'],
        'windows': ['386', 'amd64']
    };
    
    if (!supported[platformName]?.includes(archName)) {
        throw new Error(`Unsupported platform/architecture combination: ${platformName}-${archName}`);
    }
    
    return `${platformName}-${archName}`;
}

// Calculate SHA256 hash of a file
function calculateSha256(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

async function run(): Promise<void> {
    try {
        const requestedVersion = (tl.getInput('rearmCliVersion', false) || DEFAULT_REARM_CLI_VERSION).trim();
        const userSha256 = (tl.getInput('rearmCliSha256', false) || '').trim().toLowerCase();

        // Determine platform and architecture
        const platform = os.platform();
        const arch = os.arch();
        const isWindows = platform === 'win32';

        console.log(`Platform: ${platform}`);
        console.log(`Architecture: ${arch}`);

        // Get platform suffix
        const platformSuffix = getPlatformSuffix();
        console.log(`Platform suffix: ${platformSuffix}`);

        // Resolve which version to install and which SHA256 digest to verify against.
        // - Default pinned version: verified against the hardcoded digest for the platform.
        // - Custom version override: a matching digest MUST be supplied via rearmCliSha256.
        // - Custom version WITHOUT a digest: warn and fall back to the default pinned
        //   version/digest, without breaking the pipeline.
        let rearmCliVersion = requestedVersion;
        let expectedHash: string;

        if (requestedVersion === DEFAULT_REARM_CLI_VERSION) {
            expectedHash = DEFAULT_SHA256[platformSuffix];
            if (!expectedHash) {
                throw new Error(`No hardcoded SHA256 digest is available for platform '${platformSuffix}' at version ${DEFAULT_REARM_CLI_VERSION}`);
            }
        } else if (userSha256) {
            // Custom override with an explicit digest — honor it.
            expectedHash = userSha256;
            console.log(`Using custom ReARM CLI version ${requestedVersion} with user-provided SHA256 digest`);
        } else {
            // Custom version requested without a digest — do not trust it. Fall back to
            // the default pinned version but keep the pipeline running.
            tl.error(`A custom rearmCliVersion ('${requestedVersion}') was requested without a corresponding rearmCliSha256 digest. ` +
                `Overriding the version requires pinning its SHA256 digest for supply-chain safety. ` +
                `Falling back to the default pinned version ${DEFAULT_REARM_CLI_VERSION}.`);
            rearmCliVersion = DEFAULT_REARM_CLI_VERSION;
            expectedHash = DEFAULT_SHA256[platformSuffix];
            if (!expectedHash) {
                throw new Error(`No hardcoded SHA256 digest is available for platform '${platformSuffix}' at version ${DEFAULT_REARM_CLI_VERSION}`);
            }
        }

        console.log(`ReARM CLI Version: ${rearmCliVersion}`);
        console.log(`Expected SHA256: ${expectedHash}`);

        // Construct download URL
        const baseUrl = `https://d7ge14utcyki8.cloudfront.net/rearm-download/${rearmCliVersion}`;
        const zipFileName = `rearm-${rearmCliVersion}-${platformSuffix}.zip`;
        const downloadUrl = `${baseUrl}/${zipFileName}`;

        console.log(`Download URL: ${downloadUrl}`);

        // Create rearm directory in Pipeline.Workspace or Agent.TempDirectory
        const workspacePath = tl.getVariable('Pipeline.Workspace') || tl.getVariable('Agent.TempDirectory') || os.tmpdir();
        const rearmDir = path.join(workspacePath, 'rearm');

        if (!fs.existsSync(rearmDir)) {
            fs.mkdirSync(rearmDir, { recursive: true });
        }

        console.log(`Rearm directory: ${rearmDir}`);

        // Download the zip file
        console.log('Downloading Rearm CLI...');
        const zipPath = await toolLib.downloadTool(downloadUrl, path.join(rearmDir, 'rearm.zip'));
        
        // Verify SHA256 hash
        console.log('Verifying SHA256 checksum...');
        const actualHash = calculateSha256(zipPath);
        console.log(`Actual SHA256: ${actualHash}`);
        
        if (actualHash !== expectedHash) {
            throw new Error(`SHA256 checksum mismatch! Expected: ${expectedHash}, Actual: ${actualHash}`);
        }
        console.log('SHA256 checksum verified successfully');
        
        // Extract the zip file
        console.log('Extracting Rearm CLI...');
        const extractedPath = await toolLib.extractZip(zipPath, rearmDir);
        
        // Determine executable path
        const exeName = isWindows ? 'rearm.exe' : 'rearm';
        const rearmExePath = path.join(rearmDir, exeName);
        
        // Set executable permissions on non-Windows platforms
        if (!isWindows) {
            fs.chmodSync(rearmExePath, '755');
        }
        
        // Verify the executable exists
        if (!fs.existsSync(rearmExePath)) {
            throw new Error(`Rearm CLI executable not found at: ${rearmExePath}`);
        }
        
        console.log(`Rearm CLI installed at: ${rearmExePath}`);
        
        // Set output variable for use in subsequent tasks
        tl.setVariable('RearmCli', rearmExePath, false, true);
        
        // Add to PATH for convenience
        tl.prependPath(rearmDir);
        
        tl.setResult(tl.TaskResult.Succeeded, `Rearm CLI ${rearmCliVersion} installed successfully`);
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

run();
