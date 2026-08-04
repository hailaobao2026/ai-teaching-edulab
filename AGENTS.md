# AGENTS.md

本项目是 EduLab 交互教学课件 Web 管理系统。

- 生成核心：npm 依赖 `@wy51ai/edulab`（Python/sympy 技能位于 `node_modules/@wy51ai/edulab/skills/`）
- 参考架构：`../ai-teaching-video-platform`
- 默认不要把 API Key 写入仓库
- Worker 是重 CPU 任务（sympy 计算 + HTML 渲染），开发时单独进程运行
- Python 依赖：python3 + sympy（`python3 -m pip install sympy`）

关键路径：
- `server/services/skillRunner.js`（Python 子进程封装）
- `server/workers/lessonWorker.js`（任务调度）
- `server/db.js`（数据层）
