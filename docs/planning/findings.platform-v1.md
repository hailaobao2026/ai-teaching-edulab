# Findings & Decisions

## Requirements

### 核心需求
- 将 wy51ai/edulab 的三大教学技能封装为 Web 管理系统
- 框架参考 ai-teaching-video-platform 的全栈架构
- 用户可通过浏览器提交生成任务、预览交互课件、管理课件库
- 完整的用户权限、任务队列、管理后台

### 功能范围（历史需求基线；AI M0–M4 已在当前代码落地）
- 立体几何（edu-solid-geometry）：正方体线面角、长方体体积、随机出题
- 解析几何（edu-analytic-geometry）：椭圆数量积范围、弦长范围、面积最值、斜率积定值、抛物线焦点弦定值、双曲线离心率范围
- 化学反应（edu-chem-reaction）：甲烷燃烧、氢气燃烧、电解水、钠氯氧化还原、酯化反应、葡萄糖燃烧
- 三入口：选择已注册题型、文字/方程 AI 生成、图片识别草稿确认后生成；立体几何 AI（M4b）仍待实现

## Research Findings

### edulab 项目结构
- 性质：Claude Code 插件 / npm 包 `@wy51ai/edulab`
- 三大技能各自独立，结构统一：
  - `SKILL.md`：技能说明
  - `lib/`：sympy 计算核心（kernel + 库）
  - `scripts/generate.py`：CLI 生成器，REGISTRY 注册表
  - `template/*.html`：数据驱动模板，含 `__LESSON_DATA__` 占位符
  - `references/`：problem-schema.md、conventions.md
- 输出：自包含单页 HTML，可直接浏览器打开
- 依赖：python3 + sympy

### edulab 技能 1：edu-solid-geometry
- 渲染：Three.js 3D + MathJax
- 已注册题型：cube（正方体线面角）、box（长方体体积）、random（随机种子）
- 几何体库：bodies.py 提供 cuboid/cube/quad_pyramid/tri_pyramid/prism 拓扑
- 计算核心：geometry_kernel.py 提供 solve_cube_line_plane_angle 等
- CLI: `python3 generate.py cube|box|random <seed> [output.html]`
- 数据结构：lesson（元信息+答案）、steps（分步解析+高亮+镜头）、model（points/spheres/edges/elements）

### edulab 技能 2：edu-analytic-geometry
- 渲染：2D Canvas + KaTeX
- 已注册题型（6种）：
  - ellipse_dot_range：椭圆 MA·MB 数量积范围
  - ellipse_chord_range：椭圆弦长范围
  - ellipse_area_max：椭圆三角形面积最值
  - ellipse_slopeprod_const：椭圆斜率积定值
  - parabola_dot_const：抛物线焦点弦 OA·OB 定值
  - hyperbola_ecc_range：双曲线离心率范围
- 计算核心：analytic_kernel.py（联立+韦达+range/const 判定）
- conics.py：椭圆/双曲线/抛物线/圆定义
- CLI: `python3 generate.py list|all|<type> [output]`
- 交互引擎：参数滑块驱动实时重算，理论范围条/定值指示

### edulab 技能 3：edu-chem-reaction
- 渲染：Three.js 3D 分子动画 + KaTeX
- 已注册反应（6种）：
  - combustion_ch4：甲烷燃烧
  - combustion_h2：氢气燃烧
  - electrolysis_water：电解水
  - redox_na_cl2：钠氯氧化还原
  - esterification：酯化反应（机理·催化剂）
  - glucose_combustion：葡萄糖燃烧
- 计算核心：reaction_kernel.py（配平+原子守恒+键断裂/生成+组装）
- molecules.py：VSEPR 分子几何库
- 双引擎：morph（原子变形，展示守恒）、mechanism（机理关键帧）
- CLI: `python3 generate.py list|random <seed>|all|<type> [output]`

### 参考项目 ai-teaching-video-platform 架构
- 前端：React 19 + Vite 6 + TypeScript（单页应用，view 切换）
- 后端：Express 4 + Node.js（REST JSON API）
- Worker：独立 Node 进程，处理重 CPU 任务
- 数据库：MySQL 8 或内存 JSON（双模式，USE_MYSQL 环境变量切换）
- 认证：scrypt 密码哈希 + Bearer Token 会话
- RBAC：student / teacher / admin
- 部署：Docker + docker-compose

### 参考项目数据模型（表）
- users：用户（id, email, nickname, password_hash, role, status, teacher_subjects, grade）
- sessions：会话（token, user_id, created_at）
- generation_jobs：生成任务（id, status, progress, current_stage, topic, output_profile, error_message, ...）
- courses：课程（id, title, topic, subject, grade, chapter, summary, publish_status, visibility, ...）
- course_assets：课程资源（id, job_id, course_id, asset_type, path, mime_type, size_bytes）
- course_reviews：审核记录（id, course_id, reviewer_id, status, comment, ...）
- subjects / knowledge_points：学科与知识点目录
- system_config：系统配置
- user_model_settings：用户级模型偏好
- rural_pilot_evidence_records：乡村试点记录

### 参考项目 API 模块
- auth：POST /register, /login, /logout, GET /me, PATCH /me/profile
- jobs：POST /, GET /, GET /:id, POST /:id/retry, /cancel, GET /:id/assets
- courses：GET /, GET /:id, POST /, PATCH /:id, DELETE /:id, POST /:id/submit
- teacher/reviews：GET pending/done, POST /courses/:id/review
- catalog：GET subjects/grades/categories/knowledge-points
- admin：users, subjects, knowledge-points, stats, config, jobs, courses
- assistant：POST /chat
- rural-pilots：CRUD + summary + submit + verify
- model-settings：GET/PUT/reset /me/model-settings

### 参考项目关键工程模式
- async handler 自动包装（Express 4 不捕获 async rejection）
- auth/requireRole 中间件
- memory DB 持久化到 JSON 文件（原子写：tmp + rename）
- generateId(prefix) 生成唯一 ID
- Worker 轮询 queued job，抢占式执行
- 前端 AppView 联合类型 + setView 切换
- Vite proxy 转发 /api /uploads /health 到后端

## Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 前端 React 19 + Vite + TS | 与参考项目一致 |
| 后端 Express + Node.js | 与参考项目一致，复用 auth/db/async 包装模式 |
| Worker: Node 调度 + Python child_process | kernel 是 Python/sympy，Node 负责任务队列和进度 |
| DB 双模式（内存 JSON + MySQL） | 开发零依赖，生产可切换 |
| 三技能通过 npm 依赖引入 | `npm i @wy51ai/edulab`，Python 解析 node_modules 路径调用 |
| 课件存储为自包含 HTML | edulab 原生输出，直接托管 + iframe 预览 |
| 不做班级/作业/协作 | 首期只做课件生成与管理（用户已确认） |
| AI 动态路径 | 文本/方程走 sub2api + Spec 校验；图片走识别草稿确认门闩；立体几何图片生成仍保留 M4b 限制 |
| 课件表名 lessons（非 courses） | 与视频课程区分，语义更准确 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| heredoc 写入大文件时 JSON 解析失败 | 改用 Python 或 apply_patch 写入 |

## Resources
- edulab GitHub: https://github.com/wy51ai/edulab
- 参考项目: /mnt/f/work/code/github/hailaobao2026/ai-teaching-video-platform
- edulab npm 包: @wy51ai/edulab (skills 位于 node_modules/@wy51ai/edulab/skills/)
- edulab 本地克隆（参考）: /tmp/edulab
- edulab 三大技能 CLI:
  - `python3 skills/edu-solid-geometry/scripts/generate.py cube [out.html]`
  - `python3 skills/edu-analytic-geometry/scripts/generate.py ellipse_dot_range [out.html]`
  - `python3 skills/edu-chem-reaction/scripts/generate.py combustion_ch4 [out.html]`

## Visual/Browser Findings
- edulab demo GIF 展示了三种技能的交互效果：
  - 立体几何：3D 可旋转模型，分步高亮线/面/法向量，镜头切换
  - 解析几何：2D Canvas 圆锥曲线，滑块驱动参数变化，实时数值读数
  - 化学反应：3D 分子动画，滑块看断键/成键/原子重组
