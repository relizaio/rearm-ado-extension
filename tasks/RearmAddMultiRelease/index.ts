import * as tl from 'azure-pipelines-task-lib/task';
import { spawnSync } from 'child_process';

interface ArtifactTag {
    key: string;
    value: string;
}

interface DownloadLink {
    uri: string;
    content?: string;
}

interface ReleaseArtifact {
    displayIdentifier?: string;
    type: string;
    bomFormat?: string;
    storedIn?: string;
    filePath?: string;
    downloadLinks?: DownloadLink[];
    inventoryTypes?: string[];
    tags?: ArtifactTag[];
    artifacts?: ReleaseArtifact[];
}

interface Deliverable {
    odelId?: string;
    odelType?: string;
    odelDigests?: string | string[];
    odelPurl?: string;
    odelBuildId?: string;
    odelBuildUri?: string;
    odelCiMeta?: string;
    odelArtsJson?: ReleaseArtifact[];
}

interface ReleaseEntry {
    version: string;
    lifecycle?: string;
    repoPath?: string;
    vcsUri?: string;
    vcsDisplayName?: string;
    branch?: string;
    createComponent?: boolean;
    createComponentName?: string;
    createComponentVersionSchema?: string;
    createComponentBranchVersionSchema?: string;
    commits?: string;
    releaseArts?: ReleaseArtifact[];
    sceArts?: ReleaseArtifact[];
    datestart?: string;
    dateend?: string;
    deliverables?: Deliverable[];
}

function normalizeArtifactPaths(artifacts: ReleaseArtifact[]): ReleaseArtifact[] {
    return artifacts.map(art => {
        const normalized: ReleaseArtifact = {
            ...art,
            filePath: art.filePath ? art.filePath.replace(/\\/g, '/') : art.filePath
        };
        if (art.artifacts) {
            normalized.artifacts = normalizeArtifactPaths(art.artifacts);
        }
        return normalized;
    });
}

function serializeArtifacts(artifacts: ReleaseArtifact[]): string {
    return JSON.stringify(normalizeArtifactPaths(artifacts));
}

function normalizeDigests(digests: string | string[] | undefined): string | undefined {
    if (!digests) return undefined;
    if (Array.isArray(digests)) return digests.join(',');
    return digests;
}

function extractReleaseUuid(output: string): string | null {
    const jsonStart = output.indexOf('{"data":');
    if (jsonStart === -1) return null;
    try {
        let braceCount = 0;
        let jsonEnd = jsonStart;
        for (let i = jsonStart; i < output.length; i++) {
            if (output[i] === '{') braceCount++;
            if (output[i] === '}') braceCount--;
            if (braceCount === 0) {
                jsonEnd = i + 1;
                break;
            }
        }
        const releaseData = JSON.parse(output.substring(jsonStart, jsonEnd));
        return releaseData?.data?.addReleaseProgrammatic?.uuid || null;
    } catch {
        return null;
    }
}

async function syncBranchesForRepo(
    rearmPath: string,
    rearmApiKey: string,
    rearmApiKeyId: string,
    rearmUrl: string,
    vcsUri: string,
    repoPath: string
): Promise<void> {
    console.log('Synchronizing branches with ReARM...');
    let liveBranches: string = '';
    let skipBranchSync = false;

    try {
        const repoProvider = tl.getVariable('Build.Repository.Provider');
        const collectionUri = tl.getVariable('System.TeamFoundationCollectionUri');
        const project = tl.getVariable('System.TeamProject');
        // Note: Build.Repository.ID is always the primary pipeline repo. For secondary vcsUris
        // in multi-repo scenarios, the ADO API will still be attempted but its repoId belongs
        // to the primary repo — regular branches from git branch -r are still synced correctly.
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
        syncBranches.arg(['--livebranches', liveBranches]);

        const syncResult = await syncBranches.execAsync();
        if (syncResult !== 0) {
            throw new Error(`ReARM syncbranches failed with exit code ${syncResult}`);
        }
        console.log('Branches synchronized successfully');
    }
}

async function run(): Promise<void> {
    try {
        const rearmApiKey = tl.getInput('rearmApiKey', true)!;
        const rearmApiKeyId = tl.getInput('rearmApiKeyId', true)!;
        const rearmUrl = tl.getInput('rearmUrl', true)!;
        const allowRebuild = tl.getBoolInput('allowRebuild', false);
        const releasesInput = tl.getInput('releases', true)!;

        const defaultVcsUri = tl.getVariable('Build.Repository.Uri') || '';
        const defaultCommit = tl.getVariable('Build.SourceVersion') || '';
        const rearmPath = tl.which('rearm', true);

        // Capture task start time once — used as default datestart for all releases
        const taskStartTime = new Date().toISOString();

        // Parse releases JSON.
        // Pre-process: escape lone backslashes that may appear when ADO expands pipeline
        // variables containing Windows paths (e.g. $(Pipeline.Workspace) -> D:\a\1\s)
        // into the JSON string before the agent passes it to the task.
        // Only backslashes NOT already forming a valid JSON escape sequence are escaped.
        const sanitizedReleasesInput = releasesInput.replace(/\\(?![\\"])/g, '\\\\');
        let releases: ReleaseEntry[];
        try {
            releases = JSON.parse(sanitizedReleasesInput);
            if (!Array.isArray(releases)) {
                throw new Error('releases input must be a JSON array');
            }
        } catch (err: any) {
            throw new Error(`Failed to parse releases JSON: ${err.message}`);
        }

        // Validation 1: each release must have a version
        for (let i = 0; i < releases.length; i++) {
            if (!releases[i].version) {
                throw new Error(`Release at index ${i} is missing required field 'version'`);
            }
        }

        // Validation 2: no duplicate (vcsUri, repoPath, version) tuples
        const tupleSet = new Set<string>();
        for (const rel of releases) {
            const uri = rel.vcsUri || defaultVcsUri;
            const path = rel.repoPath || '.';
            const key = `${uri}::${path}::${rel.version}`;
            if (tupleSet.has(key)) {
                throw new Error(`Duplicate release entry: vcsUri=${uri}, repoPath=${path}, version=${rel.version}`);
            }
            tupleSet.add(key);
        }

        // Validation 3: same vcsUri cannot have conflicting vcsDisplayName values
        const displayNameMap = new Map<string, string>();
        for (const rel of releases) {
            const uri = rel.vcsUri || defaultVcsUri;
            if (rel.vcsDisplayName) {
                const existing = displayNameMap.get(uri);
                if (existing && existing !== rel.vcsDisplayName) {
                    throw new Error(
                        `Conflicting vcsDisplayName for vcsUri "${uri}": "${existing}" vs "${rel.vcsDisplayName}"`
                    );
                }
                displayNameMap.set(uri, rel.vcsDisplayName);
            }
        }

        // Track which (vcsUri, repoPath) pairs have had syncbranches called.
        // syncbranches runs once per unique pair, after the first successful addrelease for that pair.
        const syncedPairs = new Set<string>();

        // Process each release
        for (const rel of releases) {
            const repoPath = rel.repoPath || '.';
            const lifecycle = rel.lifecycle || 'ASSEMBLED';
            const vcsUri = rel.vcsUri || defaultVcsUri;

            if (!vcsUri) {
                throw new Error(
                    `vcsUri is not set for release version=${rel.version}: either provide 'vcsUri' in the release or ensure Build.Repository.Uri is available`
                );
            }

            // Resolve branch
            let branch = rel.branch || '';
            if (!branch) {
                const branchResult = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                branch = (branchResult.stdout || '').trim();
                if (!branch || branch === 'HEAD') {
                    // Detached HEAD — fall back to Build.SourceBranch
                    branch = tl.getVariable('Build.SourceBranch') || '';
                }
            }
            if (!branch) {
                throw new Error(`Could not determine branch for release version=${rel.version}, repoPath=${repoPath}`);
            }

            // Resolve HEAD commit
            let commit: string;
            if (!rel.vcsUri || rel.vcsUri === defaultVcsUri) {
                commit = defaultCommit;
            } else {
                const commitResult = spawnSync('git', ['rev-parse', 'HEAD'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                commit = (commitResult.stdout || '').trim();
            }
            if (!commit) {
                throw new Error(`Could not determine HEAD commit for release version=${rel.version}, repoPath=${repoPath}`);
            }

            console.log(`\nProcessing release: version=${rel.version}, repoPath=${repoPath}, vcsUri=${vcsUri}, branch=${branch}`);

            // Call getlatestrelease to obtain lastCommit (for commits range only — no diff check, version is always from pipeline)
            let lastCommit = '';
            try {
                const getLatestArgs = [
                    'getlatestrelease',
                    '-k', rearmApiKey,
                    '-i', rearmApiKeyId,
                    '-u', rearmUrl,
                    '--vcsuri', vcsUri,
                    '--repo-path', repoPath,
                    '--branch', branch
                ];
                const getLatestResult = spawnSync(rearmPath, getLatestArgs, { encoding: 'utf-8', cwd: repoPath });
                const latestOutput = (getLatestResult.stdout || '').trim();
                if (latestOutput) {
                    const releaseData = JSON.parse(latestOutput);
                    lastCommit = releaseData?.sourceCodeEntryDetails?.commit || '';
                }
                console.log(`Last commit from ReARM: ${lastCommit || '(none)'}`);
            } catch {
                console.log('No previous release found for this component, proceeding with build');
            }

            // Version is always provided by pipeline in this task — always proceed with release creation
            console.log(`Version provided by pipeline (${rel.version}), skipping change detection, proceeding with release creation`);

            // Get commit message and date
            let commitMessage = '';
            let commitDate = '';
            try {
                const msgResult = spawnSync('git', ['log', '-1', '--pretty=%s'], { encoding: 'utf-8', cwd: repoPath });
                commitMessage = (msgResult.stdout || '').trim();
                const dateResult = spawnSync('git', ['log', '-1', '--date=iso-strict', '--pretty=%ad'], {
                    encoding: 'utf-8',
                    cwd: repoPath
                });
                commitDate = (dateResult.stdout || '').trim();
            } catch {
                console.log('Warning: Could not get commit details');
            }

            // Resolve commits history
            let commitsBase64 = rel.commits || '';
            if (!commitsBase64) {
                try {
                    let commitsOutput: string;
                    if (lastCommit && lastCommit !== 'null') {
                        const result = spawnSync('git', [
                            'log', '-100', `${lastCommit}..${commit}`,
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
                } catch {
                    console.log('Warning: Could not get commits history');
                }
            }

            // Resolve datestart
            const dateStart = rel.datestart || taskStartTime;

            // Serialize and normalize artifact paths
            const sceArtsNorm = rel.sceArts && rel.sceArts.length > 0 ? serializeArtifacts(rel.sceArts) : undefined;
            const releaseArtsNorm = rel.releaseArts && rel.releaseArts.length > 0 ? serializeArtifacts(rel.releaseArts) : undefined;

            // Determine deliverables list (empty array means one call with no deliverable flags)
            const deliverables = rel.deliverables && rel.deliverables.length > 0
                ? rel.deliverables
                : [null];

            let releaseUuid: string | null = null;
            let firstCall = true;

            for (const deliverable of deliverables) {
                // dateend set just before each addrelease call
                const dateEnd = rel.dateend || new Date().toISOString();

                const addRelease = tl.tool(rearmPath);
                addRelease.arg('addrelease');
                addRelease.arg(['-k', rearmApiKey]);
                addRelease.arg(['-i', rearmApiKeyId]);
                addRelease.arg(['-u', rearmUrl]);
                addRelease.arg(['-b', branch]);
                addRelease.arg(['-v', rel.version]);
                addRelease.arg(['--vcsuri', vcsUri]);
                addRelease.arg(['--repo-path', repoPath]);
                addRelease.arg(['--vcstype', 'git']);
                addRelease.arg(['--lifecycle', lifecycle]);
                addRelease.arg(['--commit', commit]);

                if (commitMessage) {
                    addRelease.arg(['--commitmessage', commitMessage]);
                }
                if (commitDate) {
                    addRelease.arg(['--date', commitDate]);
                }
                if (commitsBase64) {
                    addRelease.arg(['--commits', commitsBase64]);
                }

                addRelease.arg(['--datestart', dateStart]);
                addRelease.arg(['--dateend', dateEnd]);

                // Deliverable flags (only if odelId is present)
                if (deliverable && deliverable.odelId) {
                    addRelease.arg(['--odelid', deliverable.odelId]);

                    if (deliverable.odelType) {
                        addRelease.arg(['--odeltype', deliverable.odelType]);
                    }
                    const digests = normalizeDigests(deliverable.odelDigests);
                    if (digests) {
                        addRelease.arg(['--odeldigests', digests]);
                    }
                    if (deliverable.odelPurl) {
                        addRelease.arg(['--odelidentifiers', `PURL:${deliverable.odelPurl}`]);
                    }
                    const buildId = deliverable.odelBuildId ||
                        `azuredevops${tl.getVariable('Build.BuildNumber') || ''}`;
                    if (buildId) {
                        addRelease.arg(['--odelbuildid', buildId]);
                    }
                    const buildUri = deliverable.odelBuildUri || tl.getVariable('Build.BuildUri') || '';
                    if (buildUri) {
                        addRelease.arg(['--odelbuilduri', buildUri]);
                    }
                    const ciMeta = deliverable.odelCiMeta || 'azuredevops';
                    addRelease.arg(['--odelcimeta', ciMeta]);

                    if (deliverable.odelArtsJson && deliverable.odelArtsJson.length > 0) {
                        addRelease.arg(['--odelartsjson', serializeArtifacts(deliverable.odelArtsJson)]);
                    }
                }

                if (sceArtsNorm) {
                    addRelease.arg(['--scearts', sceArtsNorm]);
                }
                if (releaseArtsNorm) {
                    addRelease.arg(['--releasearts', releaseArtsNorm]);
                }

                // Component creation options
                if (rel.createComponent) {
                    addRelease.arg(['--createcomponent', 'true']);
                    if (rel.createComponentName) {
                        addRelease.arg(['--createcomponent-name', rel.createComponentName]);
                    }
                    addRelease.arg([
                        '--createcomponent-version-schema',
                        rel.createComponentVersionSchema || 'semver'
                    ]);
                    addRelease.arg([
                        '--createcomponent-branch-version-schema',
                        rel.createComponentBranchVersionSchema || 'semver'
                    ]);
                    if (rel.vcsDisplayName) {
                        addRelease.arg(['--vcs-display-name', rel.vcsDisplayName]);
                    }
                }

                // Rebuild flag: set if global allowRebuild, or if this is a subsequent deliverable call
                if (allowRebuild || !firstCall) {
                    addRelease.arg(['--rebuild', 'true']);
                }

                console.log(`Submitting addrelease${deliverable?.odelId ? ` (deliverable: ${deliverable.odelId})` : ''}...`);

                const result = spawnSync(rearmPath, (addRelease as any).args, {
                    encoding: 'utf-8',
                    cwd: repoPath
                });

                const rearmOutput = (result.stdout || '') + (result.stderr || '');
                console.log(`ReARM output: ${rearmOutput}`);

                if (result.status !== 0) {
                    throw new Error(
                        `ReARM addrelease failed for version=${rel.version}` +
                        (deliverable?.odelId ? `, deliverable=${deliverable.odelId}` : '') +
                        ` with exit code ${result.status}: ${rearmOutput}`
                    );
                }

                // Extract UUID from the first successful call
                if (firstCall) {
                    releaseUuid = extractReleaseUuid(rearmOutput);
                    if (releaseUuid) {
                        console.log(`Release UUID: ${releaseUuid}`);
                    } else {
                        console.log('Warning: Could not extract release UUID from addrelease output');
                    }
                    firstCall = false;

                    // Sync branches after first successful addrelease for this (vcsUri, repoPath) pair.
                    // Done here (not before the loop) so the component already exists in ReARM when
                    // syncbranches is called — important when createComponent is true.
                    const syncKey = `${vcsUri}::${repoPath}`;
                    if (!syncedPairs.has(syncKey)) {
                        syncedPairs.add(syncKey);
                        await syncBranchesForRepo(rearmPath, rearmApiKey, rearmApiKeyId, rearmUrl, vcsUri, repoPath);
                    }
                }
            }

            // Run releasefinalizer if lifecycle is ASSEMBLED
            if (lifecycle === 'ASSEMBLED' && releaseUuid) {
                console.log(`Finalizing release UUID: ${releaseUuid}`);
                const finalizer = tl.tool(rearmPath);
                finalizer.arg('releasefinalizer');
                finalizer.arg(['--releaseid', releaseUuid]);
                finalizer.arg(['-k', rearmApiKey]);
                finalizer.arg(['-i', rearmApiKeyId]);
                finalizer.arg(['-u', rearmUrl]);

                const finalizerResult = await finalizer.execAsync();
                if (finalizerResult !== 0) {
                    throw new Error(`ReARM releasefinalizer failed for version=${rel.version} with exit code ${finalizerResult}`);
                }
                console.log(`Release ${rel.version} finalized successfully`);
            } else if (lifecycle === 'ASSEMBLED' && !releaseUuid) {
                console.log(`Warning: lifecycle is ASSEMBLED but no release UUID was extracted for version=${rel.version}. Skipping releasefinalizer.`);
            }

            console.log(`Release ${rel.version} processed successfully`);
        }

        tl.setResult(tl.TaskResult.Succeeded, 'All releases processed successfully');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

run();
