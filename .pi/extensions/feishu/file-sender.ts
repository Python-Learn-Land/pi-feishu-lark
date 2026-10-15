import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { FeishuBridgeStore } from "./bridge-store.js";
import { loadConfig } from "./config.js";
import { debugLog } from "./debug.js";

// 飞书 im/v1/files 上传限制：文件不得超过 30MB，且不允许空文件
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

let sdkClient: any;

/**
 * 发文件只需要 REST 调用（上传 + 发消息），不依赖 WS 长连接，
 * 所以这里和 delivery.ts 一样按需创建一个独立的 API client。
 * 这样无论工具运行在 daemon 进程还是 TUI 进程的子会话里都能工作。
 */
export async function getFeishuApiClient() {
  if (sdkClient) return sdkClient;
  const cfg = loadConfig();
  if (!cfg) throw new Error("飞书配置不存在，请先在主会话运行 /feishu setup");
  const lark = await import("@larksuiteoapi/node-sdk");
  sdkClient = new lark.Client({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: cfg.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
  });
  return sdkClient;
}

const ensureClient = getFeishuApiClient;

export function resolveRoute(sessionId: string) {
  const route = new FeishuBridgeStore().getRouteBySessionId(sessionId);
  if (!route) {
    throw new Error("找不到当前会话绑定的飞书会话（请先在飞书里给机器人发一条消息建立绑定）");
  }
  return route;
}

/** 给指定 Pi 会话绑定的飞书会话发一条纯文本消息（链接消息用，URL 会自动识别为可点击）。 */
export async function sendTextToSessionRoute(sessionId: string, text: string) {
  const route = resolveRoute(sessionId);
  const client = await ensureClient();
  const content = JSON.stringify({ text });
  if (route.threadMessageId) {
    await client.im.message.reply({
      path: { message_id: route.threadMessageId },
      data: { msg_type: "text", content },
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: route.chatId, msg_type: "text", content },
    });
  }
}

/**
 * 把本地文件发送到指定 Pi 会话绑定的飞书会话里。
 * 路由信息来自 ~/.pi/agent/feishu/bridge.json（文件存储，跨进程可读）。
 */
export async function sendFileToSessionRoute(
  sessionId: string,
  filePath: string,
): Promise<{ fileName: string; bytes: number }> {
  const route = resolveRoute(sessionId);

  const stat = statSync(filePath);
  if (stat.isDirectory()) throw new Error(`路径是目录，无法发送：${filePath}`);
  if (stat.size <= 0) throw new Error("不能发送空文件");
  if (stat.size > MAX_UPLOAD_BYTES) {
    const error = new Error(`文件 ${formatBytes(stat.size)} 超过飞书 ${formatBytes(MAX_UPLOAD_BYTES)} 上传限制`) as Error & { code?: string };
    error.code = "FEISHU_FILE_TOO_LARGE";
    throw error;
  }

  const fileName = basename(filePath);
  const bytes = await readFile(filePath);
  const client = await ensureClient();
  debugLog("feishu.send_file.start", { sessionId, fileName, bytes: stat.size, chatId: route.chatId });

  const upload = await client.im.v1.file.create({
    data: { file_type: "stream", file_name: fileName, file: bytes },
  });
  const fileKey = upload?.file_key ?? upload?.data?.file_key;
  if (!fileKey) {
    throw new Error(`文件上传失败：${safePreview(upload) || "未返回 file_key"}`);
  }

  const content = JSON.stringify({ file_key: fileKey });
  if (route.threadMessageId) {
    // 话题里回复话题根消息，让文件留在话题内
    await client.im.message.reply({
      path: { message_id: route.threadMessageId },
      data: { msg_type: "file", content },
    });
  } else {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: route.chatId, msg_type: "file", content },
    });
  }

  debugLog("feishu.send_file.done", { sessionId, fileName, fileKey });
  return { fileName, bytes: stat.size };
}

function safePreview(value: unknown) {
  try {
    return JSON.stringify(value)?.slice(0, 200);
  } catch {
    return "";
  }
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
