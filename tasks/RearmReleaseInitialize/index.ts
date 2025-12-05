import * as tl from 'azure-pipelines-task-lib/task';
import { spawnSync } from 'child_process';

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
            let branches = '';
            
            // First try git ls-remote (works best on Linux)
            const lsRemoteResult = spawnSync('git', ['ls-remote', '--heads', 'origin'], {
                encoding: 'utf-8',
                cwd: repoPath
            });
            const lsRemoteOutput = lsRemoteResult.stdout || '';
            
            if (lsRemoteOutput.trim()) {
                // Convert ls-remote output (hash\trefs/heads/branch) to refs/remotes/origin/branch format
                branches = lsRemoteOutput
                    .split('\n')
                    .filter(line => line.trim())
                    .map(line => {
                        const parts = line.split('\t');
                        if (parts.length >= 2) {
                            return parts[1].replace('refs/heads/', 'refs/remotes/origin/');
                        }
                        return '';
                    })
                    .filter(ref => ref)
                    .join('\n');
            }
            
            // Fallback: use git for-each-ref (works on Windows with cached refs)
            if (!branches) {
                const forEachRefResult = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                const forEachRefOutput = forEachRefResult.stdout || '';
                branches = forEachRefOutput
                    .split('\n')
                    .filter(line => line.trim() && !line.includes('/HEAD'))
                    .join('\n');
            }
            
            // Last fallback: fetch remote refs first, then try again
            if (!branches) {
                console.log('Fetching remote refs...');
                spawnSync('git', ['fetch', 'origin', '--prune'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                const forEachRefResult = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                branches = (forEachRefResult.stdout || '')
                    .split('\n')
                    .filter(line => line.trim() && !line.includes('/HEAD'))
                    .join('\n');
            }
            
            console.log(`Found branches: ${branches || '(none)'}`);
            liveBranches = branches ? Buffer.from(branches).toString('base64').replace(/\n/g, '') : '';
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
            const getLatestResult = spawnSync(rearmPath, [
                'getlatestrelease',
                '-k', rearmApiKey,
                '-i', rearmApiKeyId,
                '-u', rearmUrl,
                '--vcsuri', vcsUri,
                '--repo-path', repoPath,
                '--branch', branch
            ], { encoding: 'utf-8', cwd: repoPath });
            
            const latestReleaseOutput = getLatestResult.stdout || '';
            const releaseData = JSON.parse(latestReleaseOutput);
            lastCommit = releaseData?.sourceCodeEntryDetails?.commit || '';
            console.log(`Last Commit: ${lastCommit}`);
            
            if (lastCommit && lastCommit !== 'null') {
                // Check for diff
                try {
                    const diffResult = spawnSync('git', [
                        'diff', `${lastCommit}..${commit}`, repoPath
                    ], { encoding: 'utf-8', cwd: repoPath });
                    const diffOutput = diffResult.stdout || '';
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
                const msgResult = spawnSync('git', ['log', '-1', '--pretty=%s'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                commitMessage = (msgResult.stdout || '').trim();
                const dateResult = spawnSync('git', ['log', '-1', '--date=iso-strict', '--pretty=%ad'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                commitDate = (dateResult.stdout || '').trim();
            } catch (err) {
                console.log('Warning: Could not get commit details');
            }
            
            // Get commits since last release for getversion command
            let commitsBase64 = '';
            try {
                let commitsOutput: string;
                if (lastCommit && lastCommit !== 'null') {
                    const result = spawnSync('git', [
                        'log', `${lastCommit}..${commit}`,
                        '--date=iso-strict', '--pretty=%H|||%ad|||%s|||%an|||%ae', '--', './'
                    ], { encoding: 'utf-8', cwd: repoPath });
                    commitsOutput = result.stdout || '';
                } else {
                    const result = spawnSync('git', [
                        'log', '-1', '--date=iso-strict', '--pretty=%H|||%ad|||%s|||%an|||%ae'
                    ], { encoding: 'utf-8', cwd: repoPath });
                    commitsOutput = result.stdout || '';
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
                
                // Execute using spawnSync to reliably capture output
                const result = spawnSync(rearmPath, (getVersion as any).args, {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                
                getVersionOutput = (result.stdout || '') + (result.stderr || '');
                console.log(`ReARM getversion output: ${getVersionOutput}`);
                
                if (result.status !== 0) {
                    throw new Error(`ReARM getversion failed with exit code ${result.status}: ${getVersionOutput}`);
                }
                
                // Parse version from JSON response - find JSON object in output
                try {
                    const jsonMatch = getVersionOutput.match(/\{[^{}]*"version"[^{}]*\}/);
                    if (!jsonMatch) {
                        throw new Error('No JSON found in output');
                    }
                    const versionData = JSON.parse(jsonMatch[0]);
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
