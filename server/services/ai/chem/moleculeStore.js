import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../../../..');

const ALLOWED_ELEMENTS = new Set(['H', 'C', 'N', 'O', 'S', 'Cl', 'Na', 'Fe', 'Cu', 'Mg']);
const ALLOWED_COLORS = new Set(['sky', 'red', 'blue', 'green', 'slate', 'cyan', 'amber', 'orange', 'purple', 'yellow', 'gray', 'pink']);

function defaultStorePath() {
  return process.env.MOLECULE_EXTENSIONS_FILE
    || path.join(projectRoot, 'server', 'data', 'molecule-extensions.json');
}

function emptyStore() {
  return { version: 1, molecules: [] };
}

export function getMoleculeStorePath() {
  return defaultStorePath();
}

export function loadMoleculeExtensions() {
  const file = defaultStorePath();
  try {
    if (!fs.existsSync(file)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) return { version: 1, molecules: raw };
    if (raw && Array.isArray(raw.molecules)) return { version: Number(raw.version || 1), molecules: raw.molecules };
    return emptyStore();
  } catch {
    return emptyStore();
  }
}

export function listActiveMoleculeExtensions() {
  return loadMoleculeExtensions().molecules.filter(m => m && m.id && m.status !== 'disabled');
}

export function getExtendedSpeciesIds() {
  return listActiveMoleculeExtensions().map(m => m.id);
}

export function findMoleculeExtension(speciesId) {
  const id = String(speciesId || '').trim();
  return listActiveMoleculeExtensions().find(m => m.id === id) || null;
}

export function writeMoleculeStore(store) {
  const file = defaultStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const payload = {
    version: store.version || 1,
    molecules: Array.isArray(store.molecules) ? store.molecules : [],
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(temp, file);
  return file;
}

/** Static schema check for a molecule definition (no Python). */
export function staticCheckMolecule(mol) {
  const errors = [];
  if (!mol || typeof mol !== 'object') return { ok: false, errors: ['molecule 不是对象'] };
  const id = String(mol.id || '').trim();
  if (!/^[A-Z][A-Za-z0-9]{0,15}$/.test(id)) errors.push('id 非法');
  if (!Array.isArray(mol.atoms) || !mol.atoms.length) errors.push('atoms 不能为空');
  if (!Array.isArray(mol.bonds)) errors.push('bonds 必须是数组');
  const slots = new Set();
  for (const atom of mol.atoms || []) {
    if (!atom || typeof atom !== 'object') { errors.push('atom 非法'); continue; }
    const slot = String(atom.slot || '');
    const el = String(atom.el || '');
    if (!slot) errors.push('atom.slot 缺失');
    if (slots.has(slot)) errors.push(`重复 slot: ${slot}`);
    slots.add(slot);
    if (!ALLOWED_ELEMENTS.has(el)) errors.push(`元素不支持: ${el}`);
    if (!Array.isArray(atom.pos) || atom.pos.length !== 3 || atom.pos.some(n => typeof n !== 'number' || Number.isNaN(n))) {
      errors.push(`atom ${slot} pos 非法`);
    }
  }
  for (const bond of mol.bonds || []) {
    if (!bond || typeof bond !== 'object') { errors.push('bond 非法'); continue; }
    if (!slots.has(String(bond.a))) errors.push(`bond.a 未知 slot: ${bond.a}`);
    if (!slots.has(String(bond.b))) errors.push(`bond.b 未知 slot: ${bond.b}`);
    const order = bond.order;
    if (!(order === 1 || order === 2 || order === 3 || order === 'ionic')) errors.push(`bond.order 非法: ${order}`);
  }
  if (mol.color && !ALLOWED_COLORS.has(String(mol.color))) {
    // soft: normalize later
  }
  return { ok: errors.length === 0, errors, id };
}

export function normalizeMoleculeDefinition(raw, speciesId) {
  const mol = raw?.molecule && typeof raw.molecule === 'object' ? raw.molecule : raw;
  if (!mol || typeof mol !== 'object') throw Object.assign(new Error('分子定义不是对象'), { code: 'MOL_EMPTY' });
  const id = String(mol.id || speciesId || '').trim();
  const atoms = (mol.atoms || []).map(a => ({
    slot: String(a.slot),
    el: String(a.el),
    pos: (a.pos || []).map(Number)
  }));
  const bonds = (mol.bonds || []).map(b => ({
    a: String(b.a),
    b: String(b.b),
    order: b.order === 'ionic' ? 'ionic' : Number(b.order)
  }));
  const out = {
    id,
    formula: mol.formula || id,
    latex: mol.latex || `\\text{${id}}`,
    name: mol.name || id,
    name_en: mol.name_en || mol.nameEn || id,
    color: ALLOWED_COLORS.has(String(mol.color || '')) ? mol.color : 'slate',
    atoms,
    bonds,
    status: 'active',
    source: mol.source || 'llm',
    createdAt: mol.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const check = staticCheckMolecule(out);
  if (!check.ok) {
    const err = new Error(`分子静态校验失败: ${check.errors.join('; ')}`);
    err.code = 'MOL_STATIC_INVALID';
    err.errors = check.errors;
    throw err;
  }
  return out;
}

export function upsertMoleculeExtension(mol) {
  const normalized = normalizeMoleculeDefinition(mol, mol.id);
  const store = loadMoleculeExtensions();
  const idx = store.molecules.findIndex(m => m.id === normalized.id);
  if (idx >= 0) store.molecules[idx] = { ...store.molecules[idx], ...normalized, updatedAt: new Date().toISOString() };
  else store.molecules.push(normalized);
  writeMoleculeStore(store);
  return normalized;
}

export function writeTempExtensionsFile(molecules, workDir) {
  fs.mkdirSync(workDir, { recursive: true });
  const file = path.join(workDir, `mol-ext-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, molecules }, null, 2), 'utf8');
  return file;
}

export function speciesPromptBlockFromExtensions(extra = []) {
  return (extra || []).map(m => `- ${m.id} (${m.name || m.id}) slots: ${(m.atoms || []).map(a => a.slot).join(', ')}`).join('\n');
}
