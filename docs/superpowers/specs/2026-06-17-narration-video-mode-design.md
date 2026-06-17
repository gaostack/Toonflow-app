# 解说类短视频模式 Design Spec

## 背景

用户希望在 Toonflow 现有架构上支持"解说类短视频"生产模式。

**目标：** 给定小说/故事文本，自动生成解说类短视频：旁白 TTS + 角色台词 TTS + AI 生成画面 → 最终合成 MP4。

---

## 什么是解说类短视频

**核心结构（三层音频 + 视觉）：**

| 层 | 内容 | 来源 |
|---|---|---|
| 旁白（VO） | 叙述者解说，推进剧情 | TTS 合成（固定音色） |
| 角色台词 | 剧中人物对话片段 | TTS 合成（每个角色独立音色 ID） |
| 背景音效 | 环境音、动作音效 | 素材库 |
| 视觉 | AI 生成图像/视频 | AI 图像 + 视频 API |

**核心节奏法则：** 3秒一钩子 → 15秒一转折 → 45秒一大高潮

**与现有"剧本模式"的核心差异：**
- 脚本风格：旁白解说体（第三人称叙述 + 情绪渲染），而非剧本对话体
- 需要 TTS 音频合成（现有模式无音频）
- 需要最终 ffmpeg 音视频合成步骤

---

## 确认的设计决策

### 决策 1：视觉层来源
**选择：AI 生成**（不依赖真实剧集素材）  
用户不提供任何真实素材，视觉全部由 AI 图像/视频生成。

### 决策 2：音频方案
**选择：旁白固定音色 + 角色各自独立音色**  
- 旁白：一个统一的 TTS 音色
- 每个角色：绑定独立的 TTS 音色 ID（通过现有 `o_assetsRole2Audio` 扩展）

### 决策 3：TTS 供应商
**选择：多供应商支持（MiniMax + VolcEngine，可扩展）**  
在现有供应商系统里各自实现 `ttsRequest`，用户在设置里选择。

### 决策 4：整体架构方案
**选择：方案一 —— 新增 `projectType = 'narration'` 项目类型**  
在现有系统里加模式标识，两套 Agent 根据模式走不同 skill 分支。  
理由：最大复用现有架构，避免重复代码。

---

## 整体架构

### 数据流

```
用户输入故事/小说
        ↓
  NarrationScriptAgent        ← 新 skill prompt（解说体脚本风格）
  生成解说稿（旁白+台词分层）
        ↓
  NarrationProductionAgent    ← 扩展现有 ProductionAgent
  分镜规划 → AI 图像/视频生成
        ↓
  TTS 合成步骤（新）
  旁白段 → ttsRequest(narrator voice)
  每段台词 → ttsRequest(character voice ID)
        ↓
  ffmpeg 合成（新路由）
  图/视频 + 各段音频 + 字幕 → 最终 MP4
```

### 新增模块清单

| 模块 | 位置 | 说明 |
|---|---|---|
| Narration Script skills | `data/skills/narration_script_*.md` | 解说体脚本生成 prompt |
| Narration Production skills | `data/skills/narration_production_*.md` | 分镜规划 prompt（含 TTS 时间节点） |
| MiniMax TTS 实现 | `data/vendor/minimax.ts` | 填充 `ttsRequest` 空桩 |
| VolcEngine TTS 实现 | `data/vendor/volcengine.ts` | 填充 `ttsRequest` 空桩 |
| TTS 合成路由 | `src/routes/production/workbench/synthesizeTTS.ts` | 批量为分镜生成音频 |
| ffmpeg 合成路由 | `src/routes/production/workbench/composeVideo.ts` | 最终合成 MP4 |

---

## 数据模型变更

### `o_project` 新增字段

```sql
ALTER TABLE o_project ADD COLUMN projectType TEXT DEFAULT 'drama';
-- 'drama' = 现有模式
-- 'narration' = 解说类短视频模式
```

注：探索发现 `o_project` 可能已存在 `projectType` 字段（database.d.ts 中有此字段），
实现时需先检查是否已存在。

### `o_storyboard` 新增字段

```sql
ALTER TABLE o_storyboard ADD COLUMN narratorAudioPath TEXT;
-- 旁白 TTS 生成的音频文件路径（相对于 data/oss/）

ALTER TABLE o_storyboard ADD COLUMN dialogueAudioJson TEXT;
-- JSON 数组: [{ "characterId": 1, "text": "...", "audioPath": "..." }]

ALTER TABLE o_storyboard ADD COLUMN audioDuration REAL;
-- 合计音频时长（秒），用于与视频时长对齐
```

### `o_assetsRole2Audio` 扩展

现有表只存 assetsAudioId（已上传音频文件）。解说模式需要存 TTS 音色 ID：

```sql
ALTER TABLE o_assetsRole2Audio ADD COLUMN voiceId TEXT;
-- TTS 供应商的音色 ID（如 MiniMax 的 voice name，VolcEngine 的 speaker ID）
-- 存在时走 TTS 合成；不存在时走现有的音频文件方式
```

---

## TTS 接口规范

现有 `ttsRequest` 签名（vendor 侧）：
```typescript
const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  // 返回 base64 编码的音频数据 或 音频文件 URL
  return "";
};
```

```typescript
interface TTSConfig {
  text: string;
  voice: string;        // 音色 ID
  speechRate: number;   // 语速
  pitchRate: number;    // 音调
  volume: number;       // 音量
}
```

调用侧通过 `u.Ai.Audio(key)` 获取实例，key 格式为 `${vendorId}:${modelName}`。

---

## 脚本风格差异

| 维度 | 剧本模式（现有） | 解说模式（新增） |
|---|---|---|
| 叙事视角 | 剧本对话体，第一人称 | 旁白解说体，第三人称叙述 |
| 台词比例 | 主体是对话台词 | 旁白为主（60-70%），台词穿插 |
| 节奏要求 | 戏剧节奏 | 3秒钩子/15秒转折/45秒高潮 |
| VO 字段 | 可选 | 必填，每个分镜必须有旁白文案 |
| 音效 | 可选 | 必填（禁止 BGM，只用环境音+音效） |

Narration Script skill 需要重新设计 prompt，强调：
- 信息密度（每秒4字 TTS 节奏）
- 情绪钩子设计
- 旁白+台词穿插比例

---

## 待定/待底层重构完成后确认的问题

1. **底层 Agent 框架重构方向**：重构完成后，`projectType` 分支逻辑在 Agent 入口处如何实现（条件判断 vs 独立入口）需要根据新架构决定。
2. **ffmpeg 依赖**：是作为 npm 包（`fluent-ffmpeg`）引入，还是依赖系统安装的 ffmpeg？Docker 镜像需要相应调整。
3. **字幕格式**：最终合成时字幕烧录（硬字幕）还是作为独立轨道（软字幕/SRT）？
4. **分镜 TTS 合成时机**：在分镜生成时同步合成，还是所有分镜生成完后批量合成？

---

## 参考：当前架构关键文件

| 关注点 | 文件 |
|---|---|
| TTS 基础设施 | `src/utils/ai.ts` - `AiAudio` 类（lines 324-351） |
| TTS 空桩 | `data/vendor/minimax.ts` - `ttsRequest`（lines 368-370） |
| 音频路由 | `src/routes/cornerScape/` - `updateAssetsAudio.ts`, `pollingAudio.ts` |
| DB 迁移模式 | `src/lib/fixDB.ts` - `addColumn` 工具函数 |
| 视频生成路由 | `src/routes/production/workbench/generateVideo.ts` |
| Agent skill 加载 | `src/agents/scriptAgent/index.ts` - `path.join(u.getPath("skills"), ...)` |
