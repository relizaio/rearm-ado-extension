import * as tl from 'azure-pipelines-task-lib/task';
import { execSync } from 'child_process';

async function run(): Promise<void> {
    try {
        const rearmApiKey = tl.getInput('rearmApiKey', true)!;
        const rearmApiKeyId = tl.getInput('rearmApiKeyId', true)!;
        const rearmUrl = tl.getInput('rearmUrl', true)!;
        const repoPath = tl.getInput('repoPath', false) || '.';
        const branch = tl.getInput('branch', false) || tl.getVariable('Build.SourceBranchName') || '';
        const version = tl.getInput('version', true)!;
        
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
        console.log(`Version: ${version}`);
        
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
        
        // Step 3: If build is needed, create pending release; otherwise mark as rejected
        if (doBuild) {
            console.log('Initializing pending release...');
            
            // Get commit message and date
            let commitMessage = '';
            let commitDate = '';
            try {
                commitMessage = execSync("git log -1 --pretty='%s'", {
                    encoding: 'utf-8',
                    cwd: repoPath
                }).trim();
                commitDate = execSync("git log -1 --date=iso-strict --pretty='%ad'", {
                    encoding: 'utf-8',
                    cwd: repoPath
                }).trim();
            } catch (err) {
                console.log('Warning: Could not get commit details');
            }
            
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
            addRelease.arg(['--version', version]);
            
            const addResult = await addRelease.execAsync();
            if (addResult !== 0) {
                throw new Error(`ReARM addrelease failed with exit code ${addResult}`);
            }
            console.log('Pending release initialized successfully');
        } else {
            console.log('No changes detected, skipping build');
        }
        // Set REARM_COMMAND for rejected lifecycle (for use in later steps if needed)
        tl.setVariable('REARM_COMMAND', '--lifecycle REJECTED ');
        
        tl.setResult(tl.TaskResult.Succeeded, doBuild ? 'Release initialized' : 'No build needed');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

run();
