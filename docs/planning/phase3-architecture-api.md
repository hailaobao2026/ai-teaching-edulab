# Phase 3: 架构 / API 草案

> 状态：实现基线（核心链路已编码；本文保留规划与未实现项）
> 范围：化学 + 数学（解析几何优先 → 立体几何）  
> 通道：sub2api（服务端）  
> 入口：文本 → 方程/式子 → 图片（图片必须确认后生成）  
> 权限：student + teacher + admin（可配置）；配额默认 10 / 50 / 200
> 分子库：全自动扩展  
> 晋升题型：M5

---

## 1. 设计目标

1. **不破坏**现有固定题型：`POST /api/jobs` + `REGISTRY` 路径继续可用。  
2. 新增 **AI 动态路径**：多模态输入 → Spec JSON → kernel 校验 → HTML。  
3. **正确性门闩**在 skill kernel / schema，不在 LLM 文案。  
4. **sub2api** 仅服务端调用；Key 不进前端。  
5. 图片路径强制 **识别草稿 → 用户确认 → 正式生成**。  
6. 化学缺分子时 **自动合成分子定义并自检入库**，失败不脏写。

---

## 2. 逻辑架构

```text
┌─────────────────────────────────────────────────────────────┐
│  Web (React)                                                │
│  固定题型页 | AI 生成页(文本/方程/图片) | 图片确认页 | 课件库  │
└─────────────┬───────────────────────────────┬───────────────┘
              │ REST                          │ 静态/预览
              ▼                               ▼
┌──────────────────────────────┐   ┌──────────────────────────┐
│  API Server (Express)        │   │  /uploads /lessons HTML  │
│  auth · quota · catalog      │   └──────────────────────────┘
│  jobs(fixed) · ai/*          │
└─────────────┬────────────────┘
              │ enqueue
              ▼
┌──────────────────────────────┐
│  Worker(s)                   │
│  lessonWorker + aiWorker阶段 │
│  或统一 worker 按 job.kind   │
└──────┬─────────────┬─────────┘
       │             │
       │             ├─ Sub2ApiClient ──► sub2api ──► upstream model
       │             │
       │             ├─ Spec validators (chem/analytic/solid)
       │             ├─ MoleculeAutoExtender (chem)
       │             └─ skillRunner / render pipelines
       ▼
  @wy51ai/edulab skills (override 目录优先)
```

### 2.1 两种 Job 形态

| kind | 含义 | 入口 |
|------|------|------|
| `fixed` | 现有：skillId + problemType + params | `POST /api/jobs` |
| `ai` | 新增：inputMode + content → spec → html | `POST /api/ai/jobs`（确认后）等 |

实现上可：
- **方案 A（推荐）**：同一张 `generation_jobs` 表增加字段 `kind/input_mode/ai_meta/spec...`  
- **方案 B**：独立 `ai_generation_jobs` 表，成功后再写 lessons  

草案采用 **方案 A**，减少双队列复杂度。

---

## 3. 模块划分

| 模块 | 路径建议 | 职责 |
|------|----------|------|
| Sub2ApiClient | `server/services/llm/sub2apiClient.js` | chat/vision 调用、超时、重试、usage 记录 |
| PromptRegistry | `server/services/ai/{chem,analytic}/prompts.js` | 各 skill 系统提示与 JSON schema 说明 |
| IntentRouter | `server/workers/lessonWorker.js` + 各 pipeline 路由函数 | text/equation → skillId |
| SpecGenerators | `server/services/ai/{chem,analytic}/llmSpec.js` | LLM → Spec |
| SpecRepairLoop | `server/services/ai/{chem,analytic}/pipeline.js` | 校验错误回灌 LLM，最多 N 次 |
| ChemValidator | `server/services/ai/chem/validateRender.js` | schema + 调 Python kernel |
| AnalyticValidator | `server/services/ai/analytic/validateRender.js` | schema + Python 校验/渲染 |
| SolidValidator | M4b 规划项 | 尚未实现 |
| MoleculeAutoExtender | `server/services/ai/chem/moleculeStore.js` + pipeline | 缺 species → LLM 分子定义 → 自检 → 持久化 |
| ImageUnderstander | `server/services/ai/image/recognize.js` | 图片 → 结构化 draft（未出课） |
| QuotaService | `server/services/ai/quota.js` + `server/db.js` | 日配额查询与原子 Job 创建 |
| AiJobOrchestrator | `server/workers/lessonWorker.js` | 串联阶段、写 progress |
| DynamicCatalog | M5 规划项 | 尚未实现 |
| skill override root | `skills/` 或 `vendor/edulab-skills/` | 可写分子库与扩展 generate，避免只改 node_modules |

---

## 4. 端到端流程

### 4.1 文本 / 方程（无确认门闩）

```text
POST /api/ai/jobs
  { inputMode: "text"|"equation", content, skillHint? }
        │
        ├─ auth + role 允许 AI
        ├─ createAiJob()  // 事务内完成幂等检查、配额预占与创建
        └─ 202 { job }

Worker:
  stage=routing            → inferAiSkillHint + skill route
  stage=generating_spec   → SpecGenerator(skill)
  stage=validating         → Validator；失败 → repairLoop（≤N）
  stage=extending_molecules → 仅 chem 缺分子时 MoleculeAutoExtender
  stage=rendering          → kernel assemble + template / generate 适配
  stage=persisting         → lesson + assets
  status=succeeded | failed
```

### 4.2 图片（强制确认）

```text
1) POST /api/ai/image-drafts  (multipart file 或 JSON imageBase64/imageUrl)
     → 不计「生成配额」或计「识别配额」二选一：默认 **不计生成配额**
     → Vision/OCR+LLM → draft
     → 返回 draftId + 可编辑字段 + confidence

2) 前端确认页展示 draft，用户可改 skill/方程/条件

3) POST /api/ai/image-drafts/:id/confirm
     → 将 draft 固化为 content
     → **等同创建 AI job**（此处计生成配额）
     → 进入 4.1 Worker 后半段
```

未 confirm 不得写最终 lesson。

### 4.3 固定题型（保持）

```text
POST /api/jobs { skillId, problemType, params }
  → 现有 lessonWorker → generate.py <key>
```

---

## 5. 数据模型草案

### 5.1 `generation_jobs` 扩展字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `kind` | enum(`fixed`,`ai`) | 默认 `fixed` 兼容老数据 |
| `input_mode` | enum(`catalog`,`text`,`equation`,`image`) | fixed 用 `catalog` |
| `skill_id` | string | ai 可在 route 后回填 |
| `problem_type` | string | fixed 必填；ai 可用 `ai_dynamic` 或最终晋升 key |
| `params` | JSON | 兼容旧参数 |
| `source_text` | text | 原始文本/方程 |
| `source_asset_id` | string? | 图片资源 ID 或已落盘路径 |
| `draft_id` | string? | 图片草稿 |
| `skill_hint` | string? | 用户/识别提示 |
| `spec` | JSON? | 最终通过校验的 spec |
| `spec_versions` | JSON? | 规划字段；当前实现使用 `spec` 保存最终/失败快照 |
| `validation_trace` | JSON? | 错误与重试轨迹 |
| `molecule_extensions` | JSON? | 本次自动新增 species 列表 |
| `ai_meta` | JSON | model, usage, attempts, routeConfidence, provider=sub2api |
| `error_code` | string? | `QUOTA_EXCEEDED` / `VALIDATION_FAILED` / `LLM_ERROR` / `WAF_OR_UPSTREAM`… |

内存 DB / MySQL 同步加列；旧行 `kind=fixed`。

### 5.2 `ai_image_drafts`（新表/集合）

| 字段 | 说明 |
|------|------|
| id | draftId |
| user_id | 所有者 |
| asset_id / path | 原图 |
| status | `pending_confirm` / `confirmed` / `expired` / `discarded` |
| raw_recognition | 模型原始结构 |
| editable_fields | 前端表单绑定 |
| skill_hint | chem/analytic/solid |
| confidence | 0–1 或分级 |
| expires_at | 如 24h |
| confirmed_job_id | 确认后关联 |

### 5.3 `molecule_library_extensions`（新）

| 字段 | 说明 |
|------|------|
| species_id | 如 `HCl` |
| definition | JSON（atoms/slots/bonds/meta）或生成用 Python 片段哈希 |
| source_job_id | 触发任务 |
| validator_report | 自检输出 |
| status | `active` / `disabled` |
| created_at | |

运行时：merge **内置 molecules** + **active 扩展** 再装配。

### 5.4 `dynamic_problem_catalog`（M5）

| 字段 | 说明 |
|------|------|
| skill_id | |
| problem_key | 如 `ai_chem_xxx` |
| title / name | |
| spec_ref | 存 spec 或 lesson 关联 |
| source_lesson_id / source_job_id | |
| enabled | |
| promoted_by | admin |
| created_at | |

与现有 `problem_catalog` 可合并视图：`listSkills` = 内置 + 动态 enabled。

### 5.5 `usage_daily_quota`（或 Redis/内存计数）

| 字段 | 说明 |
|------|------|
| user_id + date | 复合键 |
| ai_jobs_created | 计数 |
| limit_snapshot | 当日生效限额 |

---

## 6. API 草案

统一约定：
- 鉴权：`Authorization: Bearer <token>`（沿用）
- 错误体：`{ error, code?, details? }`
- AI 相关默认要求 login；student/teacher/admin 均可（配额不同）

### 6.1 配额

#### `GET /api/ai/quota`
```json
{
  "role": "student",
  "date": "2026-08-05",
  "limit": 10,
  "used": 3,
  "remaining": 7
}
```

### 6.2 创建 AI 生成任务（文本/方程）

#### `POST /api/ai/jobs`
Request:
```json
{
  "inputMode": "text",
  "content": "请演示甲烷在氧气中燃烧的微观过程",
  "skillHint": "edu-chem-reaction",
  "options": {
    "language": "zh-CN",
    "gradeBand": "junior",
    "title": "可选标题"
  },
  "idempotencyKey": "optional-uuid"
}
```

`inputMode=equation` 时 `content` 为方程/几何条件式字符串。

Response `202`（首次创建；幂等复用时为 `200`）:
```json
{
  "job": {
    "id": "job_xxx",
    "kind": "ai",
    "status": "queued",
    "inputMode": "text",
    "progress": 0,
    "reused": false,
    "quota": { "used": 4, "limit": 10, "remaining": 6 }
  }
}
```

错误：
- `401` 未登录  
- `403` 角色禁用 AI（admin 配置）  
- `429` + `code=QUOTA_EXCEEDED`  
- `400` 内容空/过长  

### 6.3 查询任务（复用+扩展）

#### `GET /api/jobs/:id`
在现有结构上增加 AI 字段：
```json
{
  "job": {
    "id": "job_xxx",
    "kind": "ai",
    "status": "running",
    "currentStage": "validating",
    "progress": 55,
    "skillId": "edu-chem-reaction",
    "inputMode": "equation",
    "validationTrace": [{ "attempt": 1, "errors": ["atom_map missing H3"] }],
    "aiMeta": { "provider": "sub2api", "model": "gpt-x", "attempts": 2 },
    "lessonId": null,
    "errorMessage": null
  }
}
```

列表 `GET /api/jobs` 支持 `?kind=ai|fixed`。

### 6.4 图片草稿

#### `POST /api/ai/image-drafts`
- `multipart/form-data`: `file` + 可选 `skillHint`、`note`
- JSON：`imageBase64` 或 `imageUrl` + 可选 `skillHint`、`note`
- 图片最大 5MB，服务端校验 MIME 与文件头；识别草稿不提供无图旁路

Response `201`:
```json
{
  "draft": {
    "id": "draft_xxx",
    "status": "pending_confirm",
    "skillHint": "edu-analytic-geometry",
    "confidence": 0.72,
    "editable": {
      "skillId": "edu-analytic-geometry",
      "problemText": "识别出的题干…",
      "equation": "x^2/4 + y^2/3 = 1",
      "conditions": "过点…",
      "ask": "求离心率范围"
    },
    "warnings": ["部分符号识别置信度低"],
    "expiresAt": "2026-08-06T00:00:00Z"
  }
}
```

#### `GET /api/ai/image-drafts/:id`

#### `PATCH /api/ai/image-drafts/:id`
用户改 `editable` 字段。

#### `POST /api/ai/image-drafts/:id/confirm`
```json
{ "editable": { "/* 可带最终确认快照 */" } }
```
Response `202`（首次确认）或 `200`（幂等复用）：`{ "job": { ... }, "reused": false, "quota": { ... } }`

#### `POST /api/ai/image-drafts/:id/discard`

### 6.5 课件与资产
复用：
- `GET /api/lessons/:id`
- preview / submit / review  

AI lesson 元数据可在 summary 或扩展字段标记 `source=ai`。

### 6.6 晋升正式题型（M5）

#### `POST /api/admin/dynamic-catalog/promote`
```json
{
  "lessonId": "les_xxx",
  "problemKey": "ai_ellipse_custom_001",
  "name": "椭圆·自定义数量积",
  "enabled": true
}
```
权限：admin；teacher 走 `POST /api/teacher/dynamic-catalog/requests`（可选）。

#### `GET /api/catalog/skills`
返回：内置题型 + `enabled` 动态题型。

#### `PATCH /api/admin/dynamic-catalog/:skillId/:problemKey`
启停动态题。

### 6.7 Admin 配置扩展

`GET/PATCH /api/admin/config` 增加：
```json
{
  "ai": {
    "enabled": true,
    "sub2apiBaseUrl": "https://sub2api.example/v1",
    "model": "gpt-5.6-sol",
    "visionModel": "gpt-5.6-sol",
    "maxRepairAttempts": 3,
    "quota": { "student": 10, "teacher": 50, "admin": 200 },
    "allowRoles": ["student", "teacher", "admin"],
    "imageConfirmRequired": true
  }
}
```
密钥：`SUB2API_API_KEY` 仅环境变量，API 只回显「是否已配置」。

---

## 7. Worker 阶段机

| stage | 说明 | progress 建议 |
|-------|------|----------------|
| `queued` | 等待 | 0 |
| `routing` | 定 skill | 10 |
| `understanding` | 规划阶段；当前图片识别在 draft 阶段完成，不写入 Job stage | - |
| `generating_spec` | LLM 出 spec | 35 |
| `validating` | schema+kernel | 55 |
| `repairing` | 带错误重试 | 55–70 |
| `extending_molecules` | 自动补分子 | 75 |
| `rendering` | 出 HTML | 90 |
| `persisting` | 写 lesson | 95 |
| `succeeded` / `failed` | 终态 | 100 |

`current_stage` 已有字段，直接复用字符串。

---

## 8. Spec 契约策略

### 8.1 化学（已有）
对齐 `edu-chem-reaction/references/problem-schema.md`：
- morph：`reactants/products/atom_map/...`
- mechanism：atoms/fragments（P2）

校验：
1. JSON Schema  
2. `reaction_kernel.assemble_data`  
3. 渲染 template  

### 8.2 解析几何（M3，优先）
从现有 `build_*` 返回的 lesson dict **反推 `AnalyticLessonSpec`**：
- meta（title, type key）
- conic 参数（a,b,e,p…）
- 交互参数（slider 变量、范围）
- 题目 HTML、步骤、答案结构
- 与 `analytic_kernel` 可计算字段同源

LLM 不直接写 Python；只写 JSON。  
Validator：字段齐全 → 调用最小 Python 校验脚本（新建 `scripts/validate_spec.py` 或复用 kernel 函数）→ 再注入 template。

### 8.3 立体几何（M4b）
同样从 `build_cube_data` 等反推 `SolidLessonSpec`：
- bodies / points / edges / elements  
- steps 高亮与镜头  
- 求解目标（线面角/体积…）与答案  

### 8.4 版本
Spec 带 `specVersion: 1`；不兼容时升级版本号与迁移。

---

## 9. sub2api 接入草案

```text
env:
  SUB2API_BASE_URL=https://sub2api.xxx/v1
  SUB2API_API_KEY=sk-...
  SUB2API_MODEL=gpt-5.6-sol
  SUB2API_VISION_MODEL=gpt-5.6-sol  # 可同模型
  SUB2API_TIMEOUT_MS=120000
  SUB2API_MAX_RETRIES=2
```

`Sub2ApiClient`:
- `chatCompletions({ messages, responseFormat: json_object })`
- `vision({ imageUrlOrBase64, prompt })`
- 统一记录 usage；错误分类：网络 / 401 / 502 / HTML-WAF / 超时

**运维前提**：`/v1/chat/completions` 不得返回 WAF HTML（已知风险）。

可选：请求头 `User-Agent` 由服务端固定为 SDK 风格（若上游需要）；与账号级 header override 无关时在 client 内设置。

---

## 10. 分子全自动扩展算法

```text
on ChemValidate missing species S:
  if S in extensionDB.active: bind and continue
  candidate = LLM.generateMoleculeDefinition(S)
  staticCheck(candidate)  # slots, elements, bonds
  run python molecules selfcheck with candidate patched in temp store
  if pass:
    persist extensionDB
    reload molecule provider
    resume assemble
  else:
    repairLoop: ask LLM rewrite reaction avoiding S OR rewrite molecule
    if still fail: job failed with code MOLECULE_EXTEND_FAILED
```

安全：
- 不 `eval` 任意代码字符串执行业务；定义以 **JSON 数据** 表达，由受控 builder 解释。  
- 若必须落 Python，仅写受限 AST/白名单模板。  

---

## 11. 配额与限流

| 规则 | 值 |
|------|-----|
| student 默认 | 10 AI jobs / 日 |
| teacher 默认 | 50 / 日 |
| admin 默认 | 200 / 日 |
| 计数点 | **创建 AI job 成功入库时 +1**（文本/方程 POST；图片 confirm） |
| 原子性 | 配额预占、幂等检查和 Job 入库在 `createAiJob` 同一事务/文件锁内完成 |
| 幂等复用 | 相同用户和 `idempotencyKey` 返回已有 Job，不重复计数 |
| 图片 draft | 默认不计生成配额；可另加 `imageDraftPerDay` 防刷（如 20） |
| 现有 `rateLimit('jobs')` | AI 接口单独 `rateLimit('ai_jobs')` |

---

## 12. 安全

1. 前端无 Key；所有 LLM 服务端。  
2. LLM 输出只走 JSON parse + schema；拒绝代码执行字段，课件 HTML 经过白名单净化。
3. Prompt 注入：系统提示固定角色；用户内容当数据。  
4. 图片大小/类型限制；病毒扫描可选。  
5. 化学危险反应：可提示“教学演示，勿实验”。  
6. 审计：userId、jobId、model、token、ip（若有）。  

---

## 13. 前端信息架构（草案）

1. **生成中心** Tab：固定题型 | AI 生成  
2. AI 生成：三段式输入切换 文本 / 方程 / 图片  
3. 图片：上传 → 确认页（editable 表单 + 置信度警告）→ 提交  
4. 任务进度：复用 jobs 进度条，展示 stage  
5. 失败：展示 validationTrace 摘要  
6. 配额条：剩余次数  

---

## 14. 与现有 API 兼容矩阵

| 现有 API | AI 期行为 |
|----------|-----------|
| `POST /api/jobs` | 不变，仅 fixed |
| `GET /api/jobs` | 增加 kind 过滤与字段 |
| `POST /api/jobs/:id/retry` | ai job 允许从 failed 重试；当前重试不重新预占配额 |
| `GET /api/catalog/skills` | M5 后合并动态题 |
| lessons/review | 复用 |

---

## 15. 里程碑与 API 交付切片

| 里程碑 | 后端 API | 核心模块 |
|--------|----------|----------|
| M0 | quota, admin ai config, sub2api health, jobs.kind | Sub2ApiClient, QuotaService |
| M1 | `POST /api/ai/jobs` text/equation chem | Chem generator+validator+repair |
| M2 | job 内 extend_molecules + extensions CRUD admin | MoleculeAutoExtender |
| M3 | 同上 skill=analytic | Analytic generator+validator |
| M4 | image-drafts* + confirm | ImageUnderstander + 确认态 |
| M4b | solid skill | Solid pipeline |
| M5 | promote + catalog merge | DynamicCatalog |

---

## 16. 开放实现选择（评审点）

1. Worker 进程：同 `lessonWorker` 分流 vs 独立 `aiWorker`（推荐先同进程按 kind 分流，减部署复杂度）。  
2. 解析几何校验：纯 Node schema vs 调 Python kernel（推荐 **Python 同源校验**）。  
3. 分子定义存储：JSON 数据仓 vs 生成 py 文件（推荐 **JSON 数据仓 + 受控解释器**）。  
4. 重试配额：当前 `retryJob` 不重新预占 AI 配额。
5. idempotencyKey：短时去重防双击。  

---

## 17. 非目标（架构期仍排除）

- 浏览器直连 sub2api  
- LLM 热更新生产代码  
- 无确认图片直接出课  
- 首期并行完美 mechanism / 全竞赛题  

---

## 18. 后续工作（核心链路已实现）

1. 完善 M4b 立体几何 AI 管线。
2. 实现 M5 动态题型晋升与目录合并。
3. 补充 MySQL 集成测试和上传病毒扫描。

---

## 19. 实现选择冻结（2026-08-05 用户同意）

| # | 选择 | 结论 |
|---|------|------|
| 1 | Worker | **同进程按 `kind` 分流**（`lessonWorker`） |
| 2 | 数学校验 | **Python 同源 kernel 校验** |
| 3 | 分子存储 | **JSON 数据仓 + 受控解释器** |
| 4 | 失败重试配额 | 当前 `retryJob` 不重新预占 AI 配额；如调整需同步 API 与数据字典 |
| 5 | idempotencyKey | **启用**（短时去重） |

配套文档：`docs/planning/spec-fields-analytic-solid.md`
