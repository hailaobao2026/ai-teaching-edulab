import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOL = path.join(__dirname, '..', 'python', 'analytic_spec_tool.py');

function runPython(pythonBin, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1500).unref();
      reject(Object.assign(new Error('analytic python tool timeout'), { code: 'ANALYTIC_TOOL_TIMEOUT' }));
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(Object.assign(err, { code: 'ANALYTIC_TOOL_SPAWN' }));
    });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split(/\n+/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* continue */ }
  }
  try { return JSON.parse(String(stdout || '').trim()); } catch {
    return null;
  }
}

export async function validateAnalyticSpec(spec, { pythonBin = process.env.PYTHON_BIN || 'python3', workDir } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const specPath = path.join(workDir, `analytic-validate-${Date.now()}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
  try {
    const { code, stdout, stderr } = await runPython(pythonBin, [TOOL, 'validate', specPath]);
    const parsed = parseLastJson(stdout);
    if (parsed?.ok) return { ok: true, summary: parsed };
    return {
      ok: false,
      error: parsed?.error || stderr || stdout || `validate exit ${code}`,
      detail: parsed
    };
  } finally {
    try { fs.unlinkSync(specPath); } catch { /* ignore */ }
  }
}

export async function renderAnalyticSpec(spec, outputPath, { pythonBin = process.env.PYTHON_BIN || 'python3', workDir } = {}) {
  fs.mkdirSync(workDir || path.dirname(outputPath), { recursive: true });
  const dir = workDir || path.dirname(outputPath);
  const specPath = path.join(dir, `analytic-render-${Date.now()}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
  try {
    const { code, stdout, stderr } = await runPython(pythonBin, [TOOL, 'render', specPath, outputPath]);
    const parsed = parseLastJson(stdout);
    if (parsed?.ok && fs.existsSync(outputPath)) return { ok: true, summary: parsed };
    return {
      ok: false,
      error: parsed?.error || stderr || stdout || `render exit ${code}`,
      detail: parsed
    };
  } finally {
    try { fs.unlinkSync(specPath); } catch { /* ignore */ }
  }
}
