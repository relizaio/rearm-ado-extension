import * as tl from 'azure-pipelines-task-lib/task';
import { execSync } from 'child_process';

async function run(): Promise<void> {
    try {
        const rearmApiKey = tl.getInput('rearmApiKey', true)!;
        const rearmApiKeyId = tl.getInput('rearmApiKeyId', true)!;
        const rearmUrl = tl.getInput('rearmUrl', true)!;
        const repoPath = tl.getInput('repoPath', false) || '.';
        const branch = tl.getInput('branch', false) || tl.getVariable('Build.SourceBranchName') || '';
        const versionInput = tl.getInput('version', false) || '';
        
        // Get repository URI and commit from Azure DevOps predefined variables
        const vcsUri = tl.getVariable('Build.Repository.Uri') || '';
        const commit = tl.getVariable('Build.SourceVersion') || '';
        
        if (!vcsUri) {
            throw new Error('Build.Repository.Uri is not available');
        }
        if (!commit) {
            throw new Error('Build.SourceVersion is not available');
        }
        if (!branch) {
            throw new Error('Branch is not available');
        }
        
        console.log(`Repository URI: ${vcsUri}`);
        console.log(`Repository Path: ${repoPath}`);
        console.log(`Branch: ${branch}`);
        console.log(`Commit: ${commit}`);
        if (versionInput) {
            console.log(`Version (from input): ${versionInput}`);
        } else {
            console.log('Version will be obtained from ReARM');
        }
        
        // Find rearm in PATH
        const rearmPath = tl.which('rearm', true);
        
        // Step 1: Sync branches
        console.log('Synchronizing branches with ReARM...');
        let liveBranches: string;
        try {
            const gitOutput = execSync('git branch -r --format="%(refname)"', {
                encoding: 'utf-8',
                cwd: repoPath
            });
            liveBranches = Buffer.from(gitOutput).toString('base64').replace(/\n/g, '');
        } catch (err) {
            throw new Error(`Failed to get git branches: ${err}`);
        }
        
        const syncBranches = tl.tool(rearmPath);
        syncBranches.arg('syncbranches');
        syncBranches.arg(['-k', rearmApiKey]);
        syncBranches.arg(['-i', rearmApiKeyId]);
        syncBranches.arg(['-u', rearmUrl]);
        syncBranches.arg(['--vcsuri', vcsUri]);
        syncBranches.arg(['--repo-path', repoPath]);
        syncBranches.arg(['--livebranches', liveBranches]);
        
        const syncResult = await syncBranches.execAsync();
        if (syncResult !== 0) {
            throw new Error(`ReARM syncbranches failed with exit code ${syncResult}`);
        }
        console.log('Branches synchronized successfully');
        
        // Step 2: Get latest release and check if build is needed
        console.log('Checking for changes since last release...');
        let doBuild = false;
        let lastCommit = '';
        
        try {
            const getLatestCmd = `"${rearmPath}" getlatestrelease -k "${rearmApiKey}" -i "${rearmApiKeyId}" -u "${rearmUrl}" --vcsuri "${vcsUri}" --repo-path "${repoPath}" --branch "${branch}"`;
            const latestReleaseOutput = execSync(getLatestCmd, {
                encoding: 'utf-8',
                cwd: repoPath
            });
            
            const releaseData = JSON.parse(latestReleaseOutput);
            lastCommit = releaseData?.sourceCodeEntryDetails?.commit || '';
            console.log(`Last Commit: ${lastCommit}`);
            
            if (lastCommit && lastCommit !== 'null') {
                // Check for diff
                try {
                    const diffOutput = execSync(`git diff ${lastCommit}..${commit} ${repoPath}`, {
                        encoding: 'utf-8',
                        cwd: repoPath
                    });
                    const diffLines = diffOutput.split('\n').length;
                    if (diffLines > 0 && diffOutput.trim() !== '') {
                        doBuild = true;
                    }
                } catch (diffErr) {
                    // If diff fails (e.g., commit not found), do build
                    console.log('Diff check failed, assuming build is needed');
                    doBuild = true;
                }
            } else {
                doBuild = true;
            }
        } catch (err) {
            // No previous release found, do build
            console.log('No previous release found, build is needed');
            doBuild = true;
        }
        
        console.log(`DO_BUILD: ${doBuild}`);
        
        // Set output variables
        tl.setVariable('DO_BUILD', String(doBuild));
        tl.setVariable('DoBuild', String(doBuild), false, true);
        tl.setVariable('LAST_COMMIT', lastCommit);
        tl.setVariable('LastCommit', lastCommit, false, true);
        
        // Set BUILD_START for use in finalize task
        const buildStart = new Date().toISOString();
        tl.setVariable('BUILD_START', buildStart);
        
        // Step 3: If build is needed, create pending release
        let fullVersion = '';
        let shortVersion = '';
        
        if (doBuild) {
            console.log('Initializing pending release...');
            
            // Get commit message and date
            let commitMessage = '';
            let commitDate = '';
            try {
                commitMessage = execSync("git log -1 --pretty=%s", {
                    encoding: 'utf-8',
                    cwd: repoPath
                }).trim();
                commitDate = execSync("git log -1 --date=iso-strict --pretty=%ad", {
                    encoding: 'utf-8',
                    cwd: repoPath
                }).trim();
            } catch (err) {
                console.log('Warning: Could not get commit details');
            }
            
            // Get commits since last release for getversion command
            let commitsBase64 = '';
            try {
                let commitsOutput: string;
                if (lastCommit && lastCommit !== 'null') {
                    commitsOutput = execSync(
                        `git log ${lastCommit}..${commit} --date=iso-strict --pretty=%H|||%ad|||%s|||%an|||%ae -- ./`,
                        { encoding: 'utf-8', cwd: repoPath }
                    );
                } else {
                    commitsOutput = execSync(
                        `git log -1 --date=iso-strict --pretty=%H|||%ad|||%s|||%an|||%ae`,
                        { encoding: 'utf-8', cwd: repoPath }
                    );
                }
                if (commitsOutput.trim()) {
                    commitsBase64 = Buffer.from(commitsOutput).toString('base64');
                }
            } catch (err) {
                console.log('Warning: Could not get commits history');
            }
            
            if (versionInput) {
                // Version provided - use addrelease with provided version
                const addRelease = tl.tool(rearmPath);
                addRelease.arg('addrelease');
                addRelease.arg(['-k', rearmApiKey]);
                addRelease.arg(['-i', rearmApiKeyId]);
                addRelease.arg(['-u', rearmUrl]);
                addRelease.arg(['--commit', commit]);
                if (commitMessage) {
                    addRelease.arg(['--commitmessage', commitMessage]);
                }
                if (commitDate) {
                    addRelease.arg(['--date', commitDate]);
                }
                addRelease.arg(['--vcstype', 'git']);
                addRelease.arg(['--vcsuri', vcsUri]);
                addRelease.arg(['--repo-path', repoPath]);
                addRelease.arg(['--branch', branch]);
                addRelease.arg(['--lifecycle', 'PENDING']);
                addRelease.arg(['--version', versionInput]);
                if (commitsBase64) {
                    addRelease.arg(['--commits', commitsBase64]);
                }
                
                const addResult = await addRelease.execAsync();
                if (addResult !== 0) {
                    throw new Error(`ReARM addrelease failed with exit code ${addResult}`);
                }
                
                // Both versions are the same when provided via input
                fullVersion = versionInput;
                shortVersion = versionInput;
                console.log('Pending release initialized successfully with provided version');
            } else {
                // No version provided - use getversion to obtain version and create pending release
                console.log('Getting version from ReARM...');
                
                let getVersionOutput = '';
                const getVersion = tl.tool(rearmPath);
                getVersion.arg('getversion');
                getVersion.arg(['-k', rearmApiKey]);
                getVersion.arg(['-i', rearmApiKeyId]);
                getVersion.arg(['-u', rearmUrl]);
                getVersion.arg(['-b', branch]);
                getVersion.arg(['--commit', commit]);
                if (commitMessage) {
                    getVersion.arg(['--commitmessage', commitMessage]);
                }
                if (commitDate) {
                    getVersion.arg(['--date', commitDate]);
                }
                getVersion.arg(['--vcstype', 'git']);
                getVersion.arg(['--vcsuri', vcsUri]);
                getVersion.arg(['--repo-path', repoPath]);
                if (commitsBase64) {
                    getVersion.arg(['--commits', commitsBase64]);
                }
                
                const execOptions: any = {
                    listeners: {
                        stdout: (data: Buffer) => {
                            getVersionOutput += data.toString();
                        }
                    }
                };
                
                const getVersionResult = await getVersion.execAsync(execOptions);
                if (getVersionResult !== 0) {
                    throw new Error(`ReARM getversion failed with exit code ${getVersionResult}`);
                }
                
                // Parse version from JSON response
                try {
                    const versionData = JSON.parse(getVersionOutput.trim());
                    fullVersion = versionData.version || '';
                    shortVersion = versionData.dockerTagSafeVersion || fullVersion;
                    console.log(`Got version from ReARM: ${fullVersion}`);
                } catch (parseErr) {
                    throw new Error(`Failed to parse version response: ${getVersionOutput}`);
                }
                
                console.log('Pending release initialized successfully via getversion');
            }
        } else {
            console.log('No changes detected, skipping build');
            // Set empty versions when no build needed
            fullVersion = '';
            shortVersion = '';
        }
        
        // Set version variables
        tl.setVariable('REARM_FULL_VERSION', fullVersion);
        tl.setVariable('RearmFullVersion', fullVersion, false, true);
        tl.setVariable('REARM_SHORT_VERSION', shortVersion);
        tl.setVariable('RearmShortVersion', shortVersion, false, true);
        console.log(`Full Version: ${fullVersion}`);
        console.log(`Short Version: ${shortVersion}`);
        
        // Set REARM_COMMAND for rejected lifecycle (for use in later steps if needed)
        tl.setVariable('REARM_COMMAND', '--lifecycle REJECTED ');
        
        tl.setResult(tl.TaskResult.Succeeded, doBuild ? 'Release initialized' : 'No build needed');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

run();
