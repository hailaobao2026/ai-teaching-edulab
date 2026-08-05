# Task Plan: EduLab Web 管理系统

## Goal
基于 wy51ai/edulab 开源项目的三大交互教学技能（立体几何、解析几何、化学反应），参考 ai-teaching-video-platform 的全栈架构，构建一个 Web 管理系统：用户可通过浏览器选择题型/参数、提交生成任务、预览交互课件、管理课件库，并具备用户权限、任务队列、管理后台等完整平台能力。

## Current Phase
Phase 9

## Phases

### Phase 1: 需求分析与架构设计
- [x] 研究 edulab 三大技能的功能、输入输出、CLI 接口
- [x] 研究参考项目 ai-teaching-video-platform 的前后端架构
- [x] 明确功能范围与技术选型
- [x] 输出架构设计文档（模块划分、API 设计、数据模型）
- **Status:** complete

### Phase 2: 项目脚手架与基础设施
- [x] 初始化项目结构（frontend / server / worker），npm 安装 `@wy51ai/edulab`
- [x] 配置 Vite + React + TS 前端、Express 后端、Python worker
- [x] 配置 Docker / docker-compose（MySQL + Node API + Worker）
- [x] 配置 .env / .env.example
- [x] 建立内存 DB + MySQL 双模式
- **Status:** complete

### Phase 3: 数据层与认证授权
- [x] 设计并实现数据表：users, sessions, generation_jobs, lessons, lesson_assets, problem_catalog, system_config
- [x] 实现注册/登录/会话（scrypt 密码哈希，同参考项目）
- [x] 实现 RBAC：student / teacher / admin 三种角色
- [x] 实现用户资料接口
- **Status:** complete

### Phase 4: 题型目录与生成任务
- [x] 建立可持久化、可管理的 problem_catalog：启动时同步内置题型，并提供管理员启停 API/UI
- [x] 实现 `POST /api/jobs`：接收 skill + problem_type + 参数
- [x] 实现 `GET /api/jobs`、`GET /api/jobs/:id`、retry、cancel
- [x] 任务状态机：queued → running → succeeded/failed/cancelled
- **Status:** complete

### Phase 5: Python 生成 Worker
- [x] Node worker 调度层：轮询 queued job → 调用 Python
- [x] 封装 skill runner：定位 skills/<skill>/scripts/generate.py，传递参数/JSON spec
- [x] 捕获 stdout/stderr、解析输出 HTML、写入 artifacts
- [x] 回写 progress / current_stage / result / error_message
- [x] 支持随机出题 seed
- [ ] 文字题目 spec、图片上传题目（延期到 LLM/Vision 二期）
- [x] 并发控制（默认 1，sympy 渲染吃 CPU）
- **Status:** complete

### Phase 6: 课件库与预览
- [x] 生成成功后自动创建 lesson 记录
- [x] 课件 CRUD：列表、详情、更新、删除
- [x] 课件发布/可见性：private / public / pending / approved / rejected
- [x] HTML 课件静态托管与签名访问（/lessons/:id/view）
- [ ] 课件封面/缩略图提取（当前仅登记 HTML 资产，封面提取延期）
- **Status:** complete

### Phase 7: 前端页面
- [x] 登录/注册页
- [x] 首页（平台介绍 + 快速入口）
- [x] 课件生成中心（选择学科/技能/题型 → 填参数 → 提交 → 实时进度）
- [x] 任务中心（状态、进度、重试、取消）
- [x] 课件广场（公开课件浏览、筛选）
- [x] 我的课件
- [x] 课件预览页（iframe 嵌入交互 HTML）
- [x] 教师审核页（教师/管理员 pending、approve、reject）
- [x] 管理后台（用户管理、统计、题型目录、系统配置）
- [x] 个人资料
- **Status:** complete

### Phase 8: 管理后台
- [x] 用户列表、禁用/启用、角色调整
- [x] 平台统计（用户数、任务数、课件数、运行中任务）
- [x] 题型目录管理（注册题型、启用/禁用）
- [x] 系统配置（sympy 路径、worker 并发、artifacts 根目录）
- [x] 课件审核（管理员审核公开课件）
- **Status:** complete

### Phase 9: 测试与交付
- [x] 后端单元测试（auth、jobs、lessons、rbac）
- [x] Worker 集成测试（mock Python 或真实跑一道题）
- [x] 端到端冒烟：注册 → 登录 → 生成 cube 题 → 预览
- [x] Docker 一键启动验证
- [x] README 与部署文档
- **Status:** complete

## Key Questions
1. ~~vendor 还是 npm 依赖~~ → 已确认：npm 依赖 `@wy51ai/edulab`
2. ~~首期是否只做已注册题型~~ → 已确认：首期只做"选择已注册题型 + 参数"，文字/图片入口留二期
3. ~~是否需要班级/作业~~ → 已确认：首期只做课件生成与管理，不做班级/作业

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| 前端 React 19 + Vite + TS | 与参考项目一致，降低维护成本 |
| 后端 Express + Node | 与参考项目一致，复用 auth/db 模式 |
| Worker 采用 Node 调度 + Python 子进程 | edulab kernel 是 Python/sympy，Node 负责任务队列和进度回写 |
| DB 双模式（内存 JSON + MySQL） | 与参考项目一致，开发零依赖，生产用 MySQL |
| 三技能通过 npm 依赖引入 | `npm i @wy51ai/edulab`，skills 文件位于 node_modules/@wy51ai/edulab/skills/，Python 按该路径调用 |
| 课件以自包含 HTML 存储 | edulab 原生输出即单文件 HTML，直接托管/iframe 预览 |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
|       | 1       |            |

## Notes
- edulab 三大技能的输出都是自包含 HTML（Three.js/MathJax/KaTeX 内联或 CDN），可直接作为静态资源托管
- 立体几何：3 种已注册题型（cube/box/random），覆盖线面角、体积等
- 解析几何：6 种已注册题型（ellipse_dot_range, ellipse_chord_range, ellipse_area_max, ellipse_slopeprod_const, parabola_dot_const, hyperbola_ecc_range）
- 化学反应：6 种已注册反应（combustion_ch4, combustion_h2, electrolysis_water, redox_na_cl2, esterification, glucose_combustion）
- 每个 generate.py 都支持 list / all / random / <key> [output] 命令
- 模板通过 `__LESSON_DATA__` 占位符注入 JSON 数据
