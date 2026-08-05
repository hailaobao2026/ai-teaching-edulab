import { speciesPromptBlock } from './moleculeCatalog.js';

export function chemSystemPrompt() {
  return `你是高中/初中化学课件结构化引擎。只输出 JSON（不要 markdown 代码块），生成 edu-chem-reaction 的 reaction spec。

硬性规则：
1. 仅使用 morph 引擎（meta.engine="morph"），不要输出 mechanism/fragments 低层路径。
2. 物种 species 只能使用下列 ID：
${speciesPromptBlock()}
3. reactants/products 使用 { "species": "CH4", "count": 1 } 形式；count 与配平一致。
4. atom_map 必须是反应物原子到产物原子的双射，引用格式 SPECIES#instance.slot，例如 CH4#1.C、O2#2.Oa、H2O#1.Ha。
5. 每个反应物原子、每个产物原子恰好出现一次；映射两端元素必须相同。
6. steps 给 3 步：{title, html}，html 可用简单 span class，中文讲解。
7. conditions 可含 text/exothermic/flame/under/reversible。
8. meta 必填 title, subtitle, language="zh-CN", category(junior|inorganic|organic), accent, engine="morph"。
9. 优先使用列表中的物种；若反应必须用到列表外常见物种（如 SO2、HCl、H2SO4 等），可直接使用其化学式作 species ID，服务端会自动扩展分子几何。
10. 只输出一个 JSON 对象。
11. atom_map 示例（碳燃烧 C + O2 -> CO2）：
[
  ["C#1.X", "CO2#1.Y"],
  ["O2#1.Oa", "CO2#1.Xa"],
  ["O2#1.Ob", "CO2#1.Xb"]
]
12. 单原子物种（C/Na/Fe/Mg）slot 一律用 X；双原子 O2 用 Oa/Ob；CO2 中心碳 Y、两端氧 Xa/Xb；水 O 为 A、氢 Ha/Hb；甲烷 C 与 H1..H4。
13. atom_map 每项必须是长度为 2 的字符串数组，禁止只写元素符号。
`;
}

export function chemUserPrompt({ content, inputMode, previousError, previousSpec }) {
  const parts = [
    `输入类型: ${inputMode}`,
    `用户内容:\n${content}`,
    '请生成完整 reaction spec JSON。'
  ];
  if (previousError) {
    parts.push(`上次校验失败，请修复后重输完整 JSON。错误:\n${previousError}`);
  }
  if (previousSpec) {
    parts.push(`上次 spec（可修改）:\n${JSON.stringify(previousSpec, null, 2)}`);
  }
  return parts.join('\n\n');
}

export function chemRepairSystemPrompt() {
  return chemSystemPrompt() + '\n你正在根据校验错误修复 JSON，输出完整修正后的 spec。';
}
