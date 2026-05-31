import * as tl from 'azure-pipelines-task-lib/task';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function cleanRef(ref: string): string {
    return ref.replace(/^refs\/heads\//, '');
}

// Best-effort web URL of an Azure Repos pull request. For non-TfsGit providers
// (e.g. GitHub-connected pipelines) the endpoint is left unset rather than guessed.
function buildPrEndpoint(identity: string): string {
    if (!identity) return '';
    const provider = tl.getVariable('Build.Repository.Provider') || '';
    if (provider === 'TfsGit') {
        const collectionUri = tl.getVariable('System.TeamFoundationCollectionUri') || '';
        const project = tl.getVariable('System.TeamProject') || '';
        const repoName = tl.getVariable('Build.Repository.Name') || '';
        if (collectionUri && project && repoName) {
            return `${collectionUri}${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${identity}`;
        }
    } else if (provider === 'GitHub' || provider === 'GitHubEnterprise') {
        const repoUri = (tl.getVariable('Build.Repository.Uri') || '').replace(/\.git$/, '').replace(/\/$/, '');
        if (repoUri) {
            return `${repoUri}/pull/${identity}`;
        }
    }
    return '';
}

// First-class PullRequest flags for getversion/addrelease on PR-validation builds.
// Empty when this is not a PR build.
function buildPrArgs(): string[] {
    const isPrBuild = tl.getVariable('Build.Reason') === 'PullRequest'
        || !!tl.getVariable('System.PullRequest.PullRequestId');
    if (!isPrBuild) {
        return [];
    }
    // For GitHub-backed pipelines ADO assigns an internal PullRequestId that differs
    // from the GitHub PR number; PullRequestNumber carries the real SCM-side number.
    // Prefer it so the identity matches what other producers (e.g. the GitHub Action)
    // use and both converge on the same first-class PullRequest. Azure Repos leaves
    // PullRequestNumber empty, so fall back to PullRequestId (the PR number there).
    const identity = tl.getVariable('System.PullRequest.PullRequestNumber')
        || tl.getVariable('System.PullRequest.PullRequestId') || '';
    if (!identity) {
        return [];
    }
    const prArgs = ['--pr-identity', identity, '--pr-state', 'OPEN'];
    const prSourceBranch = tl.getVariable('System.PullRequest.SourceBranch') || '';
    const prTargetBranch = tl.getVariable('System.PullRequest.TargetBranch') || '';
    if (prSourceBranch) prArgs.push('--pr-source-branch-name', cleanRef(prSourceBranch));
    if (prTargetBranch) prArgs.push('--pr-target-branch-name', cleanRef(prTargetBranch));
    const prEndpoint = buildPrEndpoint(identity);
    if (prEndpoint) prArgs.push('--pr-endpoint', prEndpoint);
    return prArgs;
}

interface LatestReleaseResult {
    doBuild: boolean;
    lastCommit: string;
}

function getLatestRelease(
    rearmPath: string,
    rearmApiKey: string,
    rearmApiKeyId: string,
    rearmUrl: string,
    vcsUri: string,
    repoPath: string,
    branch: string,
    commit: string,
    uptoVersion?: string
): LatestReleaseResult {
    const getLatestArgs = [
        'getlatestrelease',
        '-k', rearmApiKey,
        '-i', rearmApiKeyId,
        '-u', rearmUrl,
        '--vcsuri', vcsUri,
        '--repo-path', repoPath,
        '--branch', branch
    ];
    if (uptoVersion) {
        getLatestArgs.push('--uptoversion', uptoVersion);
    }
    
    const getLatestResult = spawnSync(rearmPath, getLatestArgs, { encoding: 'utf-8', cwd: repoPath });
    const latestReleaseOutput = getLatestResult.stdout || '';
    const releaseData = JSON.parse(latestReleaseOutput);
    const lastCommit = releaseData?.sourceCodeEntryDetails?.commit || '';
    console.log(`Last Commit: ${lastCommit}`);
    
    let doBuild = false;
    if (lastCommit && lastCommit !== 'null') {
        // Check if lastCommit exists locally (may not in shallow checkout)
        const commitExistsResult = spawnSync('git', ['cat-file', '-t', lastCommit], {
            encoding: 'utf-8',
            cwd: repoPath
        });
        const commitExists = commitExistsResult.status === 0;
        
        if (!commitExists) {
            console.log(`Last commit ${lastCommit} not available locally (shallow checkout), assuming build is needed. Make sure to use fetchDepth: 0 in your pipeline checkout step to avoid shallow clone.`);
            doBuild = true;
        } else {
            // Check for diff
            try {
                const diffResult = spawnSync('git', [
                    'diff', `${lastCommit}..${commit}`, '--', './'
                ], { encoding: 'utf-8', cwd: repoPath });
                const diffOutput = diffResult.stdout || '';
                if (diffOutput.trim() !== '') {
                    doBuild = true;
                }
            } catch (diffErr) {
                // If diff fails, do build
                console.log('Diff check failed, assuming build is needed');
                doBuild = true;
            }
        }
    } else {
        doBuild = true;
    }
    
    return { doBuild, lastCommit };
}

async function run(): Promise<void> {
    try {
        const rearmApiKey = tl.getInput('rearmApiKey', true)!;
        const rearmApiKeyId = tl.getInput('rearmApiKeyId', true)!;
        const rearmUrl = tl.getInput('rearmUrl', true)!;
        const repoPath = tl.getInput('repoPath', false) || '.';
        // On Azure DevOps PR-validation builds Build.SourceBranch is the merge ref
        // (refs/pull/<id>/merge), which ReARM records as a legacy PULL_REQUEST branch.
        // Build on the PR's real source branch instead and carry PR identity/state via
        // the first-class PullRequest flags (buildPrArgs) below.
        const prSourceBranch = tl.getVariable('System.PullRequest.SourceBranch') || '';
        const isPrBuild = tl.getVariable('Build.Reason') === 'PullRequest'
            || !!tl.getVariable('System.PullRequest.PullRequestId');
        const prBuildBranch = (isPrBuild && prSourceBranch) ? prSourceBranch : tl.getVariable('Build.SourceBranch');
        const branch = tl.getInput('branch', false) || prBuildBranch || '';
        const prArgs = buildPrArgs();
        const versionInput = tl.getInput('version', false) || '';
        const createComponent = tl.getBoolInput('createComponent', false);
        const createComponentVersionSchema = tl.getInput('createComponentVersionSchema', false) || 'semver';
        const createComponentBranchVersionSchema = tl.getInput('createComponentBranchVersionSchema', false) || 'semver';
        const vcsDisplayName = tl.getInput('vcsDisplayName', false);
        const allowRebuild = tl.getBoolInput('allowRebuild', false);
        
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
        
        // Step 1: Get latest release and check if build is needed
        let doBuild = false;
        let lastCommit = '';
        
        if (versionInput) {
            // Version provided by pipeline - always build
            console.log('Version provided by pipeline, skipping change detection, DO_BUILD=true');
            doBuild = true;
        } else {
            console.log('Checking for changes since last release...');
            try {
                const latestResult = getLatestRelease(
                    rearmPath, rearmApiKey, rearmApiKeyId, rearmUrl,
                    vcsUri, repoPath, branch, commit
                );
                doBuild = latestResult.doBuild;
                lastCommit = latestResult.lastCommit;
            } catch (err) {
                // No previous release found, do build
                console.log('No previous release found, build is needed');
                doBuild = true;
            }
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
                if (prArgs.length > 0) {
                    addRelease.arg(prArgs);
                }
                addRelease.arg(['--lifecycle', 'PENDING']);
                addRelease.arg(['--version', versionInput]);
                if (commitsBase64) {
                    addRelease.arg(['--commits', commitsBase64]);
                }
                if (createComponent) {
                    addRelease.arg(['--createcomponent', 'true']);
                    addRelease.arg(['--createcomponent-version-schema', createComponentVersionSchema]);
                    addRelease.arg(['--createcomponent-branch-version-schema', createComponentBranchVersionSchema]);
                }
                if (allowRebuild) {
                    addRelease.arg(['--rebuild', 'true']);
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
                if (prArgs.length > 0) {
                    getVersion.arg(prArgs);
                }
                if (commitsBase64) {
                    getVersion.arg(['--commits', commitsBase64]);
                }
                if (createComponent) {
                    getVersion.arg(['--createcomponent', 'true']);
                    getVersion.arg(['--createcomponent-version-schema', createComponentVersionSchema]);
                    getVersion.arg(['--createcomponent-branch-version-schema', createComponentBranchVersionSchema]);
                    if (vcsDisplayName) {
                        getVersion.arg(['--vcs-display-name', vcsDisplayName]);
                    }
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
                    const releaseAlreadyExists = versionData.releaseAlreadyExists === true;
                    console.log(`Got version from ReARM: ${fullVersion}`);
                    
                    // If release already exists and no input version was provided, re-check with the obtained version
                    if (releaseAlreadyExists) {
                        console.log('Release already exists, re-checking latest release with obtained version...');
                        try {
                            const latestResult = getLatestRelease(
                                rearmPath, rearmApiKey, rearmApiKeyId, rearmUrl,
                                vcsUri, repoPath, branch, commit, fullVersion
                            );
                            doBuild = latestResult.doBuild;
                            lastCommit = latestResult.lastCommit;
                            // Update the output variables with new values
                            tl.setVariable('DO_BUILD', String(doBuild));
                            tl.setVariable('DoBuild', String(doBuild), false, true);
                            tl.setVariable('LAST_COMMIT', lastCommit);
                            tl.setVariable('LastCommit', lastCommit, false, true);
                            console.log(`Updated DO_BUILD: ${doBuild}`);
                        } catch (err) {
                            console.log('Could not get latest release for existing version, keeping original doBuild value');
                        }
                    }
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

        // Step 2: Sync branches
        console.log('Synchronizing branches with ReARM...');
        let liveBranches: string = '';
        let skipBranchSync = false;
        
        try {
            const repoProvider = tl.getVariable('Build.Repository.Provider');
            const collectionUri = tl.getVariable('System.TeamFoundationCollectionUri');
            const project = tl.getVariable('System.TeamProject');
            const repoId = tl.getVariable('Build.Repository.ID');
            const accessToken = tl.getVariable('System.AccessToken');

            const validBranches: string[] = [];
            let rawLineCount = 0;

            if (repoProvider === 'GitHub' || repoProvider === 'GitHubEnterprise') {
                // Query remote directly — gets all branches including those not fetched locally
                const result = spawnSync('git', ['ls-remote', 'origin', 'refs/heads/*'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                const gitOutput = (result.stdout || '').trim();
                console.log(`Git ls-remote heads output: ${gitOutput || '(empty)'}`);
                const lines = gitOutput.split('\n').filter(l => l.trim());
                rawLineCount = lines.length;
                for (const line of lines) {
                    const parts = line.split('\t');
                    if (parts.length >= 2) {
                        const ref = parts[1].trim();
                        if (!/^[0-9a-f]{40}$/i.test(ref)) validBranches.push(ref);
                    }
                }
            } else {
                // ADO and others: use local remote-tracking cache
                const result = spawnSync('git', ['branch', '-r', '--format=%(refname)'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                const gitOutput = (result.stdout || '').trim();
                console.log(`Git branch output: ${gitOutput || '(empty)'}`);
                const lines = gitOutput.split('\n').filter(l => l.trim());
                rawLineCount = lines.length;
                for (const line of lines) {
                    const branchName = line.replace('refs/remotes/origin/', '');
                    if (!/^[0-9a-f]{40}$/i.test(branchName)) validBranches.push(line);
                }
            }

            // Fetch PR branches - use git ls-remote for GitHub, ADO REST API for TfsGit

            if (repoProvider === 'GitHub' || repoProvider === 'GitHubEnterprise') {
                try {
                    // Use refs/pull/*/merge (not refs/pull/*) because GitHub publishes two ref families per PR:
                    //   refs/pull/{id}/head  — the source branch tip; GitHub keeps this FOREVER (open and closed PRs)
                    //   refs/pull/{id}/merge — the would-be merge commit; exists ONLY while the PR is open and mergeable
                    // Fetching refs/pull/* would therefore include every historical closed/merged PR as a "live" branch.
                    // Filtering to refs/pull/*/merge gives us only currently open PRs.
                    const lsRemoteResult = spawnSync('git', ['ls-remote', 'origin', 'refs/pull/*/merge'], {
                        encoding: 'utf-8',
                        cwd: repoPath
                    });
                    const lsOutput = (lsRemoteResult.stdout || '').trim();
                    if (lsOutput) {
                        for (const line of lsOutput.split('\n').filter((l: string) => l.trim())) {
                            const parts = line.split('\t');
                            if (parts.length >= 2) {
                                const ref = parts[1].trim();
                                if (!validBranches.includes(ref)) {
                                    validBranches.push(ref);
                                    console.log(`Added PR branch: ${ref}`);
                                }
                            }
                        }
                        console.log(`Fetched PR refs via git ls-remote`);
                    } else {
                        console.log('No PR refs found via git ls-remote');
                    }
                } catch (lsErr) {
                    console.log(`Warning: Could not fetch PR refs via git ls-remote: ${lsErr}`);
                }
            } else if (collectionUri && project && repoId && accessToken) {
                try {
                    const apiUrl = `${collectionUri}${project}/_apis/git/repositories/${repoId}/pullrequests?searchCriteria.status=active&api-version=7.1`;
                    console.log(`Fetching active PRs from Azure DevOps API...`);

                    const https = require('https');
                    const http = require('http');
                    const url = new URL(apiUrl);
                    const httpModule = url.protocol === 'https:' ? https : http;

                    const prBranches = await new Promise<string[]>((resolve) => {
                        const req = httpModule.request(apiUrl, {
                            method: 'GET',
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/json'
                            }
                        }, (res: any) => {
                            let data = '';
                            res.on('data', (chunk: string) => data += chunk);
                            res.on('end', () => {
                                try {
                                    const json = JSON.parse(data);
                                    if (json.value && Array.isArray(json.value)) {
                                        const branches: string[] = [];
                                        for (const pr of json.value) {
                                            if (pr.sourceRefName) {
                                                branches.push(pr.sourceRefName);
                                            }
                                            if (pr.pullRequestId) {
                                                branches.push(`refs/pull/${pr.pullRequestId}/merge`);
                                            }
                                        }
                                        console.log(`Found ${json.value.length} active PRs, ${branches.length} total refs`);
                                        resolve(branches);
                                    } else {
                                        console.log('No PRs found or unexpected API response');
                                        resolve([]);
                                    }
                                } catch (e) {
                                    console.log(`Warning: Failed to parse PR API response: ${e}`);
                                    resolve([]);
                                }
                            });
                        });
                        req.on('error', (e: Error) => {
                            console.log(`Warning: PR API request failed: ${e.message}`);
                            resolve([]);
                        });
                        req.end();
                    });

                    for (const prBranch of prBranches) {
                        let remoteBranch: string;
                        if (prBranch.startsWith('refs/pull/')) {
                            remoteBranch = prBranch.replace('refs/pull/', 'refs/remotes/pull/');
                        } else {
                            remoteBranch = prBranch.replace('refs/heads/', 'refs/remotes/origin/');
                        }
                        if (!validBranches.includes(remoteBranch)) {
                            validBranches.push(remoteBranch);
                            console.log(`Added PR branch: ${remoteBranch}`);
                        }
                    }
                } catch (apiErr) {
                    console.log(`Warning: Could not fetch PRs from API: ${apiErr}`);
                }
            } else {
                console.log('Skipping PR branch fetch: no supported provider detected or ADO API variables not available');
            }
            
            if (validBranches.length === 0 && rawLineCount > 0) {
                // Output was non-empty but all lines were filtered (detached HEAD / shallow checkout)
                console.log('Warning: Only detached commit refs found (shallow/detached checkout). Skipping branch sync.');
                console.log('To enable branch sync, use fetchDepth: 0 in your pipeline checkout step.');
                skipBranchSync = true;
            } else if (validBranches.length === 0) {
                console.log('Warning: No branches found. Skipping branch sync.');
                console.log('To enable branch sync, use fetchDepth: 0 in your pipeline checkout step.');
                skipBranchSync = true;
            } else {
                liveBranches = Buffer.from(validBranches.join('\n')).toString('base64').replace(/\n/g, '');
            }
        } catch (err) {
            console.log(`Warning: Failed to get git branches: ${err}. Skipping branch sync.`);
            console.log(`Make sure you use fetchDepth: 0 in your pipeline checkout step.`);
            skipBranchSync = true;
        }
        
        if (!skipBranchSync) {
            const syncBranches = tl.tool(rearmPath);
            syncBranches.arg('syncbranches');
            syncBranches.arg(['-k', rearmApiKey]);
            syncBranches.arg(['-i', rearmApiKeyId]);
            syncBranches.arg(['-u', rearmUrl]);
            syncBranches.arg(['--vcsuri', vcsUri]);
            syncBranches.arg(['--repo-path', repoPath]);

            // For large branch payloads, write to a file to avoid shell argument length limits
            let liveBranchesFile = '';
            if (liveBranches.length > 2000) {
                liveBranchesFile = path.join(os.tmpdir(), `rearm-livebranches-${Date.now()}.b64`);
                fs.writeFileSync(liveBranchesFile, liveBranches);
                console.log(`Live branches payload is ${liveBranches.length} chars, using --livebranchesfile: ${liveBranchesFile}`);
                syncBranches.arg(['--livebranchesfile', liveBranchesFile]);
            } else {
                syncBranches.arg(['--livebranches', liveBranches]);
            }

            try {
                const syncResult = await syncBranches.execAsync();
                if (syncResult !== 0) {
                    throw new Error(`ReARM syncbranches failed with exit code ${syncResult}`);
                }
                console.log('Branches synchronized successfully');
            } finally {
                if (liveBranchesFile) {
                    try { fs.unlinkSync(liveBranchesFile); } catch { /* ignore cleanup errors */ }
                }
            }
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
