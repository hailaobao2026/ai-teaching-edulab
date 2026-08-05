/** Map free text to fixed edu-analytic-geometry registry keys. */

const RULES = [
  { key: 'ellipse_dot_range', patterns: [/数量积.*范围/, /向量.*数量积/, /椭圆.*数量积/, /MA\s*·\s*MB/, /ellipse.*dot.*range/i] },
  { key: 'ellipse_chord_range', patterns: [/弦长.*范围/, /椭圆.*弦长/, /chord.*range/i] },
  { key: 'ellipse_area_max', patterns: [/面积.*最值/, /三角形.*面积/, /area.*max/i] },
  { key: 'ellipse_slopeprod_const', patterns: [/斜率.*积/, /斜率之积/, /定值.*斜率/, /slope.*prod/i] },
  { key: 'parabola_dot_const', patterns: [/抛物线.*定值/, /抛物线.*焦点弦/, /parabola.*const/i] },
  { key: 'hyperbola_ecc_range', patterns: [/离心率.*范围/, /双曲线.*离心率/, /hyperbola.*ecc/i, /e\s*∈/, /离心率/] }
];

export const KNOWN_ANALYTIC_KEYS = RULES.map(r => r.key);

export function matchKnownAnalyticProblem(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  for (const rule of RULES) {
    if (rule.patterns.some(re => re.test(s))) return rule.key;
  }
  // exact key
  const t = s.trim();
  if (KNOWN_ANALYTIC_KEYS.includes(t)) return t;
  return null;
}
