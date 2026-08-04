import { spawn } from 'child_process';
import path from 'path';
import { getGenerateScript, getProblemType } from './skillCatalog.js';

const PYTHON_TIMEOUT_MS = Math.max(10_000, Number(process.env.PYTHON_TIMEOUT_MS || 300_000));
const MAX_OUTPUT = 16 * 1024;

export function runGenerate({ skillId, problemKey, params, outputPath, onLog, signal, pythonBin = process.env.PYTHON_BIN || 'python3', timeoutMs = PYTHON_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const problemType = getProblemType(skillId, problemKey);
    if (!problemType) {
      return reject(new Error(`未知题型: ${skillId}/${problemKey}`));
    }

    const script = getGenerateScript(skillId);
    const args = [script];

    if (problemKey === 'random') {
      const seed = params?.seed ?? 0;
      args.push('random', String(seed), outputPath);
    } else {
      args.push(problemKey, outputPath);
    }

    if (onLog) onLog(`$ ${pythonBin} ${args.join(' ')}`);

    const proc = spawn(pythonBin, args, {
      cwd: path.dirname(script),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2_000).unref();
      if (!settled) { settled = true; reject(Object.assign(new Error('课件生成超时'), { code: 'ETIMEDOUT' })); }
    }, timeoutMs);

    const abort = () => {
      if (settled) return;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 2_000).unref();
      settled = true;
      reject(Object.assign(new Error('课件生成已取消'), { code: 'ECANCELLED' }));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }

    proc.stdout.on('data', d => {
      const text = d.toString();
      if (stdout.length < MAX_OUTPUT) stdout += text.slice(0, MAX_OUTPUT - stdout.length);
      if (onLog) onLog(text.trim().slice(0, 2000));
    });
    proc.stderr.on('data', d => {
      const text = d.toString();
      if (stderr.length < MAX_OUTPUT) stderr += text.slice(0, MAX_OUTPUT - stderr.length);
      if (onLog) onLog(text.trim().slice(0, 2000));
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      if (!settled) { settled = true; reject(Object.assign(new Error('课件生成进程启动失败'), { code: 'ESPAWN' })); }
    });
    proc.on('close', code => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      if (code !== 0) {
        const detail = (stderr || stdout).trim().slice(0, 2000);
        if (onLog && detail) onLog(detail);
        return reject(Object.assign(new Error('课件生成失败'), { code: 'EGENERATE', detail }));
      }
      resolve({ outputPath, stdout, stderr });
    });
  });
}
