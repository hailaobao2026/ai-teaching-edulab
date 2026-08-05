import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { listActiveMoleculeExtensions, writeTempExtensionsFile } from './moleculeStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOL = path.join(__dirname, '..', 'python', 'chem_spec_tool.py');

function runPython(pythonBin, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonBin, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 1500).unref();
      reject(Object.assign(new Error('chem python tool timeout'), { code: 'CHEM_TOOL_TIMEOUT' }));
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(Object.assign(err, { code: 'CHEM_TOOL_SPAWN' }));
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

function resolveExtensionsFile(extensionsFile, workDir) {
  if (extensionsFile) return extensionsFile;
  const active = listActiveMoleculeExtensions();
  if (!active.length) return null;
  if (!workDir) return null;
  return writeTempExtensionsFile(active, workDir);
}

export async function validateChemSpec(spec, { pythonBin = process.env.PYTHON_BIN || 'python3', workDir, extensionsFile } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const specPath = path.join(workDir, `spec-validate-${Date.now()}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
  const ext = resolveExtensionsFile(extensionsFile, workDir);
  try {
    const args = [TOOL, 'validate', specPath];
    if (ext) args.push('--extensions', ext);
    const { code, stdout, stderr } = await runPython(pythonBin, args);
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

export async function renderChemSpec(spec, outputPath, { pythonBin = process.env.PYTHON_BIN || 'python3', workDir, extensionsFile } = {}) {
  fs.mkdirSync(workDir || path.dirname(outputPath), { recursive: true });
  const dir = workDir || path.dirname(outputPath);
  const specPath = path.join(dir, `spec-render-${Date.now()}.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
  const ext = resolveExtensionsFile(extensionsFile, dir);
  try {
    const args = [TOOL, 'render', specPath, outputPath];
    if (ext) args.push('--extensions', ext);
    const { code, stdout, stderr } = await runPython(pythonBin, args);
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

export async function selfcheckMolecule(mol, { pythonBin = process.env.PYTHON_BIN || 'python3', workDir } = {}) {
  fs.mkdirSync(workDir, { recursive: true });
  const molPath = path.join(workDir, `mol-selfcheck-${Date.now()}.json`);
  fs.writeFileSync(molPath, JSON.stringify(mol, null, 2), 'utf8');
  try {
    const { code, stdout, stderr } = await runPython(pythonBin, [TOOL, 'selfcheck-molecule', molPath]);
    const parsed = parseLastJson(stdout);
    if (parsed?.ok) return { ok: true, summary: parsed };
    return { ok: false, error: parsed?.error || stderr || stdout || `selfcheck exit ${code}`, detail: parsed };
  } finally {
    try { fs.unlinkSync(molPath); } catch { /* ignore */ }
  }
}
