# EduLab 交互教学课件 Web 管理系统

基于 [wy51ai/edulab](https://github.com/wy51ai/edulab) 的三大交互教学技能（立体几何 / 解析几何 / 化学反应），一键生成带 Three.js/MathJax/KaTeX 的自包含课件，完美适配课堂大屏与低带宽环境。
![Version](https://img.shields.io/badge/version-v0.1.0-green.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)
![Vite](https://img.shields.io/badge/Vite-6-646cff.svg)
![Python](https://img.shields.io/badge/Python-3776AB.svg)
![MySQL](https://img.shields.io/badge/MySQL-4479a1.svg)

> 将 edulab 三大技能封装为完整 Web 管理系统：固定题型一键出课 + **LLM 动态扩展**（文本 / 方程 / 图片确认生成）。服务端调度 Python worker 做 sympy 计算与 HTML 渲染，支持任务队列、用户认证、配额治理、课件审核。

### 演示截图（待补充）

![image-20260804213641234](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/image-20260804213641234.png)
**首页**：快速入口 + 学科选择

![image-20260804213724019](README.assets/image-20260804213724019.png)

**生成中心**：选题型/参数 → 一键提交

![image-20260804213810389](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/image-20260804213810389.png)
**任务中心**：实时进度 + 取消/重试

![image-20260804213840090](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/image-20260804213840090.png)
**课件广场**：公开课件浏览 + iframe 预览

![image-20260804213907444](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/image-20260804213907444.png)
**管理后台**：用户/审核/统计/题型目录

### 演示视频

生成的课件是**自包含单页 HTML**（Three.js + MathJax/KaTeX 内联或 CDN），直接浏览器打开即可交互。

![image-20260804214944322](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/image-20260804214944322.png)

**推荐在线播放方式**：
1. 本地双击 `server/uploads/lessons/<lesson-id>/index.html`

2. 或通过 `/lessons/:id/view` 接口 iframe 嵌入

   化学-电解水

![bg7o9-3pdxq](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/bg7o9-3pdxq.gif)

  立体几何

   ![1oxa1-q03ki](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/1oxa1-q03ki.gif)

  納于氯气

![9biko-gmydr](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/9biko-gmydr.gif)

### 项目介绍

本项目将 edulab 三大交互技能封装为完整 Web 管理系统：
- 教师/学生通过浏览器提交**固定题型**或 **AI 动态题**生成课件
- 后台 Worker 调用 skill kernel（sympy / 分子几何）校验并渲染自包含 HTML
- 支持任务队列、用户认证、RBAC、日配额、课件管理与管理员审核
- LLM 仅服务端调用（sub2api OpenAI 兼容通道），**不把 API Key 下发前端**

### 核心能力一览

#### 固定题型（Registry）
- **立体几何**（Three.js 3D + MathJax）：正方体/长方体线面角、体积、随机出题
- **解析几何**（Canvas 2D + KaTeX）：椭圆/双曲线/抛物线 6 种经典问题（参数滑块实时重算）
- **化学反应**（Three.js 3D + KaTeX）：甲烷/氢气/葡萄糖燃烧、电解水、氧化还原、酯化

#### AI 动态生成（2026-08 新增，M0–M4）
- **三入口**：文本 → 方程/式子 → 图片（**识别 → 用户确认 → 再生成**）
- **化学 AI（M1）**：已知反应快路径 + LLM morph Spec + kernel 校验重试
- **分子库自动扩展（M2）**：缺 species 时 LLM 生成几何 JSON → selfcheck → 落库再渲染
- **解析几何 AI（M3）**：6 类已知题快路径 + LLM `lesson/steps/board` Spec 渲染
- **图片入口（M4）**：Vision 识图草稿、可编辑 `editable`、确认后计配额出课
- **治理**：角色白名单、学生默认 10 次/日、教师 50 次/日、幂等键、错误码与 validationTrace

> 立体几何 AI（M4b）与「晋升正式题型」（M5）仍在规划/完善中。

### 技术栈

- 前端：React 19 + Vite 6 + TypeScript
- 后端：Express 4 + Node.js（ESM）
- Worker：Node 调度 + Python 子进程（sympy / skill kernel）
- LLM：sub2api（OpenAI Compatible chat + vision）
- 数据库：MySQL 8（生产） / 内存 JSON（开发）
- 部署：Docker + docker-compose

### 快速开始

#### 前置依赖
- Node.js 20+（推荐）
- Python 3 + sympy（`pip3 install sympy`）

#### 开发模式
```bash
# 安装依赖
npm install
npm --prefix server install

# 启动后端 + Worker + 前端（三个进程并行）
npm run dev:all

# 或分别启动
npm run dev:server   # API on :3002
npm run dev:worker   # Worker
npm run dev          # Vite dev server on :3000
```

打开 http://localhost:3000

**演示管理员**：设置 `SEED_DEMO_ACCOUNTS=true` 并配置 `DEMO_ADMIN_PASSWORD`（至少 12 位）。

#### 生产构建
```bash
npm run build
NODE_ENV=production node server/index.js
```

#### Docker 部署
```bash
docker compose up -d --build
```

服务启动在 http://localhost:3002（API + 静态前端），MySQL 数据持久化到 Docker volume。

### 环境变量

复制 `.env.example` 为项目根目录 `.env`（已 gitignore）：

#### 基础

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3002 | API 端口 |
| USE_MYSQL | false | true 使用 MySQL，否则内存 JSON |
| MYSQL_HOST / PORT / USER / PASSWORD / DATABASE | localhost... | MySQL 连接 |
| PYTHON_BIN | python3 | 需可 `import sympy`（解几） |
| WORKER_CONCURRENCY | 1 | Worker 并发 |
| LESSON_ARTIFACTS_ROOT | ./server/uploads/lessons | 课件产物目录 |
| SESSION_TTL_HOURS | 168 | 会话有效期 |
| SEED_DEMO_ACCOUNTS | false | 是否种子管理员 |
| DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD | - | 演示管理员（密码≥12 位） |

#### AI / Sub2API（服务端）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| AI_ENABLED | true | AI 总开关 |
| AI_ALLOW_ROLES | student,teacher,admin | 可用角色 |
| AI_QUOTA_STUDENT | 10 | 学生日配额 |
| AI_QUOTA_TEACHER | 50 | 教师日配额 |
| AI_QUOTA_ADMIN | 200 | 管理员日配额 |
| AI_MAX_REPAIR_ATTEMPTS | 3 | Spec 修复重试次数 |
| SUB2API_BASE_URL | - | 如 `https://xxx/v1`（不要写成 `/v1/v1`） |
| SUB2API_API_KEY | - | 服务端密钥 |
| SUB2API_MODEL | - | 文本模型 ID（以 `/v1/models` 实际列表为准） |
| SUB2API_VISION_MODEL | 同 MODEL | 识图模型 |
| SUB2API_TIMEOUT_MS | 120000 | 建议复杂题 180000–300000 |
| SUB2API_MAX_RETRIES | 2 | 传输层重试 |
| SUB2API_USER_AGENT | OpenAI/JS 4.73.0 | 上游 UA |
| MOLECULE_EXTENSIONS_FILE | server/data/molecule-extensions.json | 分子扩展库 |
| AI_IMAGE_UPLOAD_ROOT | server/uploads/ai-images | 识图原图目录 |
| AI_IMAGE_MAX_BYTES | 5000000 | 图片大小上限 |

> API Key 勿提交仓库。模型可用性会变化，请先 `GET {SUB2API_BASE_URL}/models` 确认 ID。

### 项目结构

```
ai-teaching-edulab/
├── server/                             # Node + Express API
│   ├── index.js                        # 路由 + 鉴权 + AI/固定任务 API
│   ├── db.js                           # MySQL / 内存 JSON 双模式
│   ├── loadEnv.js
│   ├── services/
│   │   ├── rbac.js                     # 角色权限
│   │   ├── skillCatalog.js             # 技能/题型目录
│   │   ├── skillRunner.js              # Python skill 调用
│   │   ├── llm/sub2apiClient.js        # OpenAI 兼容 chat/vision
│   │   └── ai/
│   │       ├── config.js / quota.js    # AI 配置与日配额
│   │       ├── chem/                   # M1/M2 化学管线 + 分子扩展
│   │       ├── analytic/               # M3 解析几何管线
│   │       ├── image/recognize.js      # M4 识图草稿
│   │       └── python/*_spec_tool.py   # 校验/渲染工具
│   ├── workers/lessonWorker.js         # 固定题 + AI 任务 Worker
│   ├── data/                           # memory-db / molecule-extensions
│   ├── uploads/lessons|ai-images       # 课件与识图原图
│   └── tests/ai_m*.test.js             # AI 单测
├── docs/                               # 需求/概要/详细设计/数据字典
├── App.tsx / styles.css / types.ts     # 前端
├── node_modules/@wy51ai/edulab/skills  # 三大技能内核
├── Dockerfile / docker-compose.yml
└── task_plan.md / progress.md / findings.md
```

### API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` `/login` | 注册 / 登录 |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/catalog/skills` | 学科与题型目录 |
| POST | `/api/jobs` | 创建**固定题型**任务 |
| GET | `/api/jobs` `/api/jobs/:id` | 任务列表 / 详情（含 AI） |
| POST | `/api/jobs/:id/cancel` `/retry` | 取消 / 重试 |
| GET | `/api/lessons` `/api/lessons/:id` | 课件列表 / 详情 |
| PATCH/DELETE | `/api/lessons/:id` | 更新 / 删除课件 |
| POST | `/api/lessons/:id/submit` | 提交审核 |
| GET | `/lessons/:id/view` | 课件 HTML 预览 |
| GET | `/api/ai/quota` | AI 配额 |
| GET | `/api/ai/health` | sub2api 健康（teacher/admin） |
| POST | `/api/ai/jobs` | **文本/方程 AI 生成** |
| POST | `/api/ai/image-drafts` | **识图草稿** |
| GET/PATCH | `/api/ai/image-drafts/:id` | 查看 / 编辑草稿 |
| POST | `/api/ai/image-drafts/:id/confirm` | **确认后生成** |
| POST | `/api/ai/image-drafts/:id/discard` | 丢弃草稿 |
| GET/PATCH | `/api/admin/*` | 统计、配置、用户、审核 |

### 验证状态（摘录）

- 固定题型链路：注册 → 登录 → cube/box/燃烧题 → 预览
- AI 单测：`ai_m0` ~ `ai_m3` 通过（配额、化学、分子扩展、解析几何）
- AI 联调冒烟：电解水快路径、`C+O2→CO2`、缺分子 `S+O2→SO2`、解几已知路径
- Docker 一键启动验证通过


## AI 动态生成用法

需先配置 `SUB2API_*`，并同时启动 **API + Worker**。

### 1）文本 / 方程直接出课

```bash
# 登录后拿到 token
curl -s http://localhost:3002/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"******"}'

# 创建 AI 任务（化学示例）
curl -s http://localhost:3002/api/ai/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputMode": "equation",
    "content": "C + O2 -> CO2",
    "skillHint": "edu-chem-reaction",
    "options": {"title": "碳的燃烧"}
  }'

# 解析几何示例
curl -s http://localhost:3002/api/ai/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "inputMode": "text",
    "content": "请演示椭圆数量积取值范围",
    "skillHint": "edu-analytic-geometry"
  }'

# 轮询任务
curl -s http://localhost:3002/api/jobs/<jobId> -H "Authorization: Bearer $TOKEN"
```

### 2）图片：识别 → 确认 → 生成

```bash
# 创建草稿（base64 或 imageUrl）
curl -s http://localhost:3002/api/ai/image-drafts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "skillHint": "edu-analytic-geometry",
    "imageBase64": "data:image/png;base64,...",
    "note": "可选备注"
  }'

# 用户确认识别结果（可改 editable）后才扣配额并生成
curl -s http://localhost:3002/api/ai/image-drafts/<draftId>/confirm \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "editable": {
      "skillId": "edu-chem-reaction",
      "problemText": "请演示电解水",
      "equation": "2H2O -> 2H2 + O2",
      "conditions": "",
      "ask": "微观过程"
    }
  }'
```

### 3）配额

```bash
curl -s http://localhost:3002/api/ai/quota -H "Authorization: Bearer $TOKEN"
```

默认：学生 10 次/日，教师 50 次/日（创建 AI job 时计数；图片草稿创建默认不计生成配额）。

---

## AI 相关 API 速查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ai/quota` | 查询配额 |
| GET | `/api/ai/health` | sub2api 健康（teacher/admin） |
| POST | `/api/ai/jobs` | 文本/方程 AI 生成 |
| POST | `/api/ai/image-drafts` | 识图草稿 |
| GET/PATCH | `/api/ai/image-drafts/:id` | 查看/编辑草稿 |
| POST | `/api/ai/image-drafts/:id/confirm` | 确认并生成 |
| POST | `/api/ai/image-drafts/:id/discard` | 丢弃草稿 |
| GET | `/api/jobs/:id` | 任务进度（含 AI） |

更多字段与错误码见 `docs/详细设计.md`、`docs/数据字典.md`。

---

## 文档

| 文档 | 路径 |
|------|------|
| 需求说明书 | [docs/需求说明书.md](docs/需求说明书.md) |
| 概要设计 | [docs/概要设计.md](docs/概要设计.md) |
| 详细设计 | [docs/详细设计.md](docs/详细设计.md) |
| 数据字典 | [docs/数据字典.md](docs/数据字典.md) |
| 架构/API 草案 | [docs/planning/phase3-architecture-api.md](docs/planning/phase3-architecture-api.md) |
| 解几 Spec 字段 | [docs/planning/spec-fields-analytic-solid.md](docs/planning/spec-fields-analytic-solid.md) |
| 文档索引 | [docs/README.md](docs/README.md) |

过程文档：`task_plan.md` / `progress.md` / `findings.md`

---

## 测试

```bash
# 服务端单测（含 AI M0–M3）
npm test
# 或
npm --prefix server test
```

主要用例：
- `server/tests/ai_m0.test.js` — 配额、AI job 字段、sub2api 未配置
- `server/tests/ai_m1_chem.test.js` — 化学校验/快路径
- `server/tests/ai_m2_molecule.test.js` — 分子扩展
- `server/tests/ai_m3_analytic.test.js` — 解析几何
- `server/tests/catalog.test.js` / `db.test.js` — 目录与存储

建议联调冒烟：
1. 固定题：cube / electrolysis_water
2. AI 化学：`C+O2→CO2`、缺分子 `S+O2→SO2`
3. AI 解几：椭圆数量积范围（已知路径）
4. 图片草稿 confirm 后出课

---

## 架构速览

```text
Browser (React)
    │  JSON + Bearer
    ▼
Express API  ── Memory JSON / MySQL
    │
    ▼ claim
Lesson Worker
    ├─ fixed: skill generate.py
    ├─ chem AI: LLM Spec → kernel → HTML（可自动扩分子）
    ├─ analytic AI: LLM board Spec → template
    └─ image: vision draft → confirm → 上管线
    │
    ▼
sub2api (chat/vision)    @wy51ai/edulab skills
```

## 技术交流群

欢迎加入技术交流群，分享你的 Skills 和使用心得：

![技术交流群](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Obsidian/20260802145421_15_2.jpg)

## 作者联系

- **作者**: （hailaobao）
- **微信**: laohaibao2025
- **邮箱**: [Ujfgtujghedte@gmail.com](mailto:Ujfgtujghedte@gmail.com)

![微信二维码](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/Screenshot_20260123_095617_com.tencent.mm.jpg)

## 打赏

如果这个项目对你有帮助，欢迎请我喝杯咖啡 ☕

![微信支付](https://mypicture-1258720957.cos.ap-nanjing.myqcloud.com/image-20250914152855543.png)

## 项目统计

### 版本信息

- **当前版本**: v0.1.0
- **主要语言**: TypeScript / JavaScript（Node）
- **生成引擎**: 本地 edulab skills + Python/sympy

### 版本历史

- **v0.1.0** (2026-08) - 首个可交付版本：三大技能 + 前端 + 后端 + Worker + 课件管理 + 测试
- **v0.2.0-dev** (2026-08-05) - AI 动态扩展：化学/解析几何 LLM 管线、分子自动扩展、图片确认生成、配额治理、设计文档齐套



## 🎉 致谢

感谢以下项目对本项目提供的有力支持：

1.[wy51ai/edulab](https://github.com/wy51ai/edulab) 

   把学科问题转成**可交互的教学网页**

## 路线图

### 已完成

- [x] 产品/架构/API/数据模型文档与可运行骨架
- [x] Job + Worker + skill pipeline 闭环
- [x] 前端页面（生成中心、任务中心、广场、管理后台等）
- [x] 数据库 + 认证 + RBAC
- [x] Python 生成 Worker（sympy + HTML 渲染）
- [x] 课件库 + 预览 + 审核
- [x] Docker Compose 多服务交付
- [x] 固定题型测试与交付
- [x] **M0** AI 基建：sub2api 客户端、配额、AI job 字段、幂等
- [x] **M1** 化学文本/方程 AI 管线
- [x] **M2** 分子库全自动扩展
- [x] **M3** 解析几何文本/方程 AI 管线
- [x] **M4** 图片识别草稿 → 确认 → 生成
- [x] 交付文档：需求说明书 / 概要设计 / 详细设计 / 数据字典（`docs/`）

### 进行中 / 计划

- [ ] **M4b** 立体几何 AI（文本/式子/图片确认流）
- [ ] **M5** 优质 AI 课件晋升正式题型 + 动态目录合并
- [ ] 前端 AI 生成中心完整 UI（文本/方程/图片确认页）
- [ ] 对象存储（MinIO/S3）替换本地 uploads
- [ ] 队列升级为 Redis/BullMQ（可选）
- [ ] 模型健康检查 + fallback 列表
- [ ] 生产级可观测性（指标、告警、任务仪表盘）

### 优化计划

- [ ] Worker 并发与长耗时模型超时策略细化
- [ ] 解几 LLM Spec 与 sympy 金标回填加强
- [ ] 审核与越权自动化回归清单持续补齐
- [ ] 前端体验与课件广场运营能力增强

## License

Apache-2.0（edulab 核心技能）

本项目采用 Apache-2.0 协议开源。在遵守协议的前提下，可自由使用、修改与分发。
