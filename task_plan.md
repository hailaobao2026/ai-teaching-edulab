# Task Plan: LLM 驱动动态扩展教学课件（化学 + 数学）

## Goal
在现有 EduLab Web 平台上引入大语言模型（LLM），使**教师与学生**都可通过 **文本 → 方程/式子 → 图片** 三入口，动态生成并扩展：
- **化学**：化学反应交互课件（`edu-chem-reaction`）
- **数学**：优先**解析几何**，其后立体几何（`edu-analytic-geometry` → `edu-solid-geometry`）

生成链路：**LLM 输出技能标准 JSON Spec → kernel/schema 校验 → 模板渲染 HTML**。  
分子库缺口 **全自动扩展**；模型通道使用 **sub2api**；图片路径 **识别后先确认再生成**。  
实现编码在 Phase 2–5 方案冻结后启动。

## Background
- 固定题型双注册：`@wy51ai/edulab` REGISTRY + `skillCatalog.js`
- 用户决策（累计）：
  1. 首期化学 + 数学
  2. 入口文本 / 方程 / 图片都做（顺序落地）
  3. 师生均可 AI 生成
  4. 分子库全自动扩展
  5. **数学先做解析几何**
  6. **模型通道：sub2api**
  7. **图片：识别后先确认再生成**
  8. **晋升正式题型：放入首期最后里程碑**
  9. **学生默认日配额：10 次/日**（可 admin 调整；教师默认 50 次/日）

## Current Phase
M0–M3 完成（化+分子扩展+解析几何）；下一里程碑 M4 图片入口 / M4b 立几

## Phases

### Phase 1: 需求整理与方案边界
- [x] 现状与目标、FR/NFR、planning 三文件
- [x] 用户确认回收（两轮）
- **Status:** complete

### Phase 2: 产品方案与验收标准（PRD 级）
- [x] 范围：化学 + 数学（解几优先，立几随后）
- [x] 入口：文本 → 方程 → 图片
- [x] 权限：teacher + student
- [x] 分子库：全自动 + 自检
- [x] 模型通道：**sub2api**（OpenAI compatible，服务端调用）
- [x] 图片：**识别结果确认门闩**后再进生成
- [x] 晋升正式题型：**首期最后一个里程碑（M5）**
- [x] 学生默认配额：**10 次/日**；教师 **50 次/日**（默认，可配）
- [ ] 金标集与验收用例成文（化/解几/立几/补分子/图片确认）
- [ ] 失败降级文案与状态码约定
- **Status:** in_progress（仅余验收清单细化）

### Phase 3: 技术架构设计
- [x] 统一 AI 编排 + intent 路由（草案）
- [x] 三技能 Spec 策略：chem 已有；analytic/solid 反推（草案）
- [x] sub2api 客户端封装要点（草案）
- [x] 图片：draft → 确认 → job（API 已定）
- [x] 分子全自动扩展流水线（草案）
- [x] Job/数据模型扩展字段（草案）
- [x] skills override / 不改死 node_modules（草案）
- [x] API 路径与里程碑切片（见 docs）
- [x] 评审冻结 §开放实现选择（用户同意建议）
- [x] 导出 Analytic/Solid Spec 字段表
- **Status:** complete（草案+字段表+选择冻结）

### Phase 4: 安全、成本、配额与治理
- [ ] sub2api Key 仅服务端；按用户透传/或平台统一上游账号策略
- [ ] 配额中间件（student 10 / teacher 50 默认）
- [ ] 图片与 prompt 审计、缓存
- [ ] 危险化学提示；注入防护
- **Status:** pending

### Phase 5: 里程碑（编码前冻结）
- [x] **M0** 基建：AI job、sub2api 通道、配额、日志；固定题型回归
- [x] **M1** 化学文本 + 方程（morph + kernel + 重试）
- [x] **M2** 分子库全自动扩展
- [x] **M3** **解析几何**文本 + 式子
- [ ] **M4** 图片入口（化+解几）：**识别 → 确认 → 生成**
- [ ] **M4b** 立体几何文本/式子/图片（确认流复用）
- [ ] **M5** **晋升正式题型** + 增强（mechanism 等按需）
- **Status:** pending

### Phase 6: 实现与联调
- [x] 冻结实现选择与 Spec 字段表
- [x] **M0** 基建编码：sub2api client、配额、AI job 字段、AI API 骨架
- [x] **M1** 化学 text/equation → 已知反应快路径 / LLM Spec → kernel 校验修复 → HTML
- [x] M2 分子全自动扩展
- [x] M3 解析几何
- **Status:** in_progress（M0）

## Decisions（冻结）
| Decision | 结论 | 状态 |
|----------|------|------|
| 首期学科 | 化学 + 数学 | 已确认 |
| 数学顺序 | **解析几何 → 立体几何** | 已确认 |
| 入口 | 文本 / 方程 / 图片；顺序交付 | 已确认 |
| AI 权限 | 老师 + 学生 | 已确认 |
| 分子库 | 全自动扩展 | 已确认 |
| 模型通道 | **sub2api** | 已确认 |
| 图片流程 | **识别后先确认再生成** | 已确认 |
| 晋升题型 | **首期 M5** | 已确认 |
| 学生日配额 | **10 次/日（默认）** | 已确认（推荐值落盘；admin 可改） |
| 教师日配额 | **50 次/日（默认）** | 工程默认 |
| LLM 位置 | 仅服务端 | 已定 |
| 输出 | Spec + HTML；固定题型保留 | 已定 |
| 校验失败 | 自动重试 N 次 + 可读错误 | 已定 |

## Risks
| 风险 | 缓解 |
|------|------|
| sub2api 入口 WAF/不稳定 | 服务端重试、健康检查、错误透出；运维侧放行 API |
| 全自动分子科学性 | 自检不通过不入库 |
| 学生配额被刷 | 10/日 + 审计 + admin 可关 |
| 图片确认增加一步 | 换准确率；草稿可编辑 |
| 范围大 | 严格 M0–M5；解几先于立几 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| （尚无） |  |  |

## Notes
- sub2api 配置项（实现期）：`SUB2API_BASE_URL`、`SUB2API_API_KEY`、`SUB2API_MODEL` 等，不入库明文到前端
- 配额计的是「成功发起的 AI 生成任务」还是「含失败」：建议 **每次创建 AI job 计数**（防刷），Phase3 写死
- 下一动作：补金标验收清单 → Phase3 架构/API 草案

## Architecture Doc
- `docs/planning/phase3-architecture-api.md`

## M1 Notes
- known reaction regex → fixed REGISTRY
- else LLM JSON spec + assemble_data validate/repair + template render
- worker `processAiJob`
