# Progress Log

## Session: 2026-08-05 — 真实 sub2api 联调（grok-4.5）

### 配置
- Base: `https://sub2api.duckcloud.fun/v1`
- Model: `grok-4.5`
- 写入本地 `.env`（已在 `.gitignore`）

### 结果
1. `/models` 健康检查：OK（16 models）
2. 简单 chat：OK，`finishReason=stop`，返回 `OK`
3. 已知反应快路径「电解水」：OK，HTML ~48KB
4. LLM 动态路径 `C + O2 -> CO2`：
   - 初版 atom_map 常不合法
   - 已增强 prompt 示例 + normalize 自动补常见 atom_map
   - 复测：1 次校验通过并渲染 HTML **47129 bytes**，route=`llm_spec`

### 代码小改进
- `server/services/ai/chem/prompts.js`：补充 atom_map 示例与 slot 约定
- `server/services/ai/chem/llmSpec.js`：清理非法 map + 常见反应 map 合成

### 风险提示
- API Key 曾在对话中明文提供，建议轮换
- grok-4.5 reasoning token 较多，建议 timeout ≥ 180–300s


## Session: 2026-08-05 — E2E 收口 + M2 分子全自动扩展

### E2E（LLM 路径）
- 根因：`grok-4.5` 在当前 sub2api 账号不可用 → HTTP 404 / UPSTREAM_HTTP
- 可用模型：`deepseek-v4-flash`、`deepseek-v4-flash-free`（`/v1/models` 仅 2 个）
- 切换 `SUB2API_MODEL=deepseek-v4-flash` 后：
  - 已知路径电解水：已成功（此前）
  - LLM 路径 `C + O2 -> CO2`：成功，`route=llm_spec`，HTML ~47KB，lesson `les_msg1a6ti_76f743`

### M2 实现
- `server/services/ai/chem/moleculeStore.js`：JSON 扩展库读写 + 静态校验
- `server/services/ai/chem/moleculeExtender.js`：缺 species → LLM 生成分子 → selfcheck → 持久化
- `chem_spec_tool.py`：`--extensions` 注入 + `selfcheck-molecule`
- `validateRender.js` / `pipeline.js`：校验渲染走扩展库；pipeline 标记 `m2_chem`
- 存储：`MOLECULE_EXTENSIONS_FILE`（默认 `server/data/molecule-extensions.json`）
- 测试：`server/tests/ai_m2_molecule.test.js`（4）+ m1 回归 5 全绿

### M2 联调
- 直接 ensureSpecies：`S`/`SO2` 扩展并渲染 HTML ~46KB
- 全链路 job `S + O2 -> SO2`：
  - job `job_msg1ltxn_2703d6` succeeded
  - lesson `les_msg1mr43_2ec2f3`，HTML 47316 bytes
  - `ai_meta.moleculeExtended=["S","SO2"]`，route=`llm_spec`

### 配置
- e2e env：`/tmp/edulab-e2e.env` model=deepseek-v4-flash
- 本地 `.env` 同步 deepseek
- 建议轮换已暴露的 API Key


## Session: 2026-08-05 — M3 解析几何

### 实现
- `server/services/ai/analytic/*`：knownProblems / prompts / llmSpec / validateRender / pipeline
- `server/services/ai/python/analytic_spec_tool.py`：validate + render(board.html)
- worker：chem | analytic 路由；空 skillHint 时关键词意图推断
- 测试：`server/tests/ai_m3_analytic.test.js`（5）

### E2E
- 已知路径「椭圆数量积取值范围」→ `ellipse_dot_range`，lesson `les_msg2b88j_e26caa`，HTML ~53KB
- LLM 路径弦中点轨迹：
  - attempt1：HTTP 524（UPSTREAM_5XX）
  - attempt2：校验通过并渲染，lesson `les_msg2itum_0a1df3`，`route=llm_spec`，pipeline=`m3_analytic`
  - 注意 deepseek reasoning tokens 很高（~9k），超时建议 180–300s

### 下一里程碑
- M4 图片入口（识别确认后生成）
- 或 M4b 立体几何

## Session: 2026-08-05 — M4 图片入口

### 实现
- `server/services/ai/image/recognize.js`：visionCompletions + 识别 + 落盘
- `server/index.js`：/api/ai/image-drafts 支持 base64 / url + 真实识图
- `db.js`：patch 支持 assetPath / rawRecognition
- 确认路由：buildConfirmSourceText + 配额 + 落盘 + 出课

### E2E
- 已知路径：电解水、解析几何
- LLM 路径：解析几何、化学反应
- M4 图片端到端已通

### 下一
M5 晋升正式题型 + 端到端图片确认生成
