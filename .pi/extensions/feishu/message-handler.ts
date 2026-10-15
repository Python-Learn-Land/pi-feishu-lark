import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectCodeLanguage, decodeTextFile, detectImageMime, type FeishuImageInput, isSupportedImageMime, isSupportedTextFile } from "./attachments.js";
import { buildModelCard, buildResumeCard, buildWorkspaceCard } from "./cards.js";
import type { ConversationManager } from "./conversation-manager.js";
import { claimFeishuMessage, markFeishuMessage } from "./dedupe-store.js";
import { debugLog } from "./debug.js";
import { conversationKey, conversationLabel, normalizeForDedupe, parseBotCommand, parseMessageInput, pruneRecentMap } from "./messages.js";
import { TaskStatusCard } from "./task-status-card.js";
import type { FeishuBridgeStore } from "./bridge-store.js";
import type { FeishuTransport } from "./transport.js";
import type { FeishuMessage } from "./types.js";

const CONTENT_DEDUPE_TTL_MS = 5_000;
const FILE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_SAVED_FILE_BYTES = 200 * 1024 * 1024;
const INBOX_DIR_NAME = ".feishu-inbox";

type SavedFile = { fileName: string; savedPath: string; bytes: number };

export class FeishuMessageHandler {
  private readonly seen = new Set<string>();
  private readonly recentContent = new Map<string, number>();

  constructor(
    private readonly conversations: ConversationManager,
    private readonly getTransport: () => FeishuTransport | undefined,
    private readonly bridgeStore?: FeishuBridgeStore,
  ) {}

  reset() {
    this.seen.clear();
    this.recentContent.clear();
  }

  async handle(msg: FeishuMessage) {
    const transport = this.getTransport();
    if (!transport) return;

    try {
      if (this.seen.has(msg.messageId)) return;
      if (!(await claimFeishuMessage(msg.messageId))) return;
      this.seen.add(msg.messageId);
      if (this.seen.size > 2000) this.seen.clear();

      const parsed = parseMessageInput(msg, transport.getBotOpenId());
      const text = parsed.text || "";
      const key = conversationKey(msg);
      this.bridgeStore?.bindConversation(key, msg);
      debugLog("feishu.handler.parsed", {
        messageId: msg.messageId,
        key,
        chatMode: msg.chatMode,
        threadId: msg.threadId || msg.rootId || msg.parentId,
        textLength: text.length,
        attachments: parsed.attachments.map((item) => ({
          kind: item.kind,
          fileKey: item.fileKey,
          fileName: item.fileName,
        })),
      });

      if (!parsed.attachments.length) {
        if (!text) {
          await markFeishuMessage(msg.messageId, "ignored");
          return;
        }
        const handled = await this.handleCommand(msg, key, text);
        if (handled) {
          await markFeishuMessage(msg.messageId, "replied");
          return;
        }
      }

      if (this.isDuplicateContent(msg, key, text, parsed.attachments)) {
        await markFeishuMessage(msg.messageId, "ignored");
        return;
      }

      const model = await this.conversations.getSelectedModel(key);
      const modelSupportsImage = Boolean(model && Array.isArray((model as any).input) && (model as any).input.includes("image"));
      debugLog("feishu.handler.model", {
        messageId: msg.messageId,
        key,
        model: model ? `${(model as any).provider}/${(model as any).id}` : undefined,
        modelSupportsImage,
      });

      const workspace = this.conversations.getWorkspace(key);
      const processed = await this.processAttachments(msg, parsed.attachments, modelSupportsImage, workspace);
      const { imageInputs, fileSections, savedFiles, downloadErrors, skippedImageCount } = processed;

      if (skippedImageCount > 0 && imageInputs.length === 0 && !fileSections.length && !savedFiles.length && !text.trim()) {
        await transport.replyText(
          msg.messageId,
          "当前模型不支持图片解析。请先发送 /model 并切换到支持图片的模型后，再重发图片。",
        );
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      if (downloadErrors.length && !imageInputs.length && !fileSections.length && !savedFiles.length && !text.trim()) {
        await transport.replyText(msg.messageId, `没有可处理的内容：${downloadErrors.join("；")}`);
        await markFeishuMessage(msg.messageId, "replied");
        return;
      }

      const prompt = buildPrompt(msg, text, fileSections, savedFiles, imageInputs, skippedImageCount, modelSupportsImage, downloadErrors);
      const status = new TaskStatusCard(key, msg.messageId, transport);
      await status.start();
      await this.conversations.promptWithImages(key, prompt, imageInputs, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      }, status);
      await markFeishuMessage(msg.messageId, "replied");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.handler.error", { messageId: msg.messageId, error: message });
      await markFeishuMessage(msg.messageId, "failed", message);
      await this.getTransport()?.replyText(msg.messageId, `Pi error: ${message}`);
    }
  }

  private async handleCommand(msg: FeishuMessage, key: string, text: string) {
    const command = parseBotCommand(text);
    if (!command) return false;

    const transport = this.getTransport();
    if (!transport) return true;

    if (command.name === "new") {
      await this.conversations.newConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "model") {
      const models = await this.conversations.getAvailableModels();
      if (!models.length) {
        await transport.replyText(msg.messageId, "当前没有可用模型。请先在 Pi 里完成模型登录或 API Key 配置。");
        return true;
      }
      const currentModel = await this.conversations.getSelectedModel(key);
      await transport.replyCard(msg.messageId, buildModelCard(key, models, currentModel));
      return true;
    }

    if (command.name === "resume") {
      const page = await this.conversations.listResumeSessions(key, "current", 0);
      await transport.replyCard(msg.messageId, buildResumeCard(page));
      return true;
    }

    if (command.name === "stop") {
      await this.conversations.stopConversation(key, async (reply) => {
        await transport.replyText(msg.messageId, reply);
      });
      return true;
    }

    if (command.name === "workspace") {
      if (command.path) {
        await this.conversations.switchWorkspace(key, command.path, async (reply) => {
          await transport.replyText(msg.messageId, reply);
        });
      } else {
        const page = await this.conversations.listWorkspaces(key, 0);
        await transport.replyCard(msg.messageId, buildWorkspaceCard(page, this.conversations.getWorkspace(key)));
      }
      return true;
    }

    return false;
  }

  private isDuplicateContent(msg: FeishuMessage, key: string, text: string, attachments: Array<{ kind: string; fileKey: string; fileName?: string }>) {
    const now = Date.now();
    const attachmentKey = attachments.map((a) => `${a.kind}:${a.fileKey}:${a.fileName || ""}`).join("|");
    const contentKey = [key, msg.senderOpenId, normalizeForDedupe(text), attachmentKey].join("\u0000");
    const previousContentAt = this.recentContent.get(contentKey);
    if (previousContentAt && now - previousContentAt <= CONTENT_DEDUPE_TTL_MS) return true;
    this.recentContent.set(contentKey, now);
    if (this.recentContent.size > 2000) pruneRecentMap(this.recentContent, now, CONTENT_DEDUPE_TTL_MS);
    return false;
  }

  private async processAttachments(
    msg: FeishuMessage,
    attachments: Array<{ kind: "image" | "file"; fileKey: string; fileName?: string }>,
    modelSupportsImage: boolean,
    workspace: string,
  ) {
    const transport = this.getTransport();
    const imageInputs: FeishuImageInput[] = [];
    const fileSections: string[] = [];
    const savedFiles: SavedFile[] = [];
    const downloadErrors: string[] = [];
    let skippedImageCount = 0;

    for (const attachment of attachments) {
      if (attachment.kind === "image") {
        if (!modelSupportsImage) {
          skippedImageCount += 1;
          continue;
        }
        if (!transport) {
          downloadErrors.push("飞书连接不可用，图片无法下载");
          continue;
        }
        try {
          const resource = await withTimeout(
            transport.downloadImage(msg.messageId, attachment.fileKey),
            15000,
            "图片下载超时",
          );
          const mimeType = detectImageMime(resource.bytes, resource.mimeType);
          if (!isSupportedImageMime(mimeType)) {
            downloadErrors.push("图片格式暂不支持（仅支持 png/jpg/webp）");
            continue;
          }
          imageInputs.push({
            type: "image",
            data: resource.bytes.toString("base64"),
            mimeType,
          });
        } catch (error) {
          debugLog("feishu.handler.image_error", {
            messageId: msg.messageId,
            fileKey: attachment.fileKey,
            error: error instanceof Error ? error.message : String(error),
          });
          downloadErrors.push(error instanceof Error ? error.message : "图片下载失败");
        }
        continue;
      }

      const fileName = attachment.fileName || "unnamed";
      if (!transport) {
        downloadErrors.push(`飞书连接不可用，文件无法下载：${fileName}`);
        continue;
      }
      try {
        const resource = await withTimeout(
          transport.downloadMessageResource(msg.messageId, attachment.fileKey, "file"),
          FILE_DOWNLOAD_TIMEOUT_MS,
          `文件下载超时：${fileName}`,
        );
        if (resource.bytes.length > MAX_SAVED_FILE_BYTES) {
          downloadErrors.push(`文件过大（${formatBytes(resource.bytes.length)}，上限 ${formatBytes(MAX_SAVED_FILE_BYTES)}）：${fileName}`);
          continue;
        }
        const decoded = decodeTextFile(fileName, resource.bytes);
        // 小的文本/代码文件直接内联进对话；大文件或二进制文件保存到工作区，由 Pi 用工具处理
        if (isSupportedTextFile(fileName) && decoded.ok && !decoded.truncated) {
          const language = detectCodeLanguage(fileName);
          fileSections.push(`[Feishu file: ${fileName}]\n\`\`\`${language}\n${decoded.text}\n\`\`\``);
          continue;
        }
        const savedPath = saveFileToWorkspaceInbox(workspace, fileName, resource.bytes);
        debugLog("feishu.handler.file_saved", {
          messageId: msg.messageId,
          fileKey: attachment.fileKey,
          fileName,
          savedPath,
          bytes: resource.bytes.length,
        });
        savedFiles.push({ fileName, savedPath, bytes: resource.bytes.length });
      } catch (error) {
        downloadErrors.push(error instanceof Error ? error.message : `文件下载失败：${fileName}`);
      }
    }

    return { imageInputs, fileSections, savedFiles, downloadErrors, skippedImageCount };
  }
}

function buildPrompt(
  msg: FeishuMessage,
  text: string,
  fileSections: string[],
  savedFiles: SavedFile[],
  imageInputs: FeishuImageInput[],
  skippedImageCount: number,
  modelSupportsImage: boolean,
  downloadErrors: string[],
) {
  const contentParts: string[] = [];
  if (text.trim()) contentParts.push(text.trim());
  if (fileSections.length) contentParts.push(fileSections.join("\n\n"));
  if (savedFiles.length) {
    const lines = savedFiles.map(
      (file) =>
        `- 「${file.fileName}」（${formatBytes(file.bytes)}），完整文件已保存到本地：${file.savedPath}`,
    );
    contentParts.push(
      `[飞书用户发送了以下文件，已保存到当前工作区的 ${INBOX_DIR_NAME} 目录：\n${lines.join("\n")}\n请用你自己的工具（bash/读写文件等）处理这些文件，例如移动到目标位置、解压或读取。不要把整个文件内容粘贴到回复里。]`,
    );
    if (!text.trim()) {
      contentParts.push("用户没有附带文字说明，请确认已收到文件，并主动询问或按常识判断如何处理。");
    }
  }
  if (!contentParts.length && imageInputs.length) {
    contentParts.push("请根据图片内容进行分析。");
  }

  if (skippedImageCount > 0 && !modelSupportsImage) {
    contentParts.push("[提示：当前模型不支持图片，本次仅处理文本/文件内容。]");
  }

  if (downloadErrors.length) {
    contentParts.push(`[部分附件未处理：${downloadErrors.join("；")}]`);
  }

  const promptBody = contentParts.join("\n\n").trim();
  return `${conversationLabel(msg)} ${promptBody}`;
}

function sanitizeFileName(name: string) {
  const cleaned = name
    .replace(/[\\/]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/[\x00-\x1f]/g, "_")
    .trim();
  return cleaned || "unnamed";
}

function timestampPrefix(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function saveFileToWorkspaceInbox(workspace: string, fileName: string, bytes: Buffer) {
  const inboxDir = join(workspace, INBOX_DIR_NAME);
  mkdirSync(inboxDir, { recursive: true });
  // 避免收件箱里的文件污染用户的 git 状态
  const gitignorePath = join(inboxDir, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "*\n!.gitignore\n", "utf8");
  }
  const safeName = sanitizeFileName(fileName);
  const stamp = timestampPrefix();
  let candidate = join(inboxDir, `${stamp}-${safeName}`);
  for (let n = 1; existsSync(candidate); n += 1) {
    candidate = join(inboxDir, `${stamp}-${n}-${safeName}`);
  }
  writeFileSync(candidate, bytes);
  return candidate;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
