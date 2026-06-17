# Toonflow 漫剧生成 · 进阶使用手册（深度调优指南）

> 这份手册是 [`comic-generation-architecture.md`](./comic-generation-architecture.md) 的实操篇。
> 架构篇讲"系统怎么设计的";本篇讲"**你怎么用好它、怎么调优,才能生成更好的短剧**"。
>
> 全文围绕你最关心的几个问题展开:
> - 创建项目时有哪些字段?哪些会真正影响 AI?(小说类型/简介/视觉手册/导演手册…)
> - **视觉手册、导演手册**到底怎么影响产出?要改哪个文件?
> - 剧本 Agent 用到哪些信息?
> - Chat 里的"重新连接 / 清空消息记忆 / 清空摘要记忆 / 清空全部记忆"分别干啥、何时用?
> - 角色塑造的"Prompt 重新生成"依赖什么?怎么改才能让 prompt 更合理?
> - 后续(分镜、视频、配音、合成)每一步还涉及哪些点?
>
> 所有结论均来自源码核对,关键处给了文件路径,方便你定位修改。

---

## 0. 先理解:你有两条"调优通道"

调优 Toonflow 本质上只有两个着力点,搞清楚它们的分工是用好这个软件的前提:

| 通道 | 是什么 | 改了影响谁 | 生效方式 |
|---|---|---|---|
| **① 项目字段** | 创建项目时填的结构化信息(小说名/类型/简介/视觉手册/导演手册/模型…) | 决定喂给 AI 的"项目语境" + 决定加载哪套技能 | 改项目设置即时生效 |
| **② 技能文件(.md)** | `data/skills/` 下的提示词文件(视觉手册、导演手册、各 Agent 的 system prompt、画风模板) | 决定 AI"怎么想、怎么写、怎么画" | **改文件即时生效,无需重启/编译** |

> 🔑 核心心智模型:**项目字段是"选择题"(选哪套手册/模型),技能文件是"标准答案"(手册里写了什么)**。
> 想微调风格/质量,大多数时候应该改的是 ② 技能文件,而不是反复重试。

---

## 1. 创建项目:字段全表 & 每个字段流向哪个 AI

项目数据存在 `o_project` 表,创建入口 `src/routes/project/addProject.ts`。用户可填 11 个字段:

| 字段 | 含义 | 是否传给**剧本 Agent** | 是否影响**制作 Agent** |
|---|---|---|---|
| `name` | 小说名称 | ✅ 直接写进 prompt | — |
| `type` | **小说类型**(如悬疑/言情) | ✅ **会影响**故事骨架与改编 | ❌ 不直接传 |
| `intro` | **小说简介** | ✅ **会影响**(作为剧情先验) | ❌ 不直接传 |
| `artStyle` | **视觉手册 / 画风** | ✅ 作为"目标视觉风格"传入 | ✅ **决定加载哪套画风技能** |
| `directorManual` | **导演手册 / 故事手册** | ❌ **不传给剧本 Agent** | ✅ **决定加载哪套叙事技能** |
| `videoRatio` | 视频画幅(16:9 / 9:16) | ✅ 传入 | ✅ 影响出图/出片画幅 |
| `imageModel` | 图像模型 `vendorId:model` | ❌ | ✅ 出图用 |
| `videoModel` | 视频模型 `vendorId:model` | ❌ | ✅ 出片用;其能力决定"多参"模式 |
| `imageQuality` | 图像质量(1K/2K/4K) | ❌ | ✅ 出图分辨率 |
| `mode` | 视频生成模式(首帧/首尾帧/多参…) | ❌ | ✅ 决定视频提示词模板与参考图用法 |
| `projectType` | 项目分类 | — | — |

### ⭐ 剧本 Agent 实际看到的项目语境(源码逐字)

`src/agents/scriptAgent/index.ts` 里拼接的 `projectInfo`:

```
## 项目信息
小说名称：{name}
小说类型：{type}            ← 类型会影响
小说简介：{intro}           ← 简介会影响
目标改编影视视觉手册|画风：{artStyle}
目标改编视频画幅：{videoRatio}
章节数量：{N}章
```

**结论与建议:**
- **小说类型 + 简介确实会影响剧本生成**——它们是模型理解"这是个什么故事"的先验。所以:
  - 简介别写营销文案,要写**真实剧情主线 + 核心爽点/看点**(如"重生复仇+打脸,女主从被害到掌权"),这比一句"都市爽文"有用得多。
  - 类型尽量精确(如"悬疑+职场"而非"小说")。
- **导演手册不进剧本 Agent**——它只在"制作阶段"(分镜/拍摄计划)发挥作用。所以如果你发现"剧本本身"不对味,调的是**类型/简介 + 剧本类技能文件**;如果是"镜头/节奏/画面叙事"不对味,才去调导演手册。

### 项目语境 vs 制作 Agent

制作 Agent 的决策层**不收**类型/简介,只收"模型信息"(`src/agents/productionAgent/index.ts`):

```
项目使用的模型如下：
图像模型：{imageModelName}
视频模型：{videoModelName}
多参：{是|否}        ← 由 videoModel 能力 / mode 推断,影响下游分镜面板走 A/C 模式
```

视觉手册、导演手册则通过 `createArtSkills(artStyle, directorManual)` 加载成技能(见第 5、6 节)。

---

## 2. 小说导入与事件抽取(o_novel)

入口 `src/routes/novel/addNovel.ts`,逐章存入 `o_novel`:

| 字段 | 含义 |
|---|---|
| `chapterIndex` | 自增章节序号(流水线按此排序) |
| `chapter` | 章节标题 |
| `chapterData` | **整章原文** |
| `event` | 自动抽取的**事件摘要**(JSON) |
| `eventState` | 0待处理 / 1完成 / -1失败 |

> 关键设计:导入后系统会自动**抽取每章"事件"**。剧本的**故事骨架/改编阶段喂的是事件表(`event`)而非全文**,只有写具体剧本时才按需回读 `chapterData` 原文。
>
> 实操影响:如果某章 `eventState = -1`(抽取失败),这章在骨架阶段会"隐身",可能导致剧情断裂——导入后值得检查事件抽取是否全部成功。

---

## 3. 剧本 Agent:用到哪些信息 & 怎么调

### 三步串行流程及各步上下文

| 步骤 | 子 Agent | 看到的关键信息 | 技能文件(可改) |
|---|---|---|---|
| ① 故事骨架 | storySkeletonAgent | 项目语境(类型/简介/画风) + **事件表** + 集数/时长约束 | `data/skills/script_execution_skeleton.md` |
| ② 改编策略 | adaptationStrategyAgent | **骨架** + 事件表 | `data/skills/script_execution_adaptation.md` |
| ③ 逐集剧本 | scriptAgent(循环N集) | **骨架 + 改编策略 + 前几集已写剧本**(承接)+ 必要时原著正文 | `data/skills/script_execution_script.md` |
| 决策/质检 | decisionAgent / supervisionAgent | 全局调度 / 按维度打分 A/B/C/D | `script_agent_decision.md` / `script_agent_supervision.md` |

### 怎么调出更好的剧本

1. **先调输入**:把 `intro`(简介)写实、写出爽点;`type` 写准。
2. **调"方法论"**:剧本质量规则都在三个 `script_execution_*.md` 里——比如单集时长公式、"节奏 3-15-45"、付费卡点设计、情绪要点密度。想让剧本更"爽"/更紧凑,就改这里的约束数值与原则。
3. **调质检严格度**:`script_agent_supervision.md` 定义了打分维度与红线。想让系统更挑剔(或放宽),改这里。
4. **逐集重写**:剧本是逐集写的且会回读前文,所以**只重写某一集**时,前文已定稿会作为承接上下文——保证连贯,但也意味着前面集数的问题会"遗传"到后面,改要趁早。

---

## 4. Chat 的四个记忆控制按钮(精确行为 + 使用场景)

后端统一入口:`src/routes/agents/clearMemory.ts`。记忆按 **`isolationKey = "{projectId}:{agentType}[:{episodesId}]"`** 隔离——也就是**每个项目、每个 Agent(剧本/制作)各有独立记忆**,清空只影响当前这一格。

先理解三层记忆(存在 `memories` 表,`type ∈ {message, summary}`,`summarized` 标记):
- **近期对话(短期)**= `type=message & summarized=0` 的最近 5 条原文
- **历史摘要**= `type=summary`,每 3 条消息滚动压缩生成(≤500字)
- **相关记忆(RAG)**= 对全部 message 做向量检索,取最相关 3 条

| 按钮 | 实际行为(源码) | 效果 | 何时用 |
|---|---|---|---|
| **重新连接** | 重建 WebSocket;重置 `abortController`(中断正在生成的回复);**不动任何记忆** | 卡住/断线时恢复,数据零丢失 | 对话卡住不出字、转圈、连接断开时。**首选的"急救"操作** |
| **清空消息记忆** | 删除该 isolationKey 下**所有 message + 所有 summary**(连带删摘要防悬挂) | 对话历史彻底清零,AI 完全失忆 | 想"这条线整个推倒重来";之前对话把 AI 带偏了、上下文污染严重 |
| **清空摘要记忆** | 删除**所有 summary**,并把被压缩过的 message **重置为未摘要**(重新进入短期池) | 消息原文保留,但摘要清掉、强制下次重新压缩 | **摘要失真/过度压缩**导致 AI"记错了重点",但你不想丢对话原文时。最温和的纠偏 |
| **清空全部记忆** | 删除该 isolationKey 下**全部行**(message + summary) | 该 Agent×项目 记忆 100% 清零 | 核弹级重置;换了完全不同的创作方向、想要一个干净起点 |

> 注意:
> - "清空消息记忆"和"清空全部记忆"结果几乎一致(都让 AI 失忆),区别只是实现细节;日常**记住"全部=彻底清零""摘要=只清摘要保原文"**即可。
> - 清空是**按当前项目+当前 Agent**生效:在剧本 Agent 清空,不影响制作 Agent 的记忆,反之亦然。
> - 记忆≠工作区。**清记忆不会删掉已生成的骨架/剧本/分镜**(那些在 `o_agentWorkData`/`o_script` 等表)。记忆清掉只是让 AI"忘记你们聊过什么",产物还在。

**典型决策树:**
- 卡住了 → 重新连接
- AI 记错重点/被旧摘要误导 → 清空摘要记忆
- 整条对话跑偏、想重开 → 清空全部记忆

---

## 5. 视觉手册(art_skills):控制"长什么样",怎么改

路径:`data/skills/art_skills/<风格>/`。内置 11 种画风(`2D_90s_japanese_anime`、`2D_chinese_guofeng`、`3D_anime_render`、`realpeople_modern_city` …)。

### 单个画风的目录结构(以 `2D_90s_japanese_anime` 为例)

```
2D_90s_japanese_anime/
├── README.md                       # 风格说明(给人看)
├── prefix.md                       # ⭐主控:全局色板/光影/材质/硬约束(出图必带)
├── art_prompt/                     # ⭐生成"资产图"的提示词模板(直接拼进出图 prompt)
│   ├── art_character.md            #   角色基础形象(五官/身材/发型/基础着装/四视图)
│   ├── art_character_derivative.md #   角色衍生(换装/变身/妆造叠加,img2img)
│   ├── art_prop.md                 #   道具(材质/四宫格展示)
│   ├── art_prop_derivative.md      #   道具状态变体
│   ├── art_scene.md                #   场景(前中后景/空气透视/无人物)
│   ├── art_scene_derivative.md     #   场景时段变体(日→夜/黄昏/清晨)
│   └── art_storyboard_video.md     #   分镜视频风格注入
└── driector_skills/                # 给"制作 Agent"用的导演级视觉技能
    ├── director_planning_style.md       # 全局色调/光影/质感规划
    ├── director_storyboard.md           # 分镜面板的视觉提示词技法
    └── director_storyboard_table_style.md # 分镜表的节奏/运镜约束
```

### 每个文件控制什么 & 想改什么改哪里

| 你想改变的产出 | 编辑文件 | 关键位置 |
|---|---|---|
| **整体色彩/情绪基调**(最强杠杆) | `prefix.md` | 色板表(C1–C10 含 hex)、情感配色表、色温/饱和度规则。改一个 hex 影响全局,如把肤色基底 `#F5E6D0` 调暖 |
| 角色**基础长相**(五官/身材/头身比/基础着装) | `art_prompt/art_character.md` | 提示词模板段 + 硬约束 R1–R8 / 禁止项 X1–X8 |
| 角色**换装/变身/妆造** | `art_prompt/art_character_derivative.md` | L0–L6 分层(底模/妆/发/内外衣/鞋/饰品),用 img2img 叠在基础形象上 |
| **道具**外观/材质 | `art_prompt/art_prop.md` | 材质渲染规范 + 四宫格布局("纯道具静物,无人持有") |
| **场景**景深/材质/光 | `art_prompt/art_scene.md` | 前中后景规则、空气透视、季节配色、硬约束(R5=画面绝不出现人物) |
| 场景**时段变体**(日转夜等) | `art_prompt/art_scene_derivative.md` | 时段→光照/氛围映射 |
| 分镜**画面渲染风格** | `driector_skills/director_storyboard.md` | 情绪→表情映射、线条/光影关键词 |

### ⚠️ 改视觉手册的注意点
- **`prefix.md` 是总开关**:它在每次出图时都会被 `getArtPrompt()` 自动拼到最前面(`prefix.md + art_prompt/<对应文件>.md`)。想全局换调性,改这里收益最大。
- **硬约束(R/X 规则)别乱删**:如角色"四视图不裁切头脚"、场景"绝不出现人物"——删了会导致出图结构混乱或穿帮。
- **想新增一种画风**:复制一个现有风格目录改名,保证 `prefix.md` + `art_prompt/*` 文件齐全,再在项目里选它即可。

---

## 6. 导演手册(story_skills):控制"怎么讲、怎么拍",怎么改

路径:`data/skills/story_skills/<题材>/`。内置 11 种题材(`Urban_workplace_drama`、`Mystery_thriller`、`Sweet_romance_novel`、`Xianxia_fantasy` …)。

结构更精简,核心是两份"导演技能":

```
Urban_workplace_drama/
├── README.md
└── driector_skills/
    ├── director_planning_narrative.md        # ⭐宏观叙事:冲突方式/节奏/主题/声音/构图哲学
    └── director_storyboard_table_narrative.md # ⭐镜头执行:景别比例/运镜/时长/对白分镜/转场
```

### 它控制什么(以职场剧为例)
- `director_planning_narrative.md`:定义这一题材的**讲故事方式**——比如"职场冲突是会议室话语权博弈而非街头打架""留白即谈判筹码,关键情绪点去掉音乐""音乐占比≤40%";还把 6 类场景映射到情绪/技法/配乐。
- `director_storyboard_table_narrative.md`:定义**镜头战术**——景别比例(中景为主)、运镜(固定机位≥65%)、每镜时长(对白 2–4s、一句一镜、单镜≤6s)、对白分镜(过肩/三角构图/反应镜头)、转场规则。

### 视觉手册 vs 导演手册(一句话区分)

| | 视觉手册 art_skills | 导演手册 story_skills |
|---|---|---|
| 管什么 | **画面长什么样**(色/光/材质/角色场景道具外观) | **故事怎么讲、镜头怎么拍**(叙事/节奏/景别/运镜/对白) |
| 影响 | 资产图、分镜图的视觉 | 拍摄计划、分镜表的镜头与节奏 |
| 关系 | **二者正交,可自由组合**——"90年代日漫画风 + 职场剧叙事"= 复古风职场剧 |

### 怎么调
- 觉得**画面对但镜头/节奏不对**(太平、没张力、对白堆砌)→ 改导演手册的两份文件。
- 想新增题材:复制一个题材目录改名,补齐 `driector_skills/` 两份 narrative 文件,项目里选它。
- 这些技能通过 `activate_skill` 按需加载,**frontmatter 的 `name` 必须和调用名一致**,别把 frontmatter 写进正文。

---

## 7. 制作 Agent 流程总览(六阶段)

剧本定稿后切到制作 Agent,串行六步(详见架构篇),各步挂载的技能不同:

```
① 导演规划   → 拍摄计划<scriptPlan>           (artSkills:含视觉+导演 director_skills)
② 衍生资产分析 → 角色变身/场景时段变体等          (artSkills)
③ 衍生资产生成 → 异步出图 generate_assets_images  (走 u.Ai.Image)
④ 分镜表     → <storyboardTable> 镜头/时长/资产 (productionSkills:+通用分镜技法)
⑤ 分镜面板   → <storyboardItem> 逐镜 prompt    (productionSkills;按"多参"走A/C模式)
⑥ 分镜图生成  → 异步出图 generate_storyboard_images
```

> 技能加载逻辑(`productionAgent/index.ts`):`createArtSkills` 会同时扫描**视觉手册和导演手册各自的 `driector_skills/*.md`**;`useProductionSkills` 在此基础上再加 `data/skills/production_skills/*` 的通用分镜技法。所以:
> - ①②③⑥ 主要受**视觉手册 + 导演手册的 director_skills**影响;
> - ④⑤ 还额外受 **`production_skills/storyboard_*_techniques.md`** 影响(想统一调分镜表/面板的通用规则,改这两份)。

---

## 8. 角色塑造:"Prompt 重新生成"依赖什么 & 怎么改更合理 ⭐

这是你特别问到的点。入口逻辑在 `src/routes/production/assets/batchGenerateAssetsImage.ts`。

### 资产数据模型(o_assets)
| 字段 | 含义 |
|---|---|
| `name` | 资产名(角色名/场景名/道具名) |
| `describe` | **资产描述(你填的)**——这是你能直接影响 prompt 的主要入口 |
| `type` | `role`(角色)/`scene`(场景)/`tool`(道具)/`clip` |
| `prompt` | **AI 生成的出图提示词**(就是"重新生成"会覆盖的字段) |
| `assetsId` | 父资产 ID——衍生资产(换装/表情)指向基础角色 |
| `imageId` | 关联生成图 `o_image.id` |

### "Prompt 重新生成"到底依赖哪些输入

```
最终 prompt = AI( 
    system = getArtPrompt(项目.artStyle, "art_skills", 模板名)     ← 视觉手册模板
                = prefix.md  +  art_prompt/art_character[_derivative].md
    user   = "父级资产描述: {父级.describe}    ← 仅衍生资产有
              当前资产描述: {本资产.describe}"  ← 你填的 describe
)
```

也就是说,角色 prompt 的质量由**三个东西**决定:
1. **视觉手册模板**(`prefix.md` + `art_character*.md`)——风格、结构、硬约束;
2. **你填的 `describe`**——具体特征;
3. (衍生时)**父级角色的 describe + 父级图作为 img2img 参考**——保证一致性。

出图时:`u.Ai.Image(项目.imageModel).run({ prompt, referenceList:[父级图base64], size:imageQuality, aspectRatio })`,衍生角色用父级图做 img2img 锁脸。

### 怎么改让 prompt 更合理(按收益排序)

1. **把 `describe` 写具体**(立刻见效,零成本)
   - ❌"医生" → ✅"女性,28岁,急诊科医生,干练利落,短发,穿白大褂,眼神坚定略带疲惫"
   - 基础角色:把**五官、身材、气质、身份着装**写全(模板会据此推导);
   - 衍生角色:**只写"变化量"**,如"红色晚礼服 + 精致妆容"或"愤怒表情",其余靠父级继承,别重复描述长相。
2. **改视觉手册模板**(影响该画风下所有角色)
   - 基础长相结构 → `art_prompt/art_character.md`(模板段 + R/X 约束);
   - 换装/妆造质量 → `art_prompt/art_character_derivative.md`(L1–L6 分层规则);
   - 整体调性/肤色/色温 → `prefix.md` 色板。
3. **保证父级角色质量**:衍生靠父级继承,**父级 `describe` 不全/父级图不好,所有衍生都会差**。先把基础角色调满意,再批量生成衍生。
4. **参考图一致性**:角色换装/表情漂脸,通常是父级图不够清晰或 describe 把"长相"又描述了一遍(与 img2img 打架)——衍生描述里删掉长相、只留变化。

---

## 9. 分镜表 → 分镜面板 → 分镜图

| 阶段 | 产物/关键字段 | 受什么影响 |
|---|---|---|
| 分镜表 `<storyboardTable>` | 镜头、时长、关联资产 ID | 导演手册 narrative + `production_skills/storyboard_table_techniques.md` + 视觉手册节奏约束 |
| 分镜面板 `<storyboardItem>` | `videoDesc / prompt / track / duration / associateAssetsIds / shouldGenerateImage` | **"多参"标志**决定模式:模式A(纯文本多参,不出首帧图)/ 模式C(首帧模式,逐镜出图) + `storyboard_prompt_techniques.md` |
| 分镜图 | 出图存 `o_storyboard.filePath` | `u.Ai.Image`,参考图=该镜关联的角色/场景/道具资产图(base64) |

> 想统一调"分镜镜头语言/时长/出图提示词规范",改 `data/skills/production_skills/storyboard_table_techniques.md` 和 `storyboard_prompt_techniques.md`。

---

## 10. 下游:视频提示词 / 视频生成 / 配音 / 工作台 / 合成

入口集中在 `src/routes/production/workbench/`。

### 10.1 视频提示词(按模型自动选模板)
`generateVideoPrompt.ts` 会**根据视频模型名 + mode 自动挑提示词模板**,例如:
- `wan 2.6` → 单图首帧模板;`seedance 2.0` → 多参模板;
- `startEndRequired/…` → 通用首尾帧模板;
- mode 为 `["imageReference:2","audioReference:1"]` 数组 → 通用多参模板。

输入综合了:该镜 `videoDesc/duration` + 关联资产(角色/道具/场景/音频绑定)+ 视觉技能,产出存 `o_videoTrack.prompt`。

### 10.2 视频生成 mode(由项目 `mode` 字段驱动)
`u.Ai.Video(model).run({ prompt, referenceList, mode, duration, aspectRatio, resolution, audio })`。mode 取值:
`singleImage` | `startEndRequired` | `endFrameOptional` | `startFrameOptional` | `text` | 数组多参(`imageReference:N` / `videoReference:N` / `audioReference:K`)。

> 这就是"多参(isRef)"的来源:项目 `mode` 存成 JSON 数组时即多参模式,会一路影响到分镜面板模式 A/C 与视频参考图组织方式。**选错模型/mode 会导致提示词模板不匹配、参考图用不上**——这是出片质量的隐形坑。

### 10.3 配音 / 音频
- 角色与音频绑定:`o_assetsRole2Audio`(角色资产 ↔ 音频资产),查询见 `getAudioBindAssetsList.ts`。
- 生成提示词时把音频绑定信息一并带给模型;`audioReference:N` 模式下音频作为 `referenceList`(`type:"audio"`)送入视频模型。
- TTS 走 `u.Ai.Audio`(`ttsRequest`);BGM/音效目前未见独立流程,属后期资产。

### 10.4 工作台路由速览
| 路由 | 作用 |
|---|---|
| `generateVideoPrompt.ts` / `batchGeneratePrompt.ts` | 单/批 生成视频提示词 |
| `generateVideo.ts` / `batchGenerateVideo.ts` | 单/批 生成视频片段 |
| `addTrack.ts` / `deleteTrack.ts` | 增删轨道 |
| `selectVideo.ts` / `delVideo.ts` | 一个轨道可生成多个候选片段,选定/删除 |
| `updateVideoPrompt.ts` / `updateVideoDuration.ts` | 手动改提示词/时长 |
| `checkVideoStateList.ts` / `getVideoList.ts` | 查生成状态/片段列表 |

### 10.5 合成
当前是**轨道制**:每个分镜对应一条 `o_videoTrack`,可生成多个候选 `o_video`,选定其一;按分镜顺序排列。最终成片拼接/导出在发布阶段处理(当前路由层未见显式拼接)。字幕同理,暂无独立生成路由。

---

## 11. 调优速查表(想改 X → 动哪里)

| 想改变 | 改这里 | 通道 |
|---|---|---|
| 剧情走向/爽点/题材味 | 项目 `intro`、`type` + `script_execution_*.md` | 字段+技能 |
| 单集节奏/时长/付费卡点 | `script_execution_script.md` / `_skeleton.md` | 技能 |
| 剧本质检严格度 | `script_agent_supervision.md` | 技能 |
| 整体画面色彩/情绪 | `art_skills/<风格>/prefix.md` 色板 | 技能 |
| 角色长相/身材结构 | `art_skills/<风格>/art_prompt/art_character.md` | 技能 |
| 角色换装/妆造/表情质量 | `art_character_derivative.md` + 衍生 `describe` 写法 | 技能+字段 |
| 单个角色更精准 | 该资产 `describe` 写具体 | 字段 |
| 场景景深/光/材质 | `art_prompt/art_scene.md` | 技能 |
| 道具材质/展示 | `art_prompt/art_prop.md` | 技能 |
| 镜头语言/景别/运镜/留白 | `story_skills/<题材>/driector_skills/*.md` | 技能 |
| 分镜表/面板通用规范 | `production_skills/storyboard_*_techniques.md` | 技能 |
| 出图分辨率/画幅 | 项目 `imageQuality` / `videoRatio` | 字段 |
| 视频参考图/首帧逻辑 | 项目 `videoModel` / `mode` | 字段 |
| AI"记错重点" | 清空摘要记忆 | 操作 |
| 对话跑偏要重开 | 清空全部记忆 | 操作 |
| 对话卡住 | 重新连接 | 操作 |

---

## 12. 推荐工作流 & 常见误区

**推荐顺序**
1. 建项目:简介写实、类型写准、选好视觉手册 + 导演手册 + 合适的图像/视频模型与 mode。
2. 导入小说 → 确认事件抽取全部成功。
3. 剧本 Agent:骨架 → 改编 → 逐集剧本,每个 gate 看监督评分,不满意趁早重做(越早改成本越低)。
4. 制作 Agent:先把**基础角色资产**调满意(describe 写足 + 出图确认),再批量衍生。
5. 导演规划 → 分镜表 → 分镜面板 → 分镜图 → 视频提示词 → 视频 → 配音 → 选片合成。

**常见误区**
- ❌ 反复点"重新生成"却不改 `describe`/技能文件——输入不变,质量上限不变。
- ❌ 简介写成营销语("超爽神作")——对模型几乎无信息量,要写真实主线。
- ❌ 衍生角色描述里又写一遍长相——和父级 img2img 打架导致漂脸。
- ❌ 画面不满意去清记忆——记忆管的是"对话上下文",画面质量由视觉手册+describe+模型决定。
- ❌ 视频模型/mode 与项目不匹配——导致提示词模板选错、参考图用不上。
- ❌ 改了技能文件以为要重启——**不用,即时生效**;但注意 `data/` 在 Docker 是持久卷,改动要落到挂载目录。

---

## 附:关键路径索引

| 关注点 | 路径 |
|---|---|
| 项目创建 / 字段 | `src/routes/project/addProject.ts`、`o_project`(`src/lib/initDB.ts`) |
| 小说导入 / 事件抽取 | `src/routes/novel/addNovel.ts` |
| 剧本 Agent | `src/agents/scriptAgent/` + `data/skills/script_*.md` |
| 制作 Agent | `src/agents/productionAgent/` + `data/skills/production_*.md` |
| 记忆清空 | `src/routes/agents/clearMemory.ts`、`src/utils/agent/memory.ts` |
| 视觉手册 | `data/skills/art_skills/<风格>/`(`prefix.md`、`art_prompt/*`、`driector_skills/*`) |
| 导演手册 | `data/skills/story_skills/<题材>/driector_skills/*` |
| 通用分镜技法 | `data/skills/production_skills/*` |
| 角色/资产出图 | `src/routes/production/assets/batchGenerateAssetsImage.ts`、`src/utils/getArtPrompt.ts` |
| 出图提示词加载 | `src/utils/getArtPrompt.ts`(`prefix.md` + `art_prompt/<文件>.md`) |
| 视频/配音/工作台 | `src/routes/production/workbench/*` |
| 模型抽象 | `src/utils/ai.ts`(`Text/Image/Video/Audio`) |
