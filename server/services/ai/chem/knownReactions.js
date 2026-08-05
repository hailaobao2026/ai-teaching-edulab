/**
 * Fast-path: map common Chinese/equation queries to fixed REGISTRY keys.
 */
const RULES = [
  { key: 'combustion_ch4', patterns: [/甲烷/, /ch4/i, /CH₄/, /天然气.*燃/] },
  { key: 'combustion_h2', patterns: [/氢气.*燃/, /氢.*氧.*燃/, /2\s*H2/, /H₂.*O₂/] },
  { key: 'electrolysis_water', patterns: [/电解水/, /通电.*水/, /水.*电解/] },
  { key: 'redox_na_cl2', patterns: [/钠.*氯/, /Na.*Cl2/, /氯气.*钠/] },
  { key: 'esterification', patterns: [/酯化/, /乙酸.*乙醇/, /乙醇.*乙酸/] },
  { key: 'glucose_combustion', patterns: [/葡萄糖/, /C6H12O6/, /葡萄糖.*燃/] }
];

export function matchKnownChemReaction(text = '') {
  const s = String(text || '');
  for (const rule of RULES) {
    if (rule.patterns.some(re => re.test(s))) return rule.key;
  }
  return null;
}
