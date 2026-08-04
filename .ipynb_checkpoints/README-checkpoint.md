# EduLab 交互教学课件平台

基于 [wy51ai/edulab](https://github.com/wy51ai/edulab) 的 Web 管理系统，将立体几何、解析几何、化学反应三大交互教学技能封装为在线平台。

## 功能

- **课件生成**：选择学科和题型，一键生成自包含交互教学网页
- **任务中心**：实时查看生成进度，支持排队/运行/完成/失败状态
- **课件广场**：浏览公开课件，iframe 内嵌预览
- **我的课件**：管理个人课件，公开/私有、发布/草稿
- **管理后台**：用户管理、数据统计、课件审核
- **三大学科**：
  - 立体几何（Three.js 3D + MathJax）：正方体线面角、长方体体积、随机出题
  - 解析几何（Canvas 2D + KaTeX）：椭圆数量积/弦长/面积/斜率积、抛物线定值、双曲线离心率
  - 化学反应（Three.js 3D + KaTeX）：甲烷/氢气/葡萄糖燃烧、电解水、氧化还原、酯化

## 技术栈

- 前端：React 19 + Vite 6 + TypeScript
- 后端：Express 4 + Node.js
- Worker：Node 调度 + Python/sympy 子进程
- 数据库：MySQL 8（生产）/ 内存 JSON（开发，零依赖）
- 部署：Docker + docker-compose

## 快速开始

### 前置依赖

- Node.js 18+
- Python 3 + sympy（`pip3 install sympy`）

### 开发模式

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

演示账号：`admin@edulab.local` / `admin123`

### 生产构建

```bash
npm run build
NODE_ENV=production node server/index.js
```

### Docker 部署

```bash
docker compose up -d --build
```

服务启动在 http://localhost:3002 （API + 静态前端），MySQL 数据持久化到 Docker volume。

## 环境变量

复制 `.env.example` 为 `.env`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3002` | API 端口 |
| `USE_MYSQL` | `false` | `true` 使用 MySQL，否则内存 JSON |
| `MYSQL_HOST` | `localhost` | MySQL 主机 |
| `PYTHON_BIN` | `python3` | Python 解释器路径 |
| `WORKER_CONCURRENCY` | `1` | Worker 并发数 |
| `LESSON_ARTIFACTS_ROOT` | `./server/uploads/lessons` | 课件 HTML 输出目录 |

## 项目结构

```
ai-teaching-edulab/
├── server/
│   ├── index.js              # Express API（auth/jobs/lessons/admin）
│   ├── db.js                 # 数据层（MySQL + 内存双模式）
│   ├── loadEnv.js
│   ├── services/
│   │   ├── rbac.js           # 角色权限
│   │   ├── skillCatalog.js   # 技能/题型目录
│   │   └── skillRunner.js    # Python 子进程封装
│   └── workers/
│       └── lessonWorker.js   # 任务调度 Worker
├── App.tsx                   # 前端主应用
├── types.ts                  # TypeScript 类型
├── styles.css
├── skills -> node_modules/@wy51ai/edulab/skills/
├── Dockerfile
└── docker-compose.yml
```

## API 概览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/me` | 当前用户 |
| GET | `/api/catalog/skills` | 学科与题型目录 |
| POST | `/api/jobs` | 创建生成任务 |
| GET | `/api/jobs` | 任务列表 |
| GET | `/api/jobs/:id` | 任务详情 |
| POST | `/api/jobs/:id/cancel` | 取消任务 |
| GET | `/api/lessons` | 课件列表 |
| GET | `/api/lessons/:id` | 课件详情 |
| PATCH | `/api/lessons/:id` | 更新课件 |
| DELETE | `/api/lessons/:id` | 删除课件 |
| GET | `/lessons/:id/view` | 课件 HTML 预览 |
| GET | `/api/admin/stats` | 管理统计 |
| GET | `/api/admin/users` | 用户管理 |
| PATCH | `/api/admin/users/:id` | 修改用户角色/状态 |
| POST | `/api/admin/lessons/:id/review` | 审核课件 |

## License

Apache-2.0（edulab 核心技能）
