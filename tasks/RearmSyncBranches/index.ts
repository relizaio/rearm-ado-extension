import * as tl from 'azure-pipelines-task-lib/task';
import * as tr from 'azure-pipelines-task-lib/toolrunner';
import { execSync } from 'child_process';

async function run(): Promise<void> {
    try {
        const rearmApiKey = tl.getInput('rearmApiKey', true)!;
        const rearmApiKeyId = tl.getInput('rearmApiKeyId', true)!;
        const rearmUrl = tl.getInput('rearmUrl', true)!;
        const repoPath = tl.getInput('repoPath', false) || '.';
        
        // Get repository URI from Azure DevOps predefined variable
        const vcsUri = tl.getVariable('Build.Repository.Uri') || '';
        
        if (!vcsUri) {
            throw new Error('Build.Repository.Uri is not available');
        }
        
        console.log(`Repository URI: ${vcsUri}`);
        console.log(`Repository Path: ${repoPath}`);
        
        // Get live branches using git
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
        
        console.log('Synchronizing branches with ReARM...');
        
        // Find rearm in PATH
        const rearmPath = tl.which('rearm', true);
        
        // Build and run the command
        const rearm = tl.tool(rearmPath);
        rearm.arg('syncbranches');
        rearm.arg(['-k', rearmApiKey]);
        rearm.arg(['-i', rearmApiKeyId]);
        rearm.arg(['-u', rearmUrl]);
        rearm.arg(['--vcsuri', vcsUri]);
        rearm.arg(['--repo-path', repoPath]);
        rearm.arg(['--livebranches', liveBranches]);
        
        const result = await rearm.exec();
        
        if (result !== 0) {
            throw new Error(`ReARM syncbranches failed with exit code ${result}`);
        }
        
        tl.setResult(tl.TaskResult.Succeeded, 'Branches synchronized successfully');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    }
}

run();
