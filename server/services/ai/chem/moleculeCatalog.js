import { listActiveMoleculeExtensions } from './moleculeStore.js';

/** Built-in edu-chem-reaction species and atom slots (for LLM prompt). */
export const CHEM_SPECIES = [
  { id: 'H2', slots: ['Ha', 'Hb'], name: '氢气' },
  { id: 'O2', slots: ['Oa', 'Ob'], name: '氧气' },
  { id: 'N2', slots: ['Na', 'Nb'], name: '氮气' },
  { id: 'Cl2', slots: ['Cla', 'Clb'], name: '氯气' },
  { id: 'CO', slots: ['C', 'O'], name: '一氧化碳' },
  { id: 'CO2', slots: ['Y', 'Xa', 'Xb'], name: '二氧化碳' },
  { id: 'H2O', slots: ['A', 'Ha', 'Hb'], name: '水' },
  { id: 'CH4', slots: ['C', 'H1', 'H2', 'H3', 'H4'], name: '甲烷' },
  { id: 'NH3', slots: ['A', 'H1', 'H2', 'H3'], name: '氨' },
  { id: 'Na', slots: ['X'], name: '钠' },
  { id: 'C', slots: ['X'], name: '碳' },
  { id: 'Fe', slots: ['X'], name: '铁' },
  { id: 'Mg', slots: ['X'], name: '镁' },
  { id: 'NaCl', slots: ['Na', 'Cl'], name: '氯化钠' },
  { id: 'Glucose', slots: [], name: '葡萄糖（复杂，优先 glucose_combustion 路径）' }
];

export const SPECIES_IDS = CHEM_SPECIES.map(s => s.id);

export function speciesPromptBlock() {
  const builtin = CHEM_SPECIES.map(s => `- ${s.id} (${s.name}) slots: ${s.slots.join(', ') || '(internal)'}`);
  let extra = [];
  try {
    extra = listActiveMoleculeExtensions().map(m => {
      const slots = (m.atoms || []).map(a => a.slot).join(', ');
      return `- ${m.id} (${m.name || m.id}) slots: ${slots} [extension]`;
    });
  } catch {
    extra = [];
  }
  const lines = [...builtin, ...extra];
  if (extra.length) {
    lines.push('- 若仍缺分子：可使用新物种 ID（会触发服务端自动扩展分子库）');
  } else {
    lines.push('- 若内置列表不够：可使用合理新物种 ID（服务端将自动扩展分子库）');
  }
  return lines.join('\n');
}
