import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { basename } from "node:path";
import { debugLog } from "./debug.js";

/**
 * 绕过飞书 im/v1/files 30MB 上传限制的临时下载服务。
 *
 * 按需懒启动：只有第一次需要发大文件时才会监听端口。
 * 安全性：128 位随机 token 路径、默认 30 分钟过期、只服务显式登记过的文件、
 * 无目录列表。可用环境变量配置：
 * - FEISHU_FILE_SERVER_PORT：监听端口，默认 3002
 * - FEISHU_FILE_SERVER_BASE：链接对外的基础 URL（如 https://files.example.com
 *   或 http://1.2.3.4:3002），未配置时自动取本机局域网 IP
 * - FEISHU_FILE_LINK_TTL_MIN：链接有效期（分钟），默认 30
 */

const DEFAULT_PORT = 3002;
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const TOKEN_PATTERN = /^\/f\/([a-f0-9]{32})(?:\/[^/]*)?\/?$/;

type ServedFile = {
  path: string;
  fileName: string;
  size: number;
  expiresAt: number;
};

export type FileLink = {
  url: string;
  fileName: string;
  size: number;
  expiresAt: number;
  ttlMs: number;
};

let server: Server | undefined;
let boundPort: number | undefined;
let sweepTimer: NodeJS.Timeout | undefined;
const servedFiles = new Map<string, ServedFile>();

export async function createFileLink(filePath: string): Promise<FileLink> {
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error(`不是普通文件，无法生成下载链接：${filePath}`);
  if (stat.size <= 0) throw new Error("不能发送空文件");

  await ensureServer();
  const token = randomBytes(16).toString("hex");
  const ttlMs = linkTtlMs();
  const entry: ServedFile = {
    path: filePath,
    fileName: basename(filePath),
    size: stat.size,
    expiresAt: Date.now() + ttlMs,
  };
  servedFiles.set(token, entry);
  const url = `${publicBaseUrl()}/f/${token}/${encodeURIComponent(entry.fileName)}`;
  debugLog("feishu.file_server.link_created", { fileName: entry.fileName, size: stat.size, ttlMs, url });
  return { url, fileName: entry.fileName, size: stat.size, expiresAt: entry.expiresAt, ttlMs };
}

export function fileServerBaseUrl() {
  return publicBaseUrl();
}

function ensureServer(): Promise<void> {
  if (server) return Promise.resolve();
  const port = parsePortEnv(process.env.FEISHU_FILE_SERVER_PORT) ?? DEFAULT_PORT;
  return new Promise((resolvePromise, rejectPromise) => {
    const created = createServer(handleRequest);
    created.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        rejectPromise(new Error(`文件下载服务端口 ${port} 被占用，请配置 FEISHU_FILE_SERVER_PORT 换一个端口`));
        return;
      }
      rejectPromise(error);
    });
    created.listen(port, () => {
      server = created;
      boundPort = port;
      server.unref?.();
      sweepTimer = setInterval(sweepExpired, 60_000);
      sweepTimer.unref?.();
      debugLog("feishu.file_server.started", { port, baseUrl: publicBaseUrl() });
      resolvePromise();
    });
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse) {
  sweepExpired();
  const match = TOKEN_PATTERN.exec(req.url || "");
  const token = match?.[1];
  const entry = token ? servedFiles.get(token) : undefined;
  if (!token || !entry) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  if (entry.expiresAt < Date.now()) {
    servedFiles.delete(token);
    res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Link expired");
    return;
  }
  let stat;
  try {
    stat = statSync(entry.path);
  } catch {
    servedFiles.delete(token);
    res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("File no longer available");
    return;
  }
  debugLog("feishu.file_server.download", { fileName: entry.fileName, size: stat.size });
  res.writeHead(200, {
    "Content-Type": "application/octet-stream",
    "Content-Length": stat.size,
    "Content-Disposition": contentDisposition(entry.fileName),
    "Cache-Control": "no-store",
  });
  createReadStream(entry.path).pipe(res);
}

function sweepExpired() {
  const now = Date.now();
  for (const [token, entry] of servedFiles) {
    if (entry.expiresAt < now) servedFiles.delete(token);
  }
}

function contentDisposition(fileName: string) {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_") || "file";
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function linkTtlMs() {
  const minutes = Number.parseInt(process.env.FEISHU_FILE_LINK_TTL_MIN || "", 10);
  if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  return DEFAULT_TTL_MS;
}

function publicBaseUrl() {
  const configured = process.env.FEISHU_FILE_SERVER_BASE?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `http://${detectLanAddress()}:${boundPort ?? parsePortEnv(process.env.FEISHU_FILE_SERVER_PORT) ?? DEFAULT_PORT}`;
}

function detectLanAddress() {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const item of list || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      addresses.push(item.address);
    }
  }
  // 优先常见私网网段，公网 IP 其次
  const score = (ip: string) => {
    if (ip.startsWith("192.168.")) return 0;
    if (ip.startsWith("10.")) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  addresses.sort((a, b) => score(a) - score(b));
  return addresses[0] || "127.0.0.1";
}

function parsePortEnv(value: string | undefined) {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return undefined;
  return port;
}
