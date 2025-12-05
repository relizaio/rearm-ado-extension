import * as tl from 'azure-pipelines-task-lib/task';
import { execSync, spawnSync } from 'child_process';

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
        const branch = tl.getVariable('Build.SourceBranchName') || '';
        const version = tl.getVariable('REARM_FULL_VERSION') || '';
        const lifecycle = tl.getInput('lifecycle', false) || 'ASSEMBLED';
        
        if (!branch) {
            throw new Error('Build.SourceBranchName is not available.');
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
        addRelease.arg(['-v', version]);
        addRelease.arg(['--vcsuri', vcsUri]);
        addRelease.arg(['--repo-path', repoPath]);
        addRelease.arg(['--vcstype', 'git']);
        addRelease.arg(['--lifecycle', lifecycle]);
        
        // Add commit info
        addRelease.arg(['--commit', commit]);
        
        // Get commit message and date
        try {
            const commitMessage = execSync("git log -1 --pretty=%s", {
                encoding: 'utf-8',
                cwd: repoPath
            }).trim();
            const commitDate = execSync("git log -1 --date=iso-strict --pretty=%ad", {
                encoding: 'utf-8',
                cwd: repoPath
            }).trim();
            
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
                commitsOutput = execSync(
                    `git log -100 ${lastCommit}..${commit} --date=iso-strict --pretty=%H|||%ad|||%s|||%an|||%ae -- ./`,
                    { encoding: 'utf-8', cwd: repoPath }
                );
            } else {
                // No last commit available, use current commit only
                commitsOutput = execSync(
                    `git log -1 --date=iso-strict --pretty=%H|||%ad|||%s|||%an|||%ae`,
                    { encoding: 'utf-8', cwd: repoPath }
                );
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
                addRelease.arg(['--odelartsjson', odelArtsJson]);
            }
        }
        
        // Add source code entry artifacts
        if (sceArts) {
            addRelease.arg(['--scearts', sceArts]);
        }
        
        // Add release artifacts
        if (releaseArts) {
            addRelease.arg(['--releasearts', releaseArts]);
        }
        
        // Add build timing
        if (buildStart) {
            addRelease.arg(['--datestart', buildStart]);
        }
        const dateEnd = new Date().toISOString();
        addRelease.arg(['--dateend', dateEnd]);
        
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
        
        // If lifecycle is ASSEMBLED, run the finalizer
        if (lifecycle === 'ASSEMBLED') {
            // Extract release UUID from output - find JSON object starting with {"data":
            const jsonStart = rearmOutput.indexOf('{"data":');
            let releaseUuid: string | null = null;
            
            if (jsonStart !== -1) {
                try {
                    // Find the matching closing brace
                    let braceCount = 0;
                    let jsonEnd = jsonStart;
                    for (let i = jsonStart; i < rearmOutput.length; i++) {
                        if (rearmOutput[i] === '{') braceCount++;
                        if (rearmOutput[i] === '}') braceCount--;
                        if (braceCount === 0) {
                            jsonEnd = i + 1;
                            break;
                        }
                    }
                    const jsonStr = rearmOutput.substring(jsonStart, jsonEnd);
                    const releaseData = JSON.parse(jsonStr);
                    releaseUuid = releaseData?.data?.addReleaseProgrammatic?.uuid || null;
                    
                    if (releaseUuid) {
                        console.log(`Finalizing release with UUID: ${releaseUuid}`);
                        
                        const finalizer = tl.tool(rearmPath);
                        finalizer.arg('releasefinalizer');
                        finalizer.arg(['--releaseid', releaseUuid]);
                        finalizer.arg(['-k', rearmApiKey]);
                        finalizer.arg(['-i', rearmApiKeyId]);
                        finalizer.arg(['-u', rearmUrl]);
                        
                        const finalizerResult = await finalizer.execAsync();
                        if (finalizerResult !== 0) {
                            throw new Error(`ReARM releasefinalizer failed with exit code ${finalizerResult}`);
                        }
                        console.log('Release finalized successfully');
                    } else {
                        console.log('Warning: Could not extract release UUID for finalization');
                    }
                } catch (parseErr) {
                    console.log(`Warning: Could not parse release response for finalization: ${parseErr}`);
                }
            } else {
                console.log('Warning: No JSON response found for finalization');
            }
        }
        
        tl.setResult(tl.TaskResult.Succeeded, 'Release metadata sent successfully');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

run();
