# Toonflow 漫剧生成 · AI 架构文档

> 本文档帮助你理解 Toonflow 把「一本小说」变成「一部漫剧」的完整 AI 设计：
> 它用了哪几类 Agent、它们怎么分工协作、以及**在生成漫剧的每一个步骤里，模型到底看到了哪些上下文信息**。
> 同时和业界主流多 Agent 方案做了对比，帮助你定位 Toonflow 的设计取舍。
>
> 文中所有结论均来自源码（`src/agents/`、`src/utils/agent/`、`src/utils/ai.ts`、`src/socket/`、`data/skills/`）。

---

## 0. 一句话总览

Toonflow 是一个**分层编排式（Orchestrator-Workers）多 Agent 系统**：

```
小说 ──▶ 剧本 Agent（scriptAgent）──▶ 制作 Agent（productionAgent）──▶ 图片/视频
        三层：决策 / 监督 / 执行          三层：决策 / 监督 / 执行
```

两大 Agent 各自是一棵「决策层 → 监督层 → 执行子 Agent」的树。决策层是唯一与用户对话的入口，它通过**工具调用（tool call）**把任务派发给执行子 Agent，再用监督层做质检。所有「专业知识」不写在代码里，而是写在 `data/skills/` 的 Markdown 技能文件里，**改技能文件即时生效，无需重新编译**。

---

## 1. 核心设计理念（4 条主线）

| 设计理念 | 在 Toonflow 里的体现 | 代码位置 |
|---|---|---|
| **分层编排** | 决策层只做"调度+质控"，绝不亲自写剧本/分镜；真正干活的是执行子 Agent | `scriptAgent/index.ts:runDecisionAI`、`createSubAgent` |
| **技能即提示词（Prompt-as-File）** | 每个 Agent 的 system prompt 是一个 `.md` 文件，运行时读取 | `data/skills/*.md`，`fs.readFile(skill)` |
| **工作区 + 记忆双通道** | 结构化产物（骨架/剧本/分镜）存「工作区」；对话语境存「三层记忆」 | `o_agentWorkData` / `src/utils/agent/memory.ts` |
| **供应商无关** | `u.Ai.Text/Image/Video` 屏蔽了 OpenAI/Anthropic/DeepSeek… 差异，模型从 DB 配置解析 | `src/utils/ai.ts` |

---

## 2. 两大 Agent、三层结构

### 2.1 通用的三层结构

每个 Agent 内部都是同一套三层骨架：

```
┌─────────────────────────────────────────────────────┐
│  决策层 Decision（唯一面向用户）                       │
│  · 理解意图、校验参数、规划流水线                       │
│  · 通过 tool call 派发给执行层 / 监督层                 │
│  · 模型 key: scriptAgent:decisionAgent                 │
└───────────────┬─────────────────────┬─────────────────┘
                │ run_sub_agent_*      │ run_supervision_agent
                ▼                      ▼
┌───────────────────────────┐  ┌────────────────────────┐
│  执行层 Execution（干活）   │  │  监督层 Supervision     │
│  · 一个子 Agent 干一件事    │  │  · 按 N 个维度质检       │
│  · 读一次工作区→产出→返回   │  │  · 打分 A/B/C/D + 整改建议│
└───────────────────────────┘  └────────────────────────┘
```

> 关键点：执行子 Agent 是**近似无状态**的——它读一次工作区数据、产出结果、返回，不跨阶段持有状态。阶段之间的状态全部落在「工作区」(`o_agentWorkData`) 里。这正是业界"无状态 worker + 共享黑板"的经典做法。

### 2.2 剧本 Agent（scriptAgent）的执行子 Agent

| 阶段 | 子 Agent / 工具 | 技能文件 | 产物（写入工作区 key） |
|---|---|---|---|
| ① 故事骨架 | `run_sub_agent_storySkeleton` | `script_execution_skeleton.md` | `<storySkeleton>`（故事核/隐线/人物小传/三幕结构/分集决策表/付费卡点） |
| ② 改编策略 | `run_sub_agent_adaptationStrategy` | `script_execution_adaptation.md` | `<adaptationStrategy>`（3-5 条改编原则/删减决策/世界观呈现） |
| ③ 剧本写作 | `run_sub_agent_script`（**逐集循环**） | `script_execution_script.md` | `<scriptItem>` 每集一条，同步写入 `o_script` |
| 质检 | `run_supervision_agent` | `script_agent_supervision.md` | 评分报告 A/B/C/D |

### 2.3 制作 Agent（productionAgent）的执行子 Agent

源码顺序见 `productionAgent/index.ts:366-374`，实际流水线串行执行：

| 阶段 | 子 Agent / 工具 | 技能文件 | 产物 |
|---|---|---|---|
| ① 导演规划 | `run_sub_agent_director_plan` | `production_execution_director_plan.md` | `<scriptPlan>` 分场表 + 转场 |
| ② 衍生资产分析 | `run_sub_agent_derive_assets` | `production_execution_derive_assets.md` | 通过 `add_deriveAsset` 写入资产衍生（角色变身/场景时段变体等） |
| ③ 衍生资产生成 | `run_sub_agent_generate_assets` | `production_execution_generate_assets.md` | **异步触发** `generate_assets_images({ids})` |
| ④ 分镜表 | `run_sub_agent_storyboard_table` | `production_execution_storyboard_table.md` | `<storyboardTable>` 镜头/时长/资产引用表 |
| ⑤ 分镜面板 | `run_sub_agent_storyboard_panel` | `production_execution_storyboard_panel.md` | `<storyboardItem>` 逐行，含 `prompt/duration/associateAssetsIds` |
| ⑥ 分镜图生成 | `run_sub_agent_storyboard_gen` | `production_execution_storyboard_gen.md` | **异步触发** `generate_storyboard_images({ids})` |
| 质检 | `run_sub_agent_supervision` | `production_agent_supervision.md` | 评分报告 |

> ⑤ 分镜面板有**两种模式**，由 `isRef`（视频模型是否"多参考"）决定：
> - **模式 A（纯文本多参）**：不生成 prompt，`videoDesc` 拼接原始分镜行，`shouldGenerateImage=false`，按"分组"写。
> - **模式 C（首帧模式）**：逐行生成 prompt + 参考图，`shouldGenerateImage=true`，按"镜头行"写。

---

## 3. ⭐ 每一步用到哪些上下文信息（本文重点）

这一节按生成漫剧的真实顺序，逐步拆解**模型在那一刻看到的全部上下文**。

每个 Agent 的请求消息结构是固定的三段式（见 `index.ts:71-76`）：

```js
messages: [
  { role: "system",    content: <技能 Markdown 文件> },        // 我是谁、我怎么干
  { role: "assistant", content: <项目配置> + <记忆> + <模型信息> }, // 我现在面对的项目语境
  { role: "user",      content: <决策层下发的任务指令，≤100字> }, // 我这次要干什么
]
// + tools: { 记忆工具, 取数工具, 子Agent工具 }
```

下面逐步标注「这三段 + 工具」里各自装了什么。

---

### 步骤 0｜用户发话 → 决策层（scriptAgent:decisionAgent）

模型在这一刻看到的上下文：

| 上下文 | 内容 | 来源 |
|---|---|---|
| **system** | `script_agent_decision.md`（决策层职责、流水线规则、派发格式） | `data/skills/` |
| **项目配置** | 小说名/类型、集数、单集时长（≈台词字数）、原著章节范围、平台规格、风格、付费策略 | `o_project` + `o_novel` 查询（`index.ts:51-53`） |
| **记忆** | `[相关记忆]`(RAG Top3) + `[历史摘要]`(Top10) + `[近期对话]`(Top5) | `Memory("scriptAgent").get(text)` |
| **user** | 用户原话，如"帮我写故事骨架" | Socket `chat` 事件 |
| **可用工具** | `deepRetrieve`(深检索记忆)、`get_novel_events`、`get_novel_text`、`get_planData`、`get_script_content`、`run_sub_agent_*`、`run_supervision_agent` | `memory.getTools()` + `useTools()` + `createSubAgent()` |

决策层**自己不写内容**，它判断该进哪个阶段，然后调用对应的 `run_sub_agent_*` 工具。

---

### 步骤 1｜故事骨架（scriptAgent:storySkeletonAgent）

| 上下文 | 内容 | 来源 |
|---|---|---|
| **system** | `script_execution_skeleton.md` **+ 强制输出格式** `<storySkeleton>…</storySkeleton>` | 技能文件 + 代码拼接 |
| **user** | 决策层下发的任务（≤100字，如"基于第1-20章生成20集骨架"） | 决策层 tool call |
| **按需取数（工具）** | `get_novel_events(chapterIndexs[])` → 返回"第N章，标题，事件"表；项目配置（集数/时长）用于约束总时长 | `o_novel` 的 `event` 字段 |
| **产物** | 故事核、隐线、人物小传、三幕结构、分集决策表、删减决策、付费卡点、股价级反转登记表 |  |

> 注意：骨架阶段喂的是**事件表（event）**而非全文，是一种成本/聚焦优化——让模型在"压缩后的剧情骨干"上做结构设计。

---

### 步骤 2｜改编策略（scriptAgent:adaptationStrategyAgent）

| 上下文 | 内容 | 来源 |
|---|---|---|
| **system** | `script_execution_adaptation.md` + 格式 `<adaptationStrategy>` | 技能文件 |
| **user** | 决策层任务指令 | 决策层 |
| **按需取数** | `get_planData` → 读回**步骤1的故事骨架**；`get_novel_events` → 事件表 | 工作区 `o_agentWorkData` |
| **产物** | 3-5 条核心改编原则、主要删除决策、世界观呈现策略 |  |

> 这一步首次出现"读上一步产物"的依赖：改编策略必须**对齐已确定的骨架**。

---

### 步骤 3｜剧本写作（scriptAgent:scriptAgent，逐集循环）

这是唯一**循环 N 次**的步骤（第1集…第N集），每次调用看到的上下文：

| 上下文 | 内容 | 来源 |
|---|---|---|
| **system** | `script_execution_script.md` + 格式 `<scriptItem name="…">` | 技能文件 |
| **user** | "写第 k 集剧本" | 决策层 |
| **按需取数** | `get_planData` → **骨架 + 改编策略**；`get_script_content` → **前几集已写剧本**（保证承接连贯）；必要时 `get_novel_text` → 原著正文 | 工作区 + `o_novel.chapterData` |
| **产物** | 单集剧本（剧情梗概 + 场景正文），写入 `o_script` |  |

> 逐集写作 + 回读前文，是为了控制单次上下文长度，同时保证"承接/勾连"。这是处理长内容的典型"分块 + 滚动上下文"策略。

每步产物经 `removeAllXmlTags()` 去掉 XML 后写入记忆（`onFinish`），既保证工作区拿到结构化数据，又让记忆里是干净文本。

---

### 步骤 4｜进入制作 Agent → 决策层（productionAgent:decisionAgent）

制作 Agent 的项目语境**多了"模型能力信息"**（`index.ts:67`）：

| 上下文 | 内容 | 来源 |
|---|---|---|
| **system** | `production_agent_decision.md` | 技能文件 |
| **assistant** | 记忆 + **模型信息**：`图像模型 / 视频模型 / 多参：是\|否` | `o_project.imageModel/videoModel/mode` |
| **可用工具** | `get_flowData`、`add_deriveAsset`、`add_flowData_storyboard`、6 个执行子 Agent + 监督 | `tools.ts` + `createSubAgent` |

> **"多参（isRef）"**这条信息很关键——它决定了下游分镜面板走模式 A 还是模式 C，进而决定要不要生成首帧图。

---

### 步骤 5｜导演规划（productionAgent:directorPlanAgent）

| 上下文 | 内容 | 来源 |
|---|---|---|
| **system** | `production_execution_director_plan.md` + 格式 `<scriptPlan>` | 技能文件 |
| **assistant** | **画风/叙事技能清单**（`artSkills.prompt`）+ 模型信息 | `createArtSkills(artStyle, directorManual)` |
| **按需取数** | `get_flowData("script")` → 剧本全文 | 工作区 |
| **动态技能** | 可调 `activate_skill` 加载该画风/题材的完整导演指令 | `data/skills/art_skills|story_skills/<风格>/driector_skills/*.md` |
| **产物** | `<scriptPlan>` 分场表 + 每场备注 + 转场 |  |

> ⭐ 制作阶段引入了**"动态技能注入"**：决策时只给 Agent 一份"技能清单（名字+描述）"，Agent 按需 `activate_skill` 把对应**画风（如 90 年代日漫）/题材（如 都市职场）**的完整指令加载进上下文。这等价于业界的"渐进式上下文加载（progressive disclosure）"，避免一次性灌爆上下文。

---

### 步骤 6｜衍生资产分析 → 生成

| 步骤 | system | 关键上下文 | 产物/动作 |
|---|---|---|---|
| ② 衍生分析 | `production_execution_derive_assets.md` | `get_flowData` 读剧本 + 既有资产；画风技能 | `add_deriveAsset` 写入"角色变身/场景时段变体"等衍生资产元数据 |
| ③ 衍生生成 | `production_execution_generate_assets.md` | 衍生资产 ID 列表 | **异步**调 `generate_assets_images({ids})` → 走 `u.Ai.Image` |

---

### 步骤 7｜分镜表 → 分镜面板 → 分镜图

| 步骤 | system | 关键上下文 | 产物 |
|---|---|---|---|
| ④ 分镜表 | `production_execution_storyboard_table.md` + 格式 `<storyboardTable>` | `get_flowData`：剧本 + 导演规划 + 资产库；**制作技能** `productionSkills` | 镜头/时长/资产引用表 |
| ⑤ 分镜面板 | `production_execution_storyboard_panel.md` + 格式 `<storyboardItem>` | 分镜表 + `多参` 标志（决定模式 A/C） | 逐行 `<storyboardItem>`，含 `prompt/duration/associateAssetsIds/shouldGenerateImage` |
| ⑥ 分镜图 | `production_execution_storyboard_gen.md` | 分镜面板数据 | **异步**调 `generate_storyboard_images({ids})` |

> 分镜表/面板用的是 `productionSkills`（`storyboard_*_techniques.md` + 画风/题材技能），而前面导演规划用的是 `artSkills`——两组技能集合不同，体现了"不同子任务挂载不同专业知识"。

---

### 步骤 8｜真正出图/出片（供应商层）

图片和视频不由"对话型 LLM"直出，而是经 `u.Ai.Image` / `u.Ai.Video` 调用配置好的图像/视频模型：

```js
// 图片：batchGenerateAssetsImage.ts / 分镜图
u.Ai.Image(project.imageModel).run({
  referenceList: [{ type:"image", base64 }],  // 参考图（角色/场景一致性）
  prompt, size: imageQuality, aspectRatio: "16:9",
})

// 视频：generateVideo.ts
u.Ai.Video(model).run({
  prompt, referenceList, mode,                // mode 决定首帧/首尾帧/纯文本/多参
  duration, aspectRatio, resolution, audio,
})
```

模型名 `vendorId:modelName` 由 `o_agentDeploy`（高级模式，逐 Agent 配模型）或 `o_vendorConfig`（简单模式，全用主模型）解析；供应商代码存在 DB 里、运行时在 VM 中执行 `imageRequest/videoRequest`（`ai.ts:113-140`），所以**换供应商不用改代码**。

---

## 4. 横切系统：让每步上下文得以成立的三大支柱

### 4.1 三层记忆（`src/utils/agent/memory.ts`）

每次 `memory.get(text)` 返回三层，拼成上面所有步骤里的 `[记忆]` 段：

| 层 | 内容 | 默认条数 | 机制 |
|---|---|---|---|
| **RAG（相关记忆）** | 与当前输入语义最相近的历史消息 | 3 | `all-MiniLM-L6-v2` 本地 ONNX 向量 + 余弦相似度 |
| **Summaries（历史摘要）** | 每 3 条消息滚动生成的 ≤500 字摘要 | 10 | LLM 摘要，存 `relatedMessageIds` 可回溯 |
| **Short-term（近期对话）** | 最近未被摘要的原文 | 5 | 直接取 DB |

还提供 `deepRetrieve(keyword)` 工具：向量搜摘要 → LLM 判相关性 → 经 `relatedMessageIds` 展开到原始消息，供 Agent 主动深挖。

### 4.2 工作区（`o_agentWorkData`）

阶段间共享的"黑板"。骨架/改编/剧本/导演规划/分镜表/分镜面板都按 key 存这里，下游用 `get_planData` / `get_flowData` 读回。剧本还会同步进 `o_script`。

### 4.3 实时流式（`src/socket/resTool.ts`）

所有 Agent 的输出通过 Socket.IO 实时推前端，`consumeFullStream` 把 Vercel AI SDK 的流分类型转发：

- `reasoning-*` → `thinking` 思考气泡（自动计时"思考完毕 X 秒"）
- `text-delta` → 正文增量 `append`
- `toolcall` → 工具调用过程与结果
- `<think>…</think>` 标签会被 `AutoThinkingTextStream` 自动抽出单独渲染

---

## 5. 与业界多 Agent 方案的对比

| 维度 | Toonflow | 业界主流参照 |
|---|---|---|
| **拓扑** | 决策层(Orchestrator) → 执行 Workers + 监督 Critic，**两棵树串联** | Anthropic 的 *Orchestrator-Workers*；OpenAI Swarm 的 handoff；CrewAI 的 role-based crew |
| **通信** | 不靠 Agent 间自由对话，而靠 **tool call 派发 + 工作区共享** | 与 Anthropic「用工具而非消息传递做编排」的建议一致；区别于 AutoGen 的多 Agent 群聊 |
| **质量门** | 独立 **监督层**打分 A/B/C/D + 整改建议，但**用户决策是否整改** | 经典 *Generator-Critic / Reflexion* 模式；Toonflow 保留 human-in-the-loop |
| **知识载体** | 专业 know-how 在 **Markdown 技能文件**，热更新；动态 `activate_skill` 渐进加载 | 类似 Claude 的 *Skills / progressive disclosure*、RAG-as-prompt；区别于把 prompt 硬编码 |
| **记忆** | 三层（RAG + 摘要 + 短期）自建，本地 ONNX 嵌入 | 对标 MemGPT/LangChain memory；本地嵌入降低成本与依赖 |
| **状态管理** | 执行 Agent 近无状态，状态落「工作区」黑板 | 经典 *blackboard architecture*，利于断点续跑 |
| **模型路由** | `vendorId:modelName` 运行时解析，逐 Agent 可配不同模型 | 对标 LiteLLM/OpenRouter 式 model routing |

**Toonflow 的取舍亮点：**
1. **领域工作流即 Agent**——把"爆款短剧方法论"沉淀进技能文件，让通用 LLM 跑专业流水线，运营/编剧改 `.md` 即可调优，无需改代码。
2. **串行 + 质量门 + 人类确认**——相比"全自动多 Agent 放飞"，更适合内容生产这种对质量敏感、需要人把关的场景。
3. **结构化产物用 XML 包裹**——`<storySkeleton>`/`<scriptItem>`/`<storyboardItem>` 便于可靠解析落库，避免自由文本解析的脆弱性。

**潜在权衡（理解架构时值得注意）：**
- 串行流水线**延迟较高**（骨架→改编→逐集剧本→导演→资产→分镜→出图），换来的是可控与可干预。
- 执行子 Agent 无状态、每步重新 `get_*` 读工作区，**有重复读取成本**，但换来清晰的阶段边界与可续跑性。
- 监督层只"提建议不强改"，最终质量仍依赖用户判断。

---

## 6. 端到端时序图

```
用户 ──chat──▶ scriptAgent 决策层
                  │  (system=决策技能 / assistant=项目配置+记忆 / user=用户话)
                  ├─▶ ① 故事骨架   ← get_novel_events            ─┐
                  ├─▶ ② 改编策略   ← get_planData(骨架)+事件      │ 工作区
                  ├─▶ ③ 逐集剧本   ← 骨架+策略+前文剧本(+原著正文)│ o_agentWorkData
                  └─▶ 监督层 质检 A/B/C/D → 用户确认             ─┘ + o_script
                            │
用户切到制作 ──chat──▶ productionAgent 决策层 (assistant 多了"模型信息/多参")
                  ├─▶ ① 导演规划   ← get_flowData(剧本) + artSkills
                  ├─▶ ② 衍生分析   ← 剧本+资产 → add_deriveAsset
                  ├─▶ ③ 衍生生成   → generate_assets_images (异步, u.Ai.Image)
                  ├─▶ ④ 分镜表     ← 剧本+导演规划+资产 + productionSkills
                  ├─▶ ⑤ 分镜面板   ← 分镜表 + 多参标志(模式A/C)
                  ├─▶ ⑥ 分镜图     → generate_storyboard_images (异步, u.Ai.Image)
                  └─▶ 监督层 质检
                            │
                            ▼
                   u.Ai.Video(...) 合成视频 ──▶ 漫剧成片
```

---

## 7. 一图看懂"每步上下文来源"

| 步骤 | system(我是谁) | 项目语境(assistant) | 任务(user) | 按需取数(工具) | 上一步依赖 |
|---|---|---|---|---|---|
| 决策(剧本) | 决策技能 | 项目配置+记忆 | 用户话 | 全部工具 | — |
| 故事骨架 | 骨架技能+格式 | — | 决策派发 | 事件表 | — |
| 改编策略 | 改编技能+格式 | — | 决策派发 | 骨架+事件表 | 骨架 |
| 逐集剧本 | 剧本技能+格式 | — | "写第k集" | 骨架+策略+前文剧本+原著 | 骨架/策略/前集 |
| 决策(制作) | 决策技能 | 记忆+**模型信息/多参** | 用户话 | flowData/资产工具 | 剧本 |
| 导演规划 | 导演技能+格式 | **artSkills**+模型信息 | 决策派发 | 剧本 | 剧本 |
| 衍生分析 | 衍生技能 | artSkills+模型信息 | 决策派发 | 剧本+资产 | 剧本 |
| 分镜表 | 分镜表技能+格式 | **productionSkills**+模型信息 | 决策派发 | 剧本+导演规划+资产 | 导演规划 |
| 分镜面板 | 面板技能+格式 | productionSkills+模型信息 | 决策派发 | 分镜表+多参标志 | 分镜表 |

---

## 附录：关键源码索引

| 关注点 | 路径 |
|---|---|
| 剧本 Agent 决策层/子 Agent 工厂 | `src/agents/scriptAgent/index.ts` |
| 剧本 Agent 取数工具 | `src/agents/scriptAgent/tools.ts` |
| 制作 Agent 决策层/子 Agent 工厂 | `src/agents/productionAgent/index.ts` |
| 制作 Agent 取数/写入工具 | `src/agents/productionAgent/tools.ts` |
| 三层记忆 | `src/utils/agent/memory.ts` |
| 本地嵌入 | `src/utils/agent/embedding.ts` |
| 技能加载 / activate_skill | `src/utils/agent/skillsTools.ts` |
| 模型抽象 Text/Image/Video | `src/utils/ai.ts` |
| 流式推送 ResTool | `src/socket/resTool.ts` |
| Socket 入口 / 鉴权 | `src/socket/routes/{scriptAgent,productionAgent}.ts` |
| 技能提示词 | `data/skills/*.md`、`data/skills/{art_skills,story_skills}/<风格>/` |
