import { createRequire } from 'module';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');
const require = createRequire(import.meta.url);

function resolveSkillsRoot() {
  try {
    const pkgPath = require.resolve('@wy51ai/edulab/package.json');
    return join(dirname(pkgPath), 'skills');
  } catch {
    return join(projectRoot, 'node_modules', '@wy51ai', 'edulab', 'skills');
  }
}

const SKILLS_ROOT = resolveSkillsRoot();

const SKILL_DEFS = [
  {
    id: 'edu-solid-geometry',
    name: '立体几何',
    nameEn: 'Solid Geometry',
    description: '正方体/长方体/棱锥等立体几何题，3D 交互模型 + 分步解析',
    renderEngine: 'threejs+mathjax',
    problemTypes: [
      { key: 'cube', name: '正方体·线面角', params: [] },
      { key: 'box', name: '长方体·体积', params: [] },
      { key: 'random', name: '随机出题', params: [{ key: 'seed', name: '随机种子', type: 'number', default: 0 }] }
    ]
  },
  {
    id: 'edu-analytic-geometry',
    name: '解析几何',
    nameEn: 'Analytic Geometry',
    description: '椭圆/双曲线/抛物线等圆锥曲线题，2D 交互画板 + KaTeX 解析',
    renderEngine: 'canvas+katex',
    problemTypes: [
      { key: 'ellipse_dot_range', name: '椭圆·数量积范围', params: [] },
      { key: 'ellipse_chord_range', name: '椭圆·弦长范围', params: [] },
      { key: 'ellipse_area_max', name: '椭圆·面积最值', params: [] },
      { key: 'ellipse_slopeprod_const', name: '椭圆·斜率积定值', params: [] },
      { key: 'parabola_dot_const', name: '抛物线·焦点弦定值', params: [] },
      { key: 'hyperbola_ecc_range', name: '双曲线·离心率范围', params: [] }
    ]
  },
  {
    id: 'edu-chem-reaction',
    name: '化学反应',
    nameEn: 'Chemical Reaction',
    description: '燃烧/电解/氧化还原/酯化等反应，3D 微观分子动画 + KaTeX',
    renderEngine: 'threejs+katex',
    problemTypes: [
      { key: 'combustion_ch4', name: '甲烷燃烧', params: [] },
      { key: 'combustion_h2', name: '氢气燃烧', params: [] },
      { key: 'electrolysis_water', name: '电解水', params: [] },
      { key: 'redox_na_cl2', name: '钠氯氧化还原', params: [] },
      { key: 'esterification', name: '酯化反应', params: [] },
      { key: 'glucose_combustion', name: '葡萄糖燃烧', params: [] }
    ]
  }
];

export function getSkillsRoot() {
  return SKILLS_ROOT;
}

export function listSkills() {
  return SKILL_DEFS.map(s => ({
    id: s.id,
    name: s.name,
    nameEn: s.nameEn,
    description: s.description,
    renderEngine: s.renderEngine,
    problemTypes: s.problemTypes
  }));
}

export function getSkill(skillId) {
  return SKILL_DEFS.find(s => s.id === skillId) || null;
}

export function getProblemType(skillId, problemKey) {
  const skill = getSkill(skillId);
  if (!skill) return null;
  return skill.problemTypes.find(p => p.key === problemKey) || null;
}

export function getSkillDir(skillId) {
  return join(SKILLS_ROOT, skillId);
}

export function getGenerateScript(skillId) {
  return join(SKILLS_ROOT, skillId, 'scripts', 'generate.py');
}

export function skillsInstalled() {
  return SKILL_DEFS.every(skill => existsSync(getGenerateScript(skill.id)));
}
