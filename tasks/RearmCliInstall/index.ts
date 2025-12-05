import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';

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

// Parse sha256sums.txt and get expected hash for a file
function getExpectedHash(sha256Content: string, fileName: string): string | null {
    const lines = sha256Content.split('\n');
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === fileName) {
            return parts[0].toLowerCase();
        }
    }
    return null;
}

async function run(): Promise<void> {
    try {
        const rearmCliVersion = tl.getInput('rearmCliVersion', true) || '25.12.0';
        
        // Determine platform and architecture
        const platform = os.platform();
        const arch = os.arch();
        const isWindows = platform === 'win32';
        
        console.log(`Platform: ${platform}`);
        console.log(`Architecture: ${arch}`);
        console.log(`ReARM CLI Version: ${rearmCliVersion}`);
        
        // Get platform suffix
        const platformSuffix = getPlatformSuffix();
        console.log(`Platform suffix: ${platformSuffix}`);
        
        // Construct download URLs
        const baseUrl = `https://d7ge14utcyki8.cloudfront.net/rearm-download/${rearmCliVersion}`;
        const zipFileName = `rearm-${rearmCliVersion}-${platformSuffix}.zip`;
        const downloadUrl = `${baseUrl}/${zipFileName}`;
        const sha256Url = `${baseUrl}/sha256sums.txt`;
        
        console.log(`Download URL: ${downloadUrl}`);
        
        // Create rearm directory in Pipeline.Workspace or Agent.TempDirectory
        const workspacePath = tl.getVariable('Pipeline.Workspace') || tl.getVariable('Agent.TempDirectory') || os.tmpdir();
        const rearmDir = path.join(workspacePath, 'rearm');
        
        if (!fs.existsSync(rearmDir)) {
            fs.mkdirSync(rearmDir, { recursive: true });
        }
        
        console.log(`Rearm directory: ${rearmDir}`);
        
        // Download SHA256 checksums file
        console.log('Downloading SHA256 checksums...');
        const sha256Path = await toolLib.downloadTool(sha256Url, path.join(rearmDir, 'sha256sums.txt'));
        const sha256Content = fs.readFileSync(sha256Path, 'utf-8');
        
        // Get expected hash for our file
        const expectedHash = getExpectedHash(sha256Content, zipFileName);
        if (!expectedHash) {
            throw new Error(`Could not find SHA256 hash for ${zipFileName} in checksums file`);
        }
        console.log(`Expected SHA256: ${expectedHash}`);
        
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
