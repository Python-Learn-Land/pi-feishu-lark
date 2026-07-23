export function modelLabel(model: any) {
  if (!model) return "未选择";
  return `${model.provider}/${model.id}`;
}

export type ResumeScope = "current" | "all";

export type ResumeSessionItem = {
  path: string;
  title: string;
  subtitle: string;
  modifiedLabel: string;
  workspaceLabel?: string;
  isCurrent: boolean;
};

export type ResumeSessionPage = {
  key: string;
  scope: ResumeScope;
  page: number;
  total: number;
  totalPages: number;
  items: ResumeSessionItem[];
};

export type WorkspaceItem = {
  cwd: string;
  label: string;
  modifiedLabel: string;
  isCurrent: boolean;
};

export type WorkspacePage = {
  key: string;
  page: number;
  total: number;
  totalPages: number;
  items: WorkspaceItem[];
};

export function buildModelCard(key: string, models: any[], currentModel: any) {
  const current = modelLabel(currentModel);
  const elements: any[] = [
    {
      tag: "markdown",
      content: `当前模型：**${current}**\n点击下面的按钮即可切换当前飞书会话使用的模型。`,
    },
  ];

  const rows: any[][] = [];
  for (let i = 0; i < models.length; i += 2) {
    rows.push(models.slice(i, i + 2));
  }

  for (const row of rows) {
    elements.push({
      tag: "action",
      actions: row.map((model) => {
        const isCurrent = currentModel?.provider === model.provider && currentModel?.id === model.id;
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: `${isCurrent ? "当前 " : ""}${model.provider}/${model.id}`,
          },
          type: isCurrent ? "primary" : "default",
          value: {
            action: "pi_feishu_select_model",
            key,
            provider: model.provider,
            modelId: model.id,
          },
        };
      }),
    });
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "选择 Pi 模型" },
    },
    elements,
  };
}

export function buildResumeCard(data: ResumeSessionPage) {
  const scopeLabel = data.scope === "current" ? "当前项目" : "全部会话";
  const elements: any[] = [
    {
      tag: "markdown",
      content: [
        `当前视图：**${scopeLabel}**`,
        data.total
          ? `第 **${data.page + 1} / ${data.totalPages}** 页，共 **${data.total}** 条历史会话。`
          : "还没有可切换的历史会话。",
        "点击某条会话后，当前飞书对话会继续接着这条 Pi 会话往下聊。",
      ].join("\n"),
    },
  ];

  elements.push({
    tag: "action",
    actions: [
      buildResumeScopeButton(data.key, "current", data.scope === "current"),
      buildResumeScopeButton(data.key, "all", data.scope === "all"),
    ],
  });

  for (const item of data.items) {
    const lines = [
      `**${escapeMarkdown(item.title)}**${item.isCurrent ? " `当前使用中`" : ""}`,
      escapeMarkdown(item.subtitle),
      `更新时间：${escapeMarkdown(item.modifiedLabel)}`,
    ];
    if (item.workspaceLabel) lines.push(`工作区：${escapeMarkdown(item.workspaceLabel)}`);
    elements.push({
      tag: "markdown",
      content: lines.join("\n"),
    });
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: item.isCurrent ? "当前会话" : "切换到这条会话",
        },
        type: item.isCurrent ? "primary" : "default",
        value: {
          action: "pi_feishu_resume_select",
          key: data.key,
          scope: data.scope,
          page: data.page,
          sessionPath: item.path,
        },
      }],
    });
  }

  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "上一页" },
        type: "default",
        disabled: data.page <= 0,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.max(0, data.page - 1),
        },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "下一页" },
        type: "default",
        disabled: data.page >= data.totalPages - 1,
        value: {
          action: "pi_feishu_resume_page",
          key: data.key,
          scope: data.scope,
          page: Math.min(Math.max(0, data.totalPages - 1), data.page + 1),
        },
      },
    ],
  });

  return {
    config: sharedCardConfig(),
    header: {
      template: "turquoise",
      title: { tag: "plain_text", content: "切换 Pi 历史会话" },
    },
    elements,
  };
}

export function parseModelActionValue(value: unknown): { key: string; provider: string; modelId: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_select_model") return undefined;
  if (typeof raw.key !== "string" || typeof raw.provider !== "string" || typeof raw.modelId !== "string") return undefined;
  return { key: raw.key, provider: raw.provider, modelId: raw.modelId };
}

export function parseResumePageActionValue(value: unknown): { key: string; scope: ResumeScope; page: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_page") return undefined;
  if (typeof raw.key !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return { key: raw.key, scope: raw.scope, page: Math.max(0, Math.floor(raw.page)) };
}

export function parseResumeSelectActionValue(value: unknown): { key: string; scope: ResumeScope; page: number; sessionPath: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_resume_select") return undefined;
  if (typeof raw.key !== "string" || typeof raw.sessionPath !== "string") return undefined;
  if (raw.scope !== "current" && raw.scope !== "all") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return {
    key: raw.key,
    scope: raw.scope,
    page: Math.max(0, Math.floor(raw.page)),
    sessionPath: raw.sessionPath,
  };
}
export function buildWorkspaceCard(data: WorkspacePage, currentWorkspace: string) {
  const elements: any[] = [
    {
      tag: "markdown",
      content: [
        `当前工作区：**${escapeMarkdown(currentWorkspace)}**`,
        data.total
          ? `第 **${data.page + 1} / ${data.totalPages}** 页，共 **${data.total}** 个项目。`
          : "还没有可选工作区。请用 `/workspace /绝对路径` 手动指定。",
        "点击下面的按钮即可把当前飞书会话切换到对应工作区。",
      ].join("\n"),
    },
  ];

  for (const item of data.items) {
    elements.push({
      tag: "markdown",
      content: [
        `**${escapeMarkdown(item.label)}**${item.isCurrent ? " `当前使用中`" : ""}`,
        `最后使用：${escapeMarkdown(item.modifiedLabel)}`,
      ].join("\n"),
    });
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: {
          tag: "plain_text",
          content: item.isCurrent ? "当前工作区" : "切换到这里",
        },
        type: item.isCurrent ? "primary" : "default",
        value: {
          action: "pi_feishu_workspace_select",
          key: data.key,
          page: data.page,
          workspace: item.cwd,
        },
      }],
    });
  }

  if (data.total) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "上一页" },
          type: "default",
          disabled: data.page <= 0,
          value: {
            action: "pi_feishu_workspace_page",
            key: data.key,
            page: Math.max(0, data.page - 1),
          },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "下一页" },
          type: "default",
          disabled: data.page >= data.totalPages - 1,
          value: {
            action: "pi_feishu_workspace_page",
            key: data.key,
            page: Math.min(Math.max(0, data.totalPages - 1), data.page + 1),
          },
        },
      ],
    });
  }

  return {
    config: sharedCardConfig(),
    header: {
      template: "wathet",
      title: { tag: "plain_text", content: "切换 Pi 工作区" },
    },
    elements,
  };
}

export function parseWorkspacePageActionValue(value: unknown): { key: string; page: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_workspace_page") return undefined;
  if (typeof raw.key !== "string") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return { key: raw.key, page: Math.max(0, Math.floor(raw.page)) };
}

export function parseWorkspaceSelectActionValue(value: unknown): { key: string; page: number; workspace: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.action !== "pi_feishu_workspace_select") return undefined;
  if (typeof raw.key !== "string" || typeof raw.workspace !== "string") return undefined;
  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) return undefined;
  return {
    key: raw.key,
    page: Math.max(0, Math.floor(raw.page)),
    workspace: raw.workspace,
  };
}

function buildResumeScopeButton(key: string, scope: ResumeScope, active: boolean) {
  return {
    tag: "button",
    text: {
      tag: "plain_text",
      content: scope === "current" ? "当前项目" : "全部会话",
    },
    type: active ? "primary" : "default",
    value: {
      action: "pi_feishu_resume_page",
      key,
      scope,
      page: 0,
    },
  };
}

function escapeMarkdown(text: string) {
  return text.replace(/[`*_~]/g, "\\$&");
}

function sharedCardConfig() {
  return {
    wide_screen_mode: true,
    update_multi: true,
  };
}
