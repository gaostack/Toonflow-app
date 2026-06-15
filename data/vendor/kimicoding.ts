/**
 * Toonflow AI供应商：Kimi For Coding
 * @version 1.0
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage" //单图参考
  | "startEndRequired" //首尾帧（两张都得有）
  | "endFrameOptional" //首尾帧（尾帧可选）
  | "startFrameOptional" //首尾帧（首帧可选）
  | "text" //文本
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[]; //多参考（数字代表限制数量）

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string; //唯一ID，作为文件名存储用户磁盘上，禁止符号
  version: string; //版本号，格式为x.y，需遵守语义化版本控制
  name: string; //供应商名称
  author: string; //作者
  description?: string; //描述，支持Markdown格式
  icon?: string; //图标，仅支持Base64格式，建议尺寸为128x128像素
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any; // HTTP请求库
declare const logger: (msg: string) => void; // 日志函数
declare const jsonwebtoken: any; // JWT处理库
declare const zipImage: (base64: string, size: number) => Promise<string>; // 图片压缩函数，返回有头base64字符串
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>; // 图片分辨率调整函数，返回有头base64字符串
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>; // 图片合成函数，返回有头base64字符串
declare const urlToBase64: (url: string) => Promise<string>; // URL转Base64函数，返回有头base64字符串
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>; // 轮询函数，fn为异步函数，interval为轮询间隔，timeout为超时时间，返回fn的结果
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any; //文本模型
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>; //图片模型，返回有头base64字符串
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>; //视频模型，返回有头base64字符串
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>; //（暂未开放）语音模型，返回有头base64字符串
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>; //检查更新函数，返回是否有更新和最新版本号和更公告（支持Markdown格式）
  updateVendor?: () => Promise<string>; //更新函数，返回最新的代码文本
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "kimicoding",
  version: "1.0",
  author: "Toonflow",
  name: "Kimi For Coding",
  description:
    "## Kimi For Coding\n\n" +
    "月之暗面 Kimi For Coding 订阅服务（OpenAI 兼容协议）。\n\n" +
    "### 配置说明\n" +
    "- **API密钥**：在 Kimi Code 控制台获取，形如 `sk-kimi-xxxx`。\n" +
    "- **请求地址**：保持默认 `https://api.kimi.com/coding/v1`。\n\n" +
    "> 注意：Kimi For Coding 仅对编码代理（Claude Code / Kimi CLI 等）开放，" +
    "本供应商已自动携带 Claude Code 的 User-Agent 以通过校验。",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true, placeholder: "示例：sk-kimi-xxxx" },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://api.kimi.com/coding/v1" },
  ],
  inputValues: { apiKey: "", baseUrl: "https://api.kimi.com/coding/v1" },
  models: [{ name: "Kimi For Coding", modelName: "kimi-for-coding", type: "text", think: true }],
};

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  if (!vendor.inputValues.baseUrl) throw new Error("缺少请求地址");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  // Kimi For Coding 网关只放行白名单内的编码代理（Claude Code / Kimi CLI / Roo Code 等），
  // 校验请求头 User-Agent 前缀，否则返回 403：
  // "Kimi For Coding is currently only available for Coding Agents ..."
  // 注意：AI SDK v6 在 generateText/streamText 路径下会丢弃 provider 的 headers["User-Agent"]，
  // 实际发出的 UA 变成 "ai/x ai-sdk/... runtime/node.js/..."，前缀不再是 claude-cli，导致被拒。
  // 因此必须用自定义 fetch，在请求真正发出前强制覆盖 User-Agent（沙盒未注入 Headers，故用普通对象合并）。
  return createOpenAI({
    baseURL: vendor.inputValues.baseUrl,
    apiKey,
    fetch: (url: any, init: any = {}) => {
      let h = init.headers || {};
      if (typeof h.entries === "function") h = Object.fromEntries(h.entries());
      else if (Array.isArray(h)) h = Object.fromEntries(h);
      const merged: Record<string, string> = { ...h };
      for (const k of Object.keys(merged)) if (k.toLowerCase() === "user-agent") delete merged[k];
      merged["User-Agent"] = "claude-cli/2.1.112 (external, cli)";
      return fetch(url, { ...init, headers: merged });
    },
  }).chat(model.modelName);
};

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  return "";
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "1.0", notice: "## 新版本更新公告" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

// 这行代码用于确保当前文件被识别为模块，避免全局变量冲突
export {};
