# Spec 字段表：解析几何 / 立体几何

> 来源：`@wy51ai/edulab` 各 skill 的 `references/problem-schema.md` 与 `scripts/generate.py` 输出。  
> LLM 只生成下列 JSON；数值尽量由 kernel 回填/校验。

---

## A. AnalyticLessonSpec（`edu-analytic-geometry`）

根对象：

```jsonc
{
  "specVersion": 1,
  "skillId": "edu-analytic-geometry",
  "problemKind": "ellipse_dot_range",  // 或 ai_custom；需能被校验器识别题型族
  "lesson": { ... },
  "steps": [ ... ],
  "board": { ... }
}
```

### A.1 `lesson`（必填）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| language | `"zh-CN"`\|`"en"` | 是 | UI/讲解语言 |
| title | string | 是 | 标题 |
| problem | string(HTML) | 是 | 题干，可含 `$...$` |
| answerLabel | string | 建议 | 答案说明 |
| answer | string(LaTeX/HTML) | 建议 | 最终答案 |
| ui | object | 否 | 英文时覆盖界面文案 |

### A.2 `steps[]`（必填，≥1）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 步骤标题 |
| content | string(HTML) | 是 | 解析；关键数值应与 kernel 一致 |

### A.3 `board`（必填）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| view | `{xRange:[n,n], yRange:[n,n]}` | 是 | 视窗 |
| conics | array | 是* | 圆锥曲线列表（轨迹题等至少 1） |
| points | object | 否 | 命名点 |
| param | object | 否 | 单滑块参数；动态题常用 |
| scalars | array | 否 | 由 param 派生标量 |
| derived | array | 否 | 构造序列（交点/直线/向量等） |
| readouts | array | 否 | 控制台读数 |
| rangeBar | object | 择一 | 范围题 |
| constant | object | 择一 | 定值题 |
| answerBand | object | 择一 | 参数轴答案区间 |
| trace | object | 否 | 轨迹 |
| legend | array | 否 | 图例 |

\* 极少数纯轨迹题仍应有载体曲线或约束几何。

#### `conics[]` 元素

| kind | 必填参数 |
|------|----------|
| ellipse | a, b, center |
| hyperbola | a, b, center, orient(`x`\|`y`) |
| parabola | p, center, axis(`x`\|`y`) |
| circle | r, center |

通用可选：`name,color,label,dashed,hidden,legend,asymptotes`；数值可写表达式字符串（依赖 `@param`）。

#### `param`

`name,label,min,max,step,value,unit?,standard?,ticks?`

#### 题型族与展示组件（生成时择一）

| 题型族 | 优先组件 |
|--------|----------|
| 范围/最值 | `rangeBar` |
| 定值 | `constant` |
| 离心率/参数区间 | `answerBand` |
| 轨迹 | `trace` |

### A.4 校验要点（实现期）

1. JSON Schema 结构  
2. conic 参数合法（a>0 等）  
3. 表达式可解析  
4. 与 `analytic_kernel` 可复算的结论字段一致（范围/定值）  
5. 注入 `template/board.html` 可渲染  

### A.5 LLM 职责边界

- 可写：题干叙述、步骤讲解、board 几何布局与 param 设定  
- 宜由引擎/修复：范围端点、定值精确 LaTeX（可用工具调用 kernel 后写回）

---

## B. SolidLessonSpec（`edu-solid-geometry`）

根对象：

```jsonc
{
  "specVersion": 1,
  "skillId": "edu-solid-geometry",
  "problemKind": "cube" | "box" | "pyramid_line_plane" | "ai_custom",
  "lesson": { ... },
  "steps": [ ... ],
  "model": { ... },
  "_answer": "可选内部字段"
}
```

### B.1 `lesson`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| language | string | 是 | |
| title | string | 是 | 完整题干标题 |
| meta | string | 否 | 如「交互解题 · 线面角」 |
| answerLabel | string | 建议 | |
| answerValue | string | 建议 | 含 LaTeX 的答案展示 |

### B.2 `steps[]`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | |
| content | string(HTML) | 是 | |
| highlight | string[] | 否 | 对应 `model.elements` 的 key |
| cameraPos | `{x,y,z}` | 否 | 分步镜头 |

### B.3 `model`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| target | [x,y,z] | 是 | 轨道控制器焦点 |
| initialCamera | [x,y,z] | 是 | 初始相机 |
| points | object | 是 | 点名 → 三维坐标 |
| spheres | array | 是 | 顶点绘制（可来自 bodies 拓扑） |
| edges | array | 是 | 棱 |
| elements | object | 是 | 线/面/箭头/坐标轴等可高亮元素 |

#### `elements[*]` 常见 type

| type | 关键字段 |
|------|----------|
| line | a,b,color?,depthTest? |
| plane | pts[] |
| arrow | origin,dir,length,color? |
| axes | size |

### B.4 校验要点

1. 点坐标齐全；elements 引用的点名存在  
2. 目标量（角/体积/距离）与 `geometry_kernel` 解一致  
3. 注入 solid template 可渲染  
4. 随机题参数在合理范围  

### B.5 LLM 职责边界

- 可写：题干、步骤讲解、高亮与镜头编排  
- 坐标与答案优先 **kernel 计算后填入**，避免口算胡写

---

## C. 化学（对照，已有）

见 `edu-chem-reaction/references/problem-schema.md`：  
`meta/conditions/reactants|products/atom_map|atoms.../steps` → `assemble_data`。

---

## D. 跨技能公共信封（API 存盘）

```jsonc
{
  "specVersion": 1,
  "skillId": "edu-analytic-geometry",
  "inputMode": "text",
  "payload": { /* AnalyticLessonSpec 或 Solid 或 Chem ReactionSpec */ }
}
```

`generation_jobs.spec` 存此信封或直接存 payload（实现选一种，推荐带 skillId 信封）。
