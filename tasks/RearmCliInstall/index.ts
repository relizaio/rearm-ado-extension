import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// Default pinned ReARM CLI version shipped with this extension.
const DEFAULT_REARM_CLI_VERSION = '26.11.9';

// Hardcoded SHA256 digests for the default pinned version, keyed by
// platform-architecture suffix (e.g. 'linux-amd64'). These are the source of
// truth for verifying the downloaded archive — we do NOT trust a remote
// checksums file. To pin a different version, callers must supply the matching
// digest via the rearmCliSha256 input.
const DEFAULT_SHA256: Record<string, string> = {
    'darwin-amd64': '0e14cd4661a2833075c88941fd681461eb2da3937757c0ee09331e1b3f6bdbad',
    'darwin-arm64': '90bd3fac675efaa93a22e835de864ff0c05499d34b45b5c1d51232bae89e241d',
    'freebsd-386': 'e536af62aa4672994c4bca627249f4298cfad05ef9bedc131736bf72bd64db7a',
    'freebsd-amd64': '4d66d8cced888ae0f4915ab5d204245bc23ace3a66d897d9d264e74ac5228e71',
    'freebsd-arm': 'bd5e46ad7dcb932583c4983e909b3933b6e86fbb9c55b0cc86e434c59ab29093',
    'linux-386': '8af0a3cbc143de4348fafdf4ee27a405396d9714028c7c3480cb58110d872bcd',
    'linux-amd64': '553a6472fbbbd382e8ea5ca54f4f47c5df25df0f6c7f07e26cfdcf20df8bf532',
    'linux-arm': '58e38ff2484b6ae220ff085528a1edd1e60367fd0c863946cd25c74526b9863d',
    'linux-arm64': '1bcdb8c365a24e21dc05a3d57067ebb4740d007dda402dd6d4fa9f8fa1ba7a35',
    'openbsd-386': '4f30a5365f91e3664f2b436cd7d1cb4cef0bea4ed54cc0f063e428fcc8167823',
    'openbsd-amd64': '65bdbbc6c639a149afa9db7b7251a5b2d8dc29ea25487134bffe1ffdac815345',
    'solaris-amd64': '5c51ec880eebab5e5c98b5022d236d287814db1d1541ca645c32fcf38466d913',
    'windows-386': 'ff2d2eb1b4df7a542cd875b19a96dd85847c7c9ad4ee8ac343863d3bc9d59f19',
    'windows-amd64': '091b40cce89231d4fd24665a5172166195f26b5d56822342adec7b461eea65d6'
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
