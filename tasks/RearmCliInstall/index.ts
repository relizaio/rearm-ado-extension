import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// Default pinned ReARM CLI version shipped with this extension.
const DEFAULT_REARM_CLI_VERSION = '26.05.20';

// Hardcoded SHA256 digests for the default pinned version, keyed by
// platform-architecture suffix (e.g. 'linux-amd64'). These are the source of
// truth for verifying the downloaded archive — we do NOT trust a remote
// checksums file. To pin a different version, callers must supply the matching
// digest via the rearmCliSha256 input.
const DEFAULT_SHA256: Record<string, string> = {
    'darwin-amd64': '7bcb9af4a1a57ffeeeecc36fec808ad50ad8ea05cd59b56f95e2bddf1bf03b0e',
    'darwin-arm64': '611600bb589448ab786e2706eb634dc74a67448e4c5a9eb34fc3ad53d23ac754',
    'freebsd-386': '43a32aa8762ed1c92b12a3d91ac0431d692fa089b5a134e1fe4d805a6a6d3a93',
    'freebsd-amd64': '8e207e38bdda46c68c7d46346265c86f70b0060118a3c65e61e1a072cc659bd8',
    'freebsd-arm': '1b15b284303ea3d1e052e9c05d022c662eba8b3b6b5b49fb191e8917b1cb707d',
    'linux-386': '1d436d8b87686087aea68145bea5886f4f8cb03b9d73dbcc03317c0f5c69ec93',
    'linux-amd64': '779659953b95ee8271f64cfdec451a830f9d1116715a3df4b3151ca18846b3f2',
    'linux-arm': '37fdccf6ea5e2075e842283573f4db6977c856b59ec89380fbcac47ea0064614',
    'linux-arm64': 'bac3c1ec8677013f6f8790111d1825ac56e3ebc2664e4f4d8ce7bf4e804723e5',
    'openbsd-386': '219164a1d28c9d934b5f8d7ebde8aadea9a6619ac0d24895dca24f413903e352',
    'openbsd-amd64': '942e7ec22ff051e64f0d3a5476dca0e8c3fa12a886a4744da9d8ce5ad24cefa6',
    'solaris-amd64': '685c0cdb00cd732b7745eb19f8c1aacbc52395f03e7be4d961841085b8b77d33',
    'windows-386': '7ed10d6bf7962b8f02ccab512cc426d5eabd9b92b602609c0321990efe67e66e',
    'windows-amd64': '840b504781ed5f627b34ada958a912f82b307e7b45d46af42b65928bd8bdb700'
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
