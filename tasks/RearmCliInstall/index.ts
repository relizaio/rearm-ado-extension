import * as tl from 'azure-pipelines-task-lib/task';
import * as toolLib from 'azure-pipelines-tool-lib/tool';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

async function run(): Promise<void> {
    try {
        const rearmCliVersion = tl.getInput('rearmCliVersion', true) || '25.10.10';
        
        // Determine platform and architecture
        const platform = os.platform();
        const isWindows = platform === 'win32';
        
        console.log(`Platform: ${platform}`);
        console.log(`ReARM CLI Version: ${rearmCliVersion}`);
        
        // Construct download URL
        const platformSuffix = isWindows ? 'windows-amd64' : 'linux-amd64';
        const downloadUrl = `https://d7ge14utcyki8.cloudfront.net/rearm-download/${rearmCliVersion}/rearm-${rearmCliVersion}-${platformSuffix}.zip`;
        
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
