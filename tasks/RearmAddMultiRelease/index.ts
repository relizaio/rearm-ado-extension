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
    runOnCondition?: boolean;
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

            // Call getlatestrelease to obtain lastCommit (for diff check and commits range)
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

            // runOnCondition check — same diff logic as RearmReleaseInitialize
            const runOnCondition = rel.runOnCondition !== false; // default true
            if (runOnCondition) {
                if (lastCommit && lastCommit !== 'null') {
                    const commitExistsResult = spawnSync('git', ['cat-file', '-t', lastCommit], {
                        encoding: 'utf-8',
                        cwd: repoPath
                    });
                    if (commitExistsResult.status === 0) {
                        const diffResult = spawnSync('git', ['diff', `${lastCommit}..${commit}`, '--', './'], {
                            encoding: 'utf-8',
                            cwd: repoPath
                        });
                        const diffOutput = (diffResult.stdout || '').trim();
                        if (diffOutput === '') {
                            console.log(`No changes detected since last release for version=${rel.version}. Skipping.`);
                            continue;
                        }
                    } else {
                        console.log(
                            `Last commit ${lastCommit} not available locally (shallow checkout), assuming build is needed. ` +
                            `Use fetchDepth: 0 in your pipeline checkout step to avoid this.`
                        );
                    }
                } else {
                    console.log('No previous release found, proceeding with release creation');
                }
            }

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
