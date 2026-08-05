# Findings: LLM 动态生成教学课件（化学 + 数学）

## 1. 用户诉求与决策总表

### 1.1 原始诉求
固定题型扩展靠改代码；希望 LLM 动态生成化学与数学课件；先规划后实现。

### 1.2 已确认决策（冻结）
| # | 项 | 结论 |
|---|----|------|
| 1 | 首期范围 | 化学 + 数学（立几 + 解几） |
| 2 | 入口 | 文本 / 方程(式) / 图片都做；交付序：文本→方程→图片 |
| 3 | AI 权限 | 老师 + 学生都可以 |
| 4 | 分子库 | 全自动扩展 |
| 5 | 数学优先 | **先解析几何，后立体几何** |
| 6 | 模型通道 | **sub2api** |
| 7 | 图片 | **识别后先确认再生成** |
| 8 | 晋升正式题型 | **放入首期最后一程（M5）** |
| 9 | 学生默认日配额 | **10 次/日**（admin 可调） |
| 10 | 教师默认日配额 | **50 次/日**（工程默认，admin 可调） |

### 1.3 工程默认
- LLM 仅服务端；只产出 Spec JSON
- kernel/schema 校验失败不成成功课件
- 固定题型路径保留

## 2. 现状基线（摘要）
- 平台 jobs + skillRunner + `@wy51ai/edulab`
- 化学 6 / 解几 6 / 立几 3 固定题
- 化学分子库约 15 种，可自动扩展
- 历史实测：部分 sub2api 公网对话接口可能被 WAF 拦截——实现期需连通性探测与运维放行（记入风险）

## 3. 产品目标
师生经文本、公式/方程、图片动态生成**化学 + 数学**交互课件；解几优先；sub2api 出模型；图片先确认；分子全自动补库；M5 支持晋升正式题型。

## 4. 用户故事（关键更新）
1. 师生-化学-文本/方程 → morph 课件  
2. 缺分子时系统自动补库并继续（失败不脏写）  
3. 师生-解几-文本/式子 → 解析几何交互页  
4. 师生-图片：上传 → **识别草稿展示** → 用户确认/改字段 → 生成  
5. 立几在解几主路径稳定后上线  
6. 学生日限额 10；超限明确提示  
7. Admin/教师在 M5 将优质 AI 课件晋升为正式题型  

## 5. 功能需求优先级（更新后）

### 入口
| ID | 需求 | 优先级 |
|----|------|--------|
| FR-A1 | 文本生成（化+数） | P0 |
| FR-A2 | 方程/式子生成 | P0 |
| FR-A3 | 图片识别生成 | P0（第三交付） |
| FR-A3a | **图片识别结果确认门闩**（必经） | **P0** |
| FR-A4 | 固定题型保留 | P0 |
| FR-A6 | 自动路由 chem/analytic/solid | P0 |

### 学科
| ID | 需求 | 优先级 |
|----|------|--------|
| FR-B-chem | 化学 morph + kernel | P0 |
| FR-B-mol | 分子全自动扩展 | P0 |
| FR-B-analytic | **解析几何 LLM spec** | **P0（数学第一）** |
| FR-B-solid | 立体几何 LLM spec | P0（数学第二） |
| FR-B-mech | 化学 mechanism | P2 |

### 治理
| ID | 需求 | 优先级 |
|----|------|--------|
| FR-C-promote | **晋升正式题型** | **P0-M5（首期最后）** |
| FR-D-quota-s | 学生默认 10/日 | P0 |
| FR-D-quota-t | 教师默认 50/日 | P0 |
| FR-E-sub2api | 服务端 sub2api 通道 | P0 |

## 6. 图片确认流（已定）
```text
上传图片
  → Vision/OCR + LLM 结构化草稿（equation/条件/skillHint/关键几何元素）
  → 前端确认页（可编辑关键字段）
  → 用户点击确认
  → 创建正式 AI 生成 Job
  → Spec 校验 → HTML
```
- 未确认不得扣成功课件名额以外的「直接出课」；**确认后创建 job 计配额**（与文本直接创建 job 一致，细则 Phase3 写死）
- 低置信度字段高亮，要求用户核验

## 7. sub2api 通道（需求级）
- 调用方：仅 Node 服务端
- 协议：OpenAI compatible（chat/completions 或所支持的 responses，实现期探测）
- 配置：环境变量 / system_config，不进仓库明文
- 用途：意图路由、Spec 生成、修复重试、Vision、分子定义生成
- 失败：重试、降级错误信息、不写假成功 lesson
- 运维依赖：API 路径需避开 WAF 人机验证（已知风险）

## 8. 配额（已定默认）
| 角色 | 默认日配额 | 说明 |
|------|------------|------|
| student | **10** | 防刷；可 admin 改 |
| teacher | **50** | 教研更高 |
| admin | 不限或 200 | 可配 |

建议计数口径：**每创建 1 次 AI 生成 Job +1**（含随后失败），避免无限重试刷模型；「仅确认页、未点生成」不计。最终口径 Phase3 冻结。

## 9. 晋升正式题型（M5）
- 来源：成功 AI lesson + 有效 spec
- 动作：写入动态 catalog / 导出可复用条目，`enabled` 可控
- 权限：admin 执行；teacher 可申请
- 效果：学生以后可从固定/扩展目录直开，不再走 LLM
- 安排：**首期最后一程**，不阻塞 M1–M4 动态生成

## 10. 里程碑映射
| 里程碑 | 内容 |
|--------|------|
| M0 | sub2api + 配额 + AI job 骨架 |
| M1 | 化学文本/方程 |
| M2 | 分子全自动扩展 |
| M3 | **解析几何**文本/式子 |
| M4 | 图片（确认门闩）化+解几 |
| M4b | 立体几何 |
| M5 | **晋升正式题型** + 收尾增强 |

## 11. 权限矩阵
| 角色 | AI 三入口 | 默认日配额 | 公开分享 | 晋升 |
|------|-----------|------------|----------|------|
| student | 是 | 10 | 默认否 | 否 |
| teacher | 是 | 50 | 可送审 | 可申请 |
| admin | 是 | 高/不限 | 是 | 是 |

## 12. 风险（节选）
- sub2api 可用性/WAF  
- 自动分子科学性 → 自检门闩  
- 图片误识 → 确认门闩  
- 学生成本 → 10/日  

## 13. 验收方向
- 固定题全回归  
- 化学：文本/方程金标 + 至少 1 条自动补分子  
- 解几：文本/式子金标  
- 图片：无确认不能出最终课；确认后可出  
- 配额：学生第 11 次被拒  
- M5：晋升后目录可直达  

## 14. 已无阻塞的产品决策
首期产品决策已齐。剩余主要是 Phase2 金标用例清单细化与 Phase3 技术方案。

## 15. 结论
采用 **sub2api** 服务端通道；数学 **解析几何优先**；图片 **先确认后生成**；学生 **10 次/日**；**晋升题型放 M5**；化学分子库全自动扩展；师生均可使用 AI 三入口。

## 16. Phase 3 架构草案索引
详见：`docs/planning/phase3-architecture-api.md`

摘要：
- Job 分 `fixed` / `ai`，扩展 `generation_jobs`
- 新 API：`/api/ai/quota`、`/api/ai/jobs`、`/api/ai/image-drafts*`、M5 promote
- 图片强制确认；配额在创建 AI job 时计
- sub2api 仅服务端；分子 JSON 扩展库 + 自检
- 数学先 analytic 再 solid

## 17. 实现推进（2026-08-05）
- 实现选择已冻结（见 phase3 文档 §19）
- Analytic/Solid Spec 字段表：`docs/planning/spec-fields-analytic-solid.md`
- **M0 基建已落地**：sub2api client、配额、AI job/drafts API、worker AI stub
- AI 任务目前会被 worker 标记失败并提示等待 M1 管线（预期行为）

## 18. M1 化学管线
- API 仍用 `POST /api/ai/jobs`（inputMode text/equation）
- Worker 对 `kind=ai` 且化学路由执行 `runChemAiPipeline`
- 已知反应快路径不依赖 LLM；动态路径依赖 `SUB2API_*`
- 正确性门闩：`reaction_kernel.assemble_data`


## Findings — M2 / sub2api 运维

1. **模型可用性会变**：同一 key 下 `/models` 可能从 16 个缩到 2 个；硬编码 `grok-4.5` 会导致 404。生产应启动时 health + 可配置 fallback model。
2. **分子扩展正确性门闩**：不能只信 LLM JSON，必须 `selfcheck-molecule` + `assemble_data` 再持久化。
3. **slot 约定漂移**：扩展分子 slot（如 S 用 `A` 还是 `X`）可能与首轮 atom_map 不一致，repair 循环（maxAttempts）可收敛。
4. **扩展库位置**：默认 `server/data/molecule-extensions.json`，可用 `MOLECULE_EXTENSIONS_FILE` 隔离 e2e/测试。


## Findings — M3 解析几何
1. 已知 registry 快路径与化学一致，关键词命中 `ellipse_dot_range` 等 6 题即可免 LLM。
2. LLM 动态 Spec 以 schema 校验 + `generate.render_html` 注入模板为主；不做完整 sympy 重算（首期可演示，金标精算可后补）。
3. deepseek-v4-flash 对复杂 board JSON 有时 HTTP 524 / 超长 reasoning，需 `maxRepairAttempts` + 长 timeout。
4. worker 空 `skillHint` 可用关键词推断 chem/analytic。
