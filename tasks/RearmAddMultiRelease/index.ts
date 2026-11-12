import * as tl from 'azure-pipelines-task-lib/task';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Thin wrapper around `rearm addreleases --infile <file>`, mirroring the
// ReARM add-multi-release GitHub Action. This task derives nothing from the
// pipeline context and builds no metadata: the caller hands it the complete
// batch JSON (an array of ReleaseInputProg objects). Artifacts reference local
// files via their "filePath" field, resolved relative to workingDirectory —
// the CLI reads and uploads each file.
//
// The whole batch is sent in one all-or-nothing call, so the backend fires
// product auto-integration once per affected feature set for the batch rather
// than once per release.
async function run(): Promise<void> {
    let tempInfile = '';
    try {
        const rearmApiKey = tl.getInput('rearmApiKey', true)!;
        const rearmApiKeyId = tl.getInput('rearmApiKeyId', true)!;
        const rearmUrl = tl.getInput('rearmUrl', true)!;
        const releasesInput = tl.getInput('releases', false) || '';
        const infileInput = tl.getInput('infile', false) || '';
        // stripbom is a boolean input; the CLI expects the literal string "true"/"false".
        const stripBom = tl.getBoolInput('stripbom', false) ? 'true' : 'false';

        // Process directory the CLI runs from — the base every artifact "filePath"
        // (and a relative infile) resolves against. Defaults to the pipeline
        // workspace root, the ADO analog of the Action's default working directory.
        const workingDirectory = tl.getPathInput('workingDirectory', false)
            || tl.getVariable('System.DefaultWorkingDirectory')
            || process.cwd();

        const rearmPath = tl.which('rearm', true);

        // Resolve the batch file: an explicit infile wins; otherwise write the
        // inline releases JSON to a temp file. Mirrors the Action's precedence.
        let infile: string;
        if (infileInput) {
            infile = path.isAbsolute(infileInput)
                ? infileInput
                : path.join(workingDirectory, infileInput);
        } else {
            const trimmed = releasesInput.trim();
            if (!trimmed || trimmed === '[]') {
                throw new Error("Provide either the 'infile' path or a non-empty 'releases' JSON array.");
            }
            // Validate it parses as a non-empty array so callers get a clear error
            // here rather than an opaque CLI parse failure. The original raw text
            // is written (not re-serialized) to preserve exact content.
            let parsed: unknown;
            try {
                parsed = JSON.parse(trimmed);
            } catch (err: any) {
                throw new Error(`Failed to parse 'releases' JSON: ${err.message}`);
            }
            if (!Array.isArray(parsed) || parsed.length === 0) {
                throw new Error("'releases' must be a non-empty JSON array of release objects.");
            }

            tempInfile = path.join(os.tmpdir(), `rearm-addreleases-${Date.now()}.json`);
            fs.writeFileSync(tempInfile, trimmed);
            infile = tempInfile;
        }

        if (!fs.existsSync(infile)) {
            throw new Error(`Release batch file not found: ${infile}`);
        }

        const addReleases = tl.tool(rearmPath);
        addReleases.arg('addreleases');
        addReleases.arg(['--infile', infile]);
        addReleases.arg(['--stripbom', stripBom]);
        addReleases.arg(['-u', rearmUrl]);
        addReleases.arg(['-i', rearmApiKeyId]);
        addReleases.arg(['-k', rearmApiKey]);

        console.log('Submitting release batch to ReARM...');
        const exitCode = await addReleases.execAsync({ cwd: workingDirectory } as any);
        if (exitCode !== 0) {
            throw new Error(`ReARM addreleases failed with exit code ${exitCode}`);
        }

        console.log('Release batch metadata sent successfully');
        tl.setResult(tl.TaskResult.Succeeded, 'Release batch processed successfully');
    } catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message || 'Unknown error occurred');
    } finally {
        if (tempInfile) {
            try { fs.unlinkSync(tempInfile); } catch { /* ignore cleanup errors */ }
        }
    }
}

run();
