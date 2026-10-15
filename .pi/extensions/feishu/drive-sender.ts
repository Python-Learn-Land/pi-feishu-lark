import { open } from "node:fs/promises";
import { basename } from "node:path";
import { join } from "node:path";
import { ROOT_DIR, readJson, writeJson } from "./config.js";
import { debugLog } from "./debug.js";
import { formatBytes, getFeishuApiClient, resolveRoute, sendTextToSessionRoute } from "./file-sender.js";

/**
 * 大文件走飞书云文档（Drive）分片上传：纯出站调用，不需要主机有公网 IP，
 * 文件存到飞书云端，大小只受租户云文档配额限制（远大于 IM 的 30MB）。
 *
 * 需要应用有 drive:drive 权限。扫码创建的应用默认没有，需要在开发者后台
 * 手动添加并发布版本；缺失时会抛出带指引的错误。
 *
 * 流程：uploadPrepare → uploadPart × N（4MB 分片，接口限流 5QPS，串行即可）
 * → uploadFinish 拿 file_token → 授权 → meta.batchQuery(with_url) 拿带租户域名的链接。
 */

const DRIVE_CACHE_PATH = join(ROOT_DIR, "drive.json");
const SCOPE_HINT =
  "需要在飞书开发者后台给应用添加 drive:drive 权限并发布版本（权限管理 → 搜索 drive:drive → 开通，然后创建版本发布）";

type DriveCache = { rootFolderToken?: string };

export type DriveSendResult = {
  fileName: string;
  bytes: number;
  fileToken: string;
  url?: string;
  access: "owner" | "full" | "tenant" | "none";
};

export async function sendLargeFileViaDrive(sessionId: string, filePath: string): Promise<DriveSendResult> {
  const route = resolveRoute(sessionId);
  const fileName = basename(filePath);
  const { fileToken, bytes } = await uploadToDrive(filePath, fileName);
  // 先拿链接：转移所有权后应用可能失去元数据读取权限，meta 查询会失败
  const url = await getDriveFileUrl(fileToken);
  const access = await grantAccess(fileToken, route.senderOpenId);

  const linkText = url || `文件 token：${fileToken}（获取链接失败，可在飞书“云文档-我收到的”里查找）`;
  await sendTextToSessionRoute(
    sessionId,
    `📎 ${fileName}（${formatBytes(bytes)}）\n文件较大，已上传到飞书云文档：\n${linkText}`,
  );
  return { fileName, bytes, fileToken, url, access };
}

async function uploadToDrive(filePath: string, fileName: string): Promise<{ fileToken: string; bytes: number }> {
  const client = await getFeishuApiClient();
  const folderToken = await getRootFolderToken(client);

  const fh = await open(filePath, "r");
  try {
    const stat = await fh.stat();
    const size = stat.size;
    debugLog("feishu.drive_upload.prepare", { fileName, size });

    const prepare = await client.drive.v1.file.uploadPrepare({
      data: { file_name: fileName, parent_type: "explorer", parent_node: folderToken, size },
    });
    checkApiResult(prepare, "预上传");
    const uploadId = prepare?.data?.upload_id;
    const blockSize = prepare?.data?.block_size || 4 * 1024 * 1024;
    const blockNum = prepare?.data?.block_num ?? Math.ceil(size / blockSize);
    if (!uploadId) throw new Error(`预上传未返回 upload_id：${preview(prepare)}`);

    const buffer = Buffer.allocUnsafe(blockSize);
    for (let seq = 0; seq < blockNum; seq += 1) {
      const offset = seq * blockSize;
      const { bytesRead } = await fh.read(buffer, 0, Math.min(blockSize, size - offset), offset);
      const chunk = bytesRead === blockSize ? buffer : buffer.subarray(0, bytesRead);
      // uploadPart 返回体无 data，SDK 在 HTTP 错误时会直接抛异常
      await client.drive.v1.file.uploadPart({
        data: { upload_id: uploadId, seq, size: bytesRead, file: chunk },
      });
      debugLog("feishu.drive_upload.part", { fileName, seq, blockNum, bytes: bytesRead });
    }

    const finish = await client.drive.v1.file.uploadFinish({
      data: { upload_id: uploadId, block_num: blockNum },
    });
    checkApiResult(finish, "完成上传");
    const fileToken = finish?.data?.file_token;
    if (!fileToken) throw new Error(`完成上传未返回 file_token：${preview(finish)}`);
    debugLog("feishu.drive_upload.done", { fileName, size, fileToken });
    return { fileToken, bytes: size };
  } catch (error) {
    throw enrichDriveError(error);
  } finally {
    await fh.close();
  }
}

/**
 * 授权策略（按发送者身份逐级尝试）：
 * 1. 授予发送者 full_access（可管理），然后把所有者转移给发送者，
 *    文件进入对方“我的空间”，对方拥有完全控制权；
 * 2. 转移失败则保留 full_access（可管理，能删能改能分享）；
 * 3. 连授权都失败时降级为“租户内获得链接可阅读”。
 */
async function grantAccess(fileToken: string, senderOpenId?: string): Promise<"owner" | "full" | "tenant" | "none"> {
  const client = await getFeishuApiClient();
  if (senderOpenId) {
    let granted = false;
    try {
      const result = await client.drive.v1.permission.member.create({
        path: { token: fileToken },
        params: { type: "file", need_notification: false },
        data: { member_type: "openid", member_id: senderOpenId, perm: "full_access" },
      });
      checkApiResult(result, "授权给发送者");
      granted = true;
    } catch (error) {
      debugLog("feishu.drive_upload.grant_sender_failed", { fileToken, error: String(error instanceof Error ? error.message : error) });
    }
    if (granted) {
      try {
        const transferred = await client.drive.v1.permission.member.transferOwner({
          path: { token: fileToken },
          params: { type: "file", need_notification: false, remove_old_owner: true },
          data: { member_type: "openid", member_id: senderOpenId },
        });
        checkApiResult(transferred, "转移所有者");
        return "owner";
      } catch (error) {
        debugLog("feishu.drive_upload.transfer_failed", { fileToken, error: String(error instanceof Error ? error.message : error) });
        return "full";
      }
    }
  }
  try {
    const result = await client.drive.v1.permission.public.patch({
      path: { token: fileToken },
      params: { type: "file" },
      data: { link_share_entity: "tenant_readable" },
    });
    checkApiResult(result, "设置链接分享权限");
    return "tenant";
  } catch (error) {
    debugLog("feishu.drive_upload.grant_tenant_failed", { fileToken, error: String(error instanceof Error ? error.message : error) });
    return "none";
  }
}

async function getDriveFileUrl(fileToken: string): Promise<string | undefined> {
  try {
    const client = await getFeishuApiClient();
    const meta = await client.drive.v1.meta.batchQuery({
      data: { request_docs: [{ doc_token: fileToken, doc_type: "file" }], with_url: true },
    });
    const url = meta?.data?.metas?.[0]?.url;
    if (typeof url === "string" && url) return url;
  } catch (error) {
    debugLog("feishu.drive_upload.meta_failed", { fileToken, error: String(error instanceof Error ? error.message : error) });
  }
  return undefined;
}

/** 应用云文档根目录 token，缓存在 ~/.pi/agent/feishu/drive.json（不会变化）。 */
async function getRootFolderToken(client: any): Promise<string> {
  const cache = readJson<DriveCache>(DRIVE_CACHE_PATH, {});
  if (cache.rootFolderToken) return cache.rootFolderToken;

  const res = await client.request({ url: "/open-apis/drive/explorer/v2/root_folder/meta", method: "GET" });
  const token = res?.data?.token ?? res?.token;
  if (!token) {
    throw enrichDriveError(new Error(`获取云文档根目录失败：${preview(res)}`));
  }
  writeJson(DRIVE_CACHE_PATH, { rootFolderToken: token } satisfies DriveCache);
  return token;
}

function checkApiResult(result: any, step: string) {
  if (result && typeof result === "object" && "code" in result && result.code !== 0) {
    throw new Error(`${step}失败（code=${result.code}）：${result.msg || "未知错误"}`);
  }
}

/** 识别权限类错误并附加开通指引。 */
function enrichDriveError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const permissionLike = /99991663|99991672|99991679|1061002|forbidden|permission|scope|权限/i.test(raw);
  const message = permissionLike ? `${raw}。${SCOPE_HINT}` : raw;
  const enriched = new Error(`云文档上传失败：${message}`);
  (enriched as any).cause = error;
  return enriched;
}

function preview(value: unknown) {
  try {
    return JSON.stringify(value)?.slice(0, 200);
  } catch {
    return "";
  }
}
