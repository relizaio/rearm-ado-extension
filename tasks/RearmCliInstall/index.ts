import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

// Default pinned ReARM CLI version shipped with this extension.
const DEFAULT_REARM_CLI_VERSION = '26.11.8';

// Hardcoded SHA256 digests for the default pinned version, keyed by
// platform-architecture suffix (e.g. 'linux-amd64'). These are the source of
// truth for verifying the downloaded archive — we do NOT trust a remote
// checksums file. To pin a different version, callers must supply the matching
// digest via the rearmCliSha256 input.
const DEFAULT_SHA256: Record<string, string> = {
    'darwin-amd64': '91fffeb004cc482132cc18f50a8e0a4883d727a16b06391f856b85846759ec55',
    'darwin-arm64': '2795c1401f4d2fa775cd86d07f00e1b0ca3d544e374edb99a894bac0c7893140',
    'freebsd-386': '4d9d3f8d5226f09c40d39feeecac8f2ea00eb8b0bbd2f4457afafea3cb2b5de0',
    'freebsd-amd64': '4149eb6a16eab95668c021bfc0d935ea92d0ee1351f3860c6fd889e157b181c5',
    'freebsd-arm': '0c61405bda8c172a4ba2a06f158a7d536936b4b68e08ba81634caf40cd83ac25',
    'linux-386': '5c6e43b4e7444a68bb5be55616a25e2ff76b6d4e023dab01c95bd4af4ff7ced8',
    'linux-amd64': '9a2b4d75ec03c1658c3caa9071f726a50aa110e0adc8f41d7383dd14d17c2479',
    'linux-arm': '9f44d8b5cd5e0e71af98f5175732c42eb5ab63c28242277d8bb6b62d149291e7',
    'linux-arm64': 'fe948e536f6a38433079c135017ea5c6ef85f2a9aac69dc03af24b6c66968809',
    'openbsd-386': '2dad28622e313a8a08be4f1efc46306c35afa74552c2a2337268b89483441600',
    'openbsd-amd64': '7946f21e623bf8a53a8c71f3e9d69341b47c3e6ce79c25222ccbc4bb7dced197',
    'solaris-amd64': 'e5aa5d3c74d7660bda43054967915d3190b727069d494f478672e36b8d3cc6f1',
    'windows-386': 'a60a5401d7469c14a563dcb21701580a57b296a1f052655ecbcd4c1f82f190ff',
    'windows-amd64': 'bf4bb370f5326b73c6e626613c08033e41e240a8b999256bc978e746cbd0945c'
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
