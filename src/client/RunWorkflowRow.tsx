/** Chat-panel row for the `runninghub_run_workflow` tool: shows the submitted nodeInfoList payload. */

import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import type { PropsLocale } from "@deepseek-ai/dsh-client-ui-slots";

type Props = ToolCallViewProps & PropsLocale<"settings.runninghub">;

interface RunWorkflowMeta {
  localId?: string | null;
  status?: string | null;
  workflowId?: string | null;
  label?: string | null;
  nodeInfoList?: unknown;
  assignedMedia?: unknown;
}

const ACCENT: Record<string, string> = {
  ok: "#2e7d32",
  error: "#c62828",
  running: "#1976d2",
};

export function RunWorkflowRow({ block, t }: Props) {
  const settled = "kind" in block;
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? "";
  let args: { workflow?: string; overrides?: unknown } = {};
  try {
    const parsed = JSON.parse(argsRaw) as unknown;
    if (typeof parsed === "object" && parsed !== null)
      args = parsed as { workflow?: string; overrides?: unknown };
  } catch {
    args = {};
  }
  const meta = (settled ? block.meta : undefined) as
    | RunWorkflowMeta
    | undefined;
  const state = !settled ? "running" : block.isError ? "error" : "ok";
  const label = meta?.label ?? args.workflow ?? t("toolviewUnknownWorkflow");
  const nodeInfoList = meta?.nodeInfoList;
  const hasPayload = nodeInfoList !== null && nodeInfoList !== undefined;

  return (
    <div
      data-tool="runninghub_run_workflow"
      data-state={state}
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        padding: "8px 12px",
        borderLeft: `3px solid ${ACCENT[state] ?? "#888"}`,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <strong>
          {t("toolviewTitle")} · {label}
        </strong>
        <span style={{ opacity: 0.65 }}>{state}</span>
      </div>
      {meta?.localId !== null && meta?.localId !== undefined ? (
        <div style={{ opacity: 0.7 }}>
          {t("toolviewLocalId")}: {meta.localId}
          {meta.status !== null && meta.status !== undefined
            ? ` · ${meta.status}`
            : ""}
        </div>
      ) : null}
      {hasPayload ? (
        <pre
          style={{
            margin: "6px 0 0",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 260,
            overflow: "auto",
          }}
        >
          {JSON.stringify(nodeInfoList, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

export default RunWorkflowRow;
