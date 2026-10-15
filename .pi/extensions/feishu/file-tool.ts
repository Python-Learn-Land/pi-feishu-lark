import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sendLargeFileViaDrive } from "./drive-sender.js";
import { createFileLink, fileServerBaseUrl } from "./file-server.js";
import { formatBytes, MAX_UPLOAD_BYTES, sendFileToSessionRoute, sendTextToSessionRoute } from "./file-sender.js";

type LargeFileMode = "auto" | "drive" | "link";

function largeFileMode(): LargeFileMode {
  const raw = process.env.FEISHU_LARGE_FILE_MODE?.trim().toLowerCase();
  if (raw === "drive" || raw === "link") return raw;
  return "auto";
}

const SendFileParams = Type.Object({
  path: Type.String({ description: "要发送的本地文件路径，可以是绝对路径或相对当前工作区的路径" }),
});

/**
 * 飞书子会话专用工具：让 Pi 把本地文件发回飞书对话。
 * 只在桥接创建的子会话里注册（CHILD_SESSION_ENV=1），不污染用户的主会话。
 */
export function registerFeishuChildTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "feishu_send_file",
    label: "Feishu Send File",
    description:
      `Send a local file to the user in the current Feishu/Lark chat. 当用户要求把文件发送到飞书/发给我时使用。` +
      `不超过 ${formatBytes(MAX_UPLOAD_BYTES)} 的文件直接以飞书文件消息发送；` +
      `超过限制的大文件默认上传到飞书云文档并发送链接（纯出站请求，不需要公网 IP，但需要应用有 drive:drive 权限）；` +
      `云文档不可用时降级为本机 HTTP 限时下载链接（受 FEISHU_FILE_SERVER_BASE/FEISHU_FILE_SERVER_PORT 配置影响）。`,
    parameters: SendFileParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
      if (!existsSync(filePath)) {
        throw new Error(`文件不存在：${filePath}`);
      }
      const sessionId = ctx.sessionManager.getSessionId();
      const size = statSync(filePath).size;
      if (size > MAX_UPLOAD_BYTES) {
        return await sendLargeFile(sessionId, filePath, size);
      }
      const { fileName, bytes } = await sendFileToSessionRoute(sessionId, filePath);
      return {
        content: [{ type: "text" as const, text: `文件已发送到飞书对话：${fileName}（${formatBytes(bytes)}）` }],
        details: undefined,
      };
    },
  });
}

/** 大文件：优先云文档（无需公网 IP），失败按模式降级为本机限时下载链接。 */
async function sendLargeFile(sessionId: string, filePath: string, size: number) {
  const fileName = basename(filePath);
  const mode = largeFileMode();
  let driveError: string | undefined;

  if (mode !== "link") {
    try {
      const result = await sendLargeFileViaDrive(sessionId, filePath);
      const grantDetail = result.accessError ? `（授权接口报错：${result.accessError}）` : "";
      const accessNote =
        result.access === "owner" ? "文件所有权已转移给你，在云文档“我的空间”中可见，拥有完全控制权"
        : result.access === "full" ? `已授予你可管理权限（可分享/删除），但文件所有者仍是机器人应用${grantDetail}`
        : result.access === "tenant" ? `同一组织内获得链接的人可查看；单独授权失败${grantDetail}`
        : `注意：权限设置失败，链接可能无法打开，请在云文档里手动调整权限${grantDetail}`;
      return {
        content: [{
          type: "text" as const,
          text:
            `文件 ${fileName}（${formatBytes(size)}）已上传到飞书云文档并把链接发到对话：` +
            `${result.url || result.fileToken}。${accessNote}。`,
        }],
        details: undefined,
      };
    } catch (error) {
      driveError = error instanceof Error ? error.message : String(error);
      if (mode === "drive") {
        throw new Error(`${driveError}（当前 FEISHU_LARGE_FILE_MODE=drive，未使用本机链接充底）`);
      }
    }
  }

  const link = await createFileLink(filePath);
  const minutes = Math.round(link.ttlMs / 60_000);
  await sendTextToSessionRoute(
    sessionId,
    `📎 ${fileName}（${formatBytes(size)}）\n文件超过飞书 30MB 上传限制，已生成临时下载链接（${minutes} 分钟内有效）：\n${link.url}`,
  );
  const driveNote = driveError
    ? `另外，飞书云文档上传失败（${driveError}）；如果这台主机没有公网 IP，建议按提示开通 drive:drive 权限后重试。`
    : "";
  return {
    content: [{
      type: "text" as const,
      text:
        `文件 ${fileName}（${formatBytes(size)}）超过飞书 30MB 上传限制，已改为发送临时下载链接到对话：` +
        `${link.url}（${minutes} 分钟内有效，服务地址 ${fileServerBaseUrl()}）。` +
        `请告知用户：如果链接无法打开，说明接收设备访问不到这台主机，` +
        `需要让设备和主机处于同一网络，或配置 FEISHU_FILE_SERVER_BASE 为可公网访问的地址后重试。${driveNote}`,
    }],
    details: undefined,
  };
}
