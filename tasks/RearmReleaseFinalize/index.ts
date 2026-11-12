import * as tl from 'azure-pipelines-task-lib/task';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// AI-agent attribution trailers, appended onto the commit subject so the ReARM
// backend's commit-trailer parser can read them (same format as RearmReleaseInitialize;
// both must send the same message, since ReARM keeps one entry per commit).
const AGENTIC_TRAILER_FMT = '%(trailers:key=ReARM-Agent,key=ReARM-Agentic-Session,unfold,separator=%x20)';

function cleanRef(ref: string): string {
    return ref.replace(/^refs\/heads\//, '');
}

// ReARM identifies (and names) a component by the repoPath it receives with the
// VCS URI, so that value must be a stable repository-relative path. The repoPath
// input is also the directory git and the CLI run in, and may be absolute, e.g.
// '$(Build.SourcesDirectory)/src/App', which resolves to an agent-local path such
// as 'D:\a\1\s\src\App'. An absolute path is converted to the path relative to
// the git repository root, with '/' separators ('.' for the root itself), so it
// identifies the same component as the equivalent relative path on any agent and
// OS. A relative path is sent unchanged, so existing components keep their identity.
function repoPathIdentity(repoPath: string): string {
    if (!path.isAbsolute(repoPath)) {
        return repoPath;
    }
    const hint = `Pass repoPath relative to the repository root (for example 'src/MyApp'), or an absolute path inside the checked-out repository.`;
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8', cwd: repoPath });
    const topLevel = (top.stdout || '').trim();
    if (top.status !== 0 || !topLevel) {
        throw new Error(`repoPath '${repoPath}' is an absolute path, but it is not a directory inside a git checkout, so its repository-relative path cannot be determined. ${hint}`);
    }
    let relative: string;
    try {
        relative = path.relative(fs.realpathSync.native(topLevel), fs.realpathSync.native(repoPath));
    } catch (err: any) {
        throw new Error(`repoPath '${repoPath}' could not be resolved: ${err.message}. ${hint}`);
    }
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error(`repoPath '${repoPath}' is outside the git repository at '${topLevel}'. ${hint}`);
    }
    const identity = relative === '' ? '.' : relative.split(path.sep).join('/');
    console.log(`Absolute repoPath '${repoPath}' identifies the component as repository path '${identity}'`);
    return identity;
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

// First-class PullRequest flags for addrelease on PR-validation builds.
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

async function run(): Promise<void> {
    try {
        // Check if we should run based on DO_BUILD
        const runOnCondition = tl.getBoolInput('runOnCondition', false);
        const doBuild = tl.getVariable('DO_BUILD');
        
        if (runOnCondition && doBuild !== 'true') {
            console.log('DO_BUILD is not true, skipping release finalization');
            tl.setResult(tl.TaskResult.Succeeded, 'Skipped - DO_BUILD is not true');
            return;
        }
        
        const rearmApiKey = tl.getInput('rearmApiKey', true)!;
        const rearmApiKeyId = tl.getInput('rearmApiKeyId', true)!;
        const rearmUrl = tl.getInput('rearmUrl', true)!;
        const repoPath = tl.getInput('repoPath', false) || '.';
        const repoPathId = repoPathIdentity(repoPath);
        // On PR-validation builds Build.SourceBranch is the merge ref
        // (refs/pull/<id>/merge); build on the PR's source branch instead so the
        // release lands on a real branch (matching RearmReleaseInitialize) and the
        // PR identity flows through the first-class PullRequest flags below.
        const prSourceBranch = tl.getVariable('System.PullRequest.SourceBranch') || '';
        const isPrBuild = tl.getVariable('Build.Reason') === 'PullRequest'
            || !!tl.getVariable('System.PullRequest.PullRequestId');
        const branch = (isPrBuild && prSourceBranch) ? prSourceBranch : (tl.getVariable('Build.SourceBranch') || '');
        const prArgs = buildPrArgs();
        const version = tl.getVariable('REARM_FULL_VERSION') || '';
        const lifecycle = tl.getInput('lifecycle', false) || 'ASSEMBLED';
        
        if (!branch) {
            throw new Error('Build.SourceBranch is not available.');
        }
        if (!version) {
            throw new Error('REARM_FULL_VERSION is not available. Make sure RearmReleaseInitialize task ran successfully.');
        }
        
        // Deliverable options
        const odelId = tl.getInput('odelId', false);
        const odelType = tl.getInput('odelType', false);
        const odelDigests = tl.getInput('odelDigests', false);
        const odelPurl = tl.getInput('odelPurl', false);
        const odelBuildId = tl.getInput('odelBuildId', false) || `azuredevops${tl.getVariable('Build.BuildNumber')}`;
        const odelBuildUri = tl.getInput('odelBuildUri', false) || tl.getVariable('Build.BuildUri') || '';
        const odelCiMeta = tl.getInput('odelCiMeta', false) || 'azuredevops';
        
        // Artifact options
        const odelArtsJson = tl.getInput('odelArtsJson', false);
        const sceArts = tl.getInput('sceArts', false);
        const releaseArts = tl.getInput('releaseArts', false);
        
        // Create component options
        const createComponent = tl.getBoolInput('createComponent', false);
        const createComponentVersionSchema = tl.getInput('createComponentVersionSchema', false) || 'semver';
        const createComponentBranchVersionSchema = tl.getInput('createComponentBranchVersionSchema', false) || 'semver';
        const vcsDisplayName = tl.getInput('vcsDisplayName', false);
        const perspective = tl.getInput('perspective', false) || '';
        const allowRebuild = tl.getBoolInput('allowRebuild', false);
        
                
        // Get repository URI and commit from Azure DevOps predefined variables
        const vcsUri = tl.getVariable('Build.Repository.Uri') || '';
        const commit = tl.getVariable('Build.SourceVersion') || '';
        const lastCommit = tl.getVariable('LAST_COMMIT') || '';
        const buildStart = tl.getVariable('BUILD_START') || '';
        
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
        console.log(`Repository Path sent to ReARM: ${repoPathId}`);
        console.log(`Branch: ${branch}`);
        console.log(`Commit: ${commit}`);
        console.log(`Version: ${version}`);
        console.log(`Lifecycle: ${lifecycle}`);
        
        // Find rearm in PATH
        const rearmPath = tl.which('rearm', true);
        
        // Build the addrelease command
        const addRelease = tl.tool(rearmPath);
        addRelease.arg('addrelease');
        addRelease.arg(['-k', rearmApiKey]);
        addRelease.arg(['-i', rearmApiKeyId]);
        addRelease.arg(['-u', rearmUrl]);
        addRelease.arg(['-b', branch]);
        if (prArgs.length > 0) {
            addRelease.arg(prArgs);
        }
        addRelease.arg(['-v', version]);
        addRelease.arg(['--vcsuri', vcsUri]);
        addRelease.arg(['--repo-path', repoPathId]);
        addRelease.arg(['--vcstype', 'git']);
        addRelease.arg(['--lifecycle', lifecycle]);
        
        // Add commit info
        addRelease.arg(['--commit', commit]);
        
        // Get commit message and date
        try {
            const msgResult = spawnSync('git', ['log', '-1', `--pretty=%s ${AGENTIC_TRAILER_FMT}`], {
                encoding: 'utf-8',
                cwd: repoPath
            });
            const commitMessage = (msgResult.stdout || '').trim();
            const dateResult = spawnSync('git', ['log', '-1', '--date=iso-strict', '--pretty=%ad'], {
                encoding: 'utf-8',
                cwd: repoPath
            });
            const commitDate = (dateResult.stdout || '').trim();
            
            if (commitMessage) {
                addRelease.arg(['--commitmessage', commitMessage]);
            }
            if (commitDate) {
                addRelease.arg(['--date', commitDate]);
            }
        } catch (err) {
            console.log('Warning: Could not get commit details');
        }
        
        // Include commits history
        try {
            let commitsOutput: string;
            if (lastCommit && lastCommit !== 'null') {
                // Get commits since last release
                const result = spawnSync('git', [
                    'log', '-100', `${lastCommit}..${commit}`,
                    '--date=iso-strict', `--pretty=%H|||%ad|||%s ${AGENTIC_TRAILER_FMT}|||%an|||%ae`, '--', './'
                ], { encoding: 'utf-8', cwd: repoPath });
                commitsOutput = result.stdout || '';
            } else {
                // No last commit available, use current commit only
                const result = spawnSync('git', [
                    'log', '-1', '--date=iso-strict', `--pretty=%H|||%ad|||%s ${AGENTIC_TRAILER_FMT}|||%an|||%ae`
                ], { encoding: 'utf-8', cwd: repoPath });
                commitsOutput = result.stdout || '';
            }
            if (commitsOutput.trim()) {
                const commitsBase64 = Buffer.from(commitsOutput).toString('base64');
                addRelease.arg(['--commits', commitsBase64]);
            }
        } catch (err) {
            console.log('Warning: Could not get commits history');
        }
        
        // Add deliverable info if provided
        if (odelId) {
            addRelease.arg(['--odelid', odelId]);
            
            if (odelType) {
                addRelease.arg(['--odeltype', odelType]);
            }
            if (odelDigests) {
                addRelease.arg(['--odeldigests', odelDigests]);
            }
            if (odelPurl) {
                addRelease.arg(['--odelidentifiers', `PURL:${odelPurl}`]);
            }
            if (odelBuildId) {
                addRelease.arg(['--odelbuildid', odelBuildId]);
            }
            if (odelBuildUri) {
                addRelease.arg(['--odelbuilduri', odelBuildUri]);
            }
            if (odelCiMeta) {
                addRelease.arg(['--odelcimeta', odelCiMeta]);
            }
            if (odelArtsJson) {
                // Normalize Windows backslashes to forward slashes in JSON paths
                const normalizedArtsJson = odelArtsJson.replace(/\\\\/g, '/').replace(/\\/g, '/');
                addRelease.arg(['--odelartsjson', normalizedArtsJson]);
            }
        }
        
        // Add source code entry artifacts
        if (sceArts) {
            // Normalize Windows backslashes to forward slashes in JSON paths
            const normalizedSceArts = sceArts.replace(/\\\\/g, '/').replace(/\\/g, '/');
            addRelease.arg(['--scearts', normalizedSceArts]);
        }
        
        // Add release artifacts
        if (releaseArts) {
            // Normalize Windows backslashes to forward slashes in JSON paths
            const normalizedReleaseArts = releaseArts.replace(/\\\\/g, '/').replace(/\\/g, '/');
            addRelease.arg(['--releasearts', normalizedReleaseArts]);
        }
        
        // Add build timing
        if (buildStart) {
            addRelease.arg(['--datestart', buildStart]);
        }
        const dateEnd = new Date().toISOString();
        addRelease.arg(['--dateend', dateEnd]);
        
        // Add create component options
        if (createComponent) {
            addRelease.arg(['--createcomponent', 'true']);
            addRelease.arg(['--createcomponent-version-schema', createComponentVersionSchema]);
            addRelease.arg(['--createcomponent-branch-version-schema', createComponentBranchVersionSchema]);
            if (vcsDisplayName) {
                addRelease.arg(['--vcs-display-name', vcsDisplayName]);
            }
            if (perspective) {
                addRelease.arg(['--perspective', perspective]);
            }
        }
        if (allowRebuild) {
            addRelease.arg(['--rebuild', 'true']);
        }
        
        console.log('Sending release metadata to ReARM...');
        
        // Execute using spawnSync to capture output (execAsync listeners don't work reliably)
        // We use 'any' cast to access private 'args' property to avoid reconstructing arguments
        const result = spawnSync(rearmPath, (addRelease as any).args, {
            encoding: 'utf-8',
            cwd: repoPath
        });
        
        const rearmOutput = (result.stdout || '') + (result.stderr || '');
        console.log(`ReARM output: ${rearmOutput}`);
        
        if (result.status !== 0) {
            throw new Error(`ReARM addrelease failed with exit code ${result.status}: ${rearmOutput}`);
        }

        tl.setResult(tl.TaskResult.Succeeded, 'Release metadata sent successfully');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

run();
