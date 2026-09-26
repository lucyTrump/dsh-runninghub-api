/** RunningHub configuration form, registered into the `plugins.bundle.config` slot. */

import { useEffect, useRef, useState } from "react";
import {
  Button,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconCopyOutline16,
  IconLightOutline16,
  IconSparkle16,
  Switch,
  Tag,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { ModelCatalog } from "@deepseek-ai/dsh-api-remotes/client";
import type { RemoteResult } from "@deepseek-ai/dsh-typert-protocol";
import type {
  DescribeWorkflowData,
  DescribeWorkflowRequest,
  FetchWorkflowData,
  FetchWorkflowRequest,
  JsonValue,
  NodeParamOverride,
  RunTestData,
  RunTestRequest,
  ValidateWorkflowData,
  ValidateWorkflowRequest,
  WorkflowDefinition,
} from "../types.ts";
import { carryUserMarks } from "../payload.ts";
import { PluginCard } from "./PluginCard.tsx";
import { SecretField, ValueField } from "./fields.tsx";
import type { RunningHubCardFace } from "./runninghub-card-controller.ts";
import css from "./RunningHubCard.module.css";

/** Remote calls the card issues straight to the host (not staged in the form). */
export interface RunningHubCardRemote {
  fetchWorkflow: (
    request: FetchWorkflowRequest,
  ) => Promise<RemoteResult<FetchWorkflowData>>;
  testConnection: () => Promise<RemoteResult<boolean>>;
  validateWorkflow: (
    request: ValidateWorkflowRequest,
  ) => Promise<RemoteResult<ValidateWorkflowData>>;
  runTest: (request: RunTestRequest) => Promise<RemoteResult<RunTestData>>;
  describeWorkflow: (
    request: DescribeWorkflowRequest,
  ) => Promise<RemoteResult<DescribeWorkflowData>>;
  /** Host-generation model catalog (provider groups + models + default route). */
  modelCatalog: () => Promise<RemoteResult<ModelCatalog>>;
}

/** The slot entry's injected face: the card controller's actions plus remotes. */
export interface RunningHubCardSlotFace extends RunningHubCardFace {
  remote: RunningHubCardRemote;
}

/**
 * Slot props. The Plugins page asks a bundle's own form for the `page` view
 * only (a bundle's one-liner is the package description), so `view` is not
 * branched on here.
 */
export type RunningHubCardProps = PropsRuntime<"plugins.bundle.config"> &
  PropsLocale<"settings.runninghub"> &
  InjectFace<RunningHubCardSlotFace>;

interface Status {
  kind: "ok" | "error";
  text: string;
}

export function RunningHubCard(props: RunningHubCardProps) {
  const { t, remote } = props;
  const state = props.useRunningHubCard((s) => s);
  const workflows = state.workflows;

  const [workflowId, setWorkflowId] = useState("");
  const [workflowLabel, setWorkflowLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [validations, setValidations] = useState<
    Record<string, ValidateWorkflowData>
  >({});
  // Params area is collapsed by default per workflow; keyed by workflow key.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;
  // Model catalog for the description-model picker; loaded on first open.
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (
        pickerRef.current !== null &&
        !pickerRef.current.contains(event.target as Node)
      ) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [pickerOpen]);

  // describeModel is stored as "provider/model"; '' = the agent default model.
  const describeModelText = state.describeModel.text;
  const slashIndex = describeModelText.indexOf("/");
  const describeProvider =
    slashIndex > 0 ? describeModelText.slice(0, slashIndex) : "";
  const describeModelId =
    slashIndex > 0 ? describeModelText.slice(slashIndex + 1) : "";
  const editDescribeModel = (provider: string, model: string): void => {
    props.edit("describeModel", provider === "" ? "" : `${provider}/${model}`);
  };
  const describeSelectionLabel = (() => {
    if (describeProvider === "") {
      if (catalog !== null)
        return t("describeModelDefaultOf", {
          model: `${catalog.default.provider}/${catalog.default.model}`,
        });
      return t("describeModelDefault");
    }
    const group = catalog?.groups.find(
      (candidate) => candidate.id === describeProvider,
    );
    const model = group?.models.find(
      (candidate) => candidate.id === describeModelId,
    );
    return group !== undefined && model !== undefined
      ? `${group.name} / ${model.name}`
      : describeModelText;
  })();
  const openPicker = (): void => {
    setPickerOpen((open) => !open);
    if (catalog === null) {
      void remote.modelCatalog().then((result) => {
        if (result.ok) setCatalog(result.value);
      });
    }
  };

  const copyWorkflowId = async (key: string, id: string): Promise<void> => {
    await navigator.clipboard.writeText(id);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1500);
  };

  const disabled = !state.writable || state.saving;

  const setWorkflows = (next: WorkflowDefinition[]): void => {
    props.stageWorkflows(next);
  };

  const updateWorkflow = (
    index: number,
    patch: Partial<WorkflowDefinition>,
  ): void => {
    const current = workflows[index];
    if (current === undefined) return;
    const next = workflows.slice();
    next[index] = { ...current, ...patch } as WorkflowDefinition;
    setWorkflows(next);
  };

  const toggleAttention = (wfIndex: number, paramIndex: number): void => {
    const workflow = workflows[wfIndex];
    if (workflow === undefined) return;
    const param = workflow.nodeDefaults[paramIndex];
    if (param === undefined) return;
    const nodeDefaults = workflow.nodeDefaults.slice();
    const next = { ...param };
    if (next.attention === true) delete next.attention;
    else next.attention = true;
    nodeDefaults[paramIndex] = next;
    updateWorkflow(wfIndex, { nodeDefaults });
  };

  const toggleMediaAttention = (wfIndex: number, slotIndex: number): void => {
    const workflow = workflows[wfIndex];
    if (workflow === undefined) return;
    const slot = workflow.mediaSlots[slotIndex];
    if (slot === undefined) return;
    const mediaSlots = workflow.mediaSlots.slice();
    const next = { ...slot };
    if (next.attention === true) delete next.attention;
    else next.attention = true;
    mediaSlots[slotIndex] = next;
    updateWorkflow(wfIndex, { mediaSlots });
  };

  const updateParam = (
    wfIndex: number,
    paramIndex: number,
    fieldValue: JsonValue | undefined,
  ): void => {
    const workflow = workflows[wfIndex];
    if (workflow === undefined) return;
    const param = workflow.nodeDefaults[paramIndex];
    if (param === undefined) return;
    const nodeDefaults = workflow.nodeDefaults.slice();
    const next = { ...param };
    // undefined clears the default (buildNodeInfoList skips empty values).
    if (fieldValue === undefined) delete next.fieldValue;
    else next.fieldValue = fieldValue;
    nodeDefaults[paramIndex] = next;
    updateWorkflow(wfIndex, { nodeDefaults });
  };

  const doTestConnection = async (): Promise<void> => {
    setBusy("test");
    setStatus(null);
    const result = await remote.testConnection();
    if (result.ok) setStatus({ kind: "ok", text: t("testConnectionOk") });
    else
      setStatus({
        kind: "error",
        text: `${t("testConnectionFail")}: ${result.error.message}`,
      });
    setBusy(null);
  };

  const doFetch = async (): Promise<void> => {
    const id = workflowId.trim();
    if (id === "") return;
    setBusy("fetch");
    setStatus(null);
    const result = await remote.fetchWorkflow({ workflowId: id });
    if (!result.ok) {
      setStatus({
        kind: "error",
        text: `${t("fetchedFail")}: ${result.error.message}`,
      });
      setBusy(null);
      return;
    }
    const data = result.value;
    const workflow: WorkflowDefinition = {
      label: workflowLabel.trim() || id,
      workflowId: id,
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      fetchedAt: new Date().toISOString(),
      nodeDefaults: data.nodeDefaults ?? [],
      mediaSlots: data.mediaSlots ?? [],
    };
    setWorkflows([...workflows, workflow]);
    setStatus({
      kind: "ok",
      text: t("fetchedOk", {
        nodes: data.nodes?.length ?? 0,
        params: workflow.nodeDefaults.length,
        media: workflow.mediaSlots.length,
      }),
    });
    setWorkflowId("");
    setWorkflowLabel("");
    setBusy(null);
    // Best-effort: ask the host to summarize the workflow with the default
    // model and fill the description when it is still empty.
    void fillDescription(workflows.length, workflow);
  };

  const fillDescription = async (
    addedIndex: number,
    workflow: WorkflowDefinition,
  ): Promise<void> => {
    const result = await remote
      .describeWorkflow({ workflow })
      .catch(() => undefined);
    if (result === undefined || !result.ok) return;
    const latest = workflowsRef.current;
    const target = latest[addedIndex];
    if (target === undefined || target.workflowId !== workflow.workflowId)
      return;
    // Auto-fill never clobbers text the user already typed.
    const fillText =
      target.description === undefined || target.description === "";
    if (
      fillText &&
      result.value.description === "" &&
      result.value.attention === undefined
    )
      return;
    const next = latest.slice();
    next[addedIndex] = applyAnalysis(target, result.value, fillText);
    setWorkflows(next);
  };

  const doValidate = async (index: number): Promise<void> => {
    const workflow = workflows[index];
    if (workflow === undefined) return;
    const key = `${workflow.workflowId}:${index}`;
    setBusy(`validate:${key}`);
    const result = await remote.validateWorkflow({ workflow });
    setValidations((prev: any) => ({
      ...prev,
      [key]: result.ok ? result.value : { nodeInfoList: [] },
    }));
    setStatus(
      result.ok
        ? { kind: "ok", text: t("validationOk") }
        : {
            kind: "error",
            text: `${t("validationFailed")}: ${result.error.message}`,
          },
    );
    setBusy(null);
  };

  /** Manually (re)generate one saved workflow's description with the LLM. */
  const doDescribe = async (index: number): Promise<void> => {
    const workflow = workflows[index];
    if (workflow === undefined) return;
    const key = `${workflow.workflowId}:${index}`;
    setBusy(`describe:${key}`);
    try {
      const result = await remote.describeWorkflow({ workflow });
      if (!result.ok) {
        setStatus({
          kind: "error",
          text: `${t("describeFailed")}: ${result.error.message}`,
        });
        return;
      }
      const current = workflows[index];
      if (current !== undefined)
        updateWorkflow(index, applyAnalysis(current, result.value, true));
    } catch (error) {
      // A synchronous throw in the remote wiring (or a transport failure)
      // rejects the promise — surface it instead of sticking the spinner.
      setStatus({
        kind: "error",
        text: `${t("describeFailed")}: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const doRefresh = async (index: number): Promise<void> => {
    const workflow = workflows[index];
    if (workflow === undefined) return;
    setBusy(`refresh:${index}`);
    setStatus(null);
    const result = await remote.fetchWorkflow({
      workflowId: workflow.workflowId,
    });
    if (!result.ok) {
      setStatus({
        kind: "error",
        text: `${t("fetchedFail")}: ${result.error.message}`,
      });
      setBusy(null);
      return;
    }
    const data = result.value;
    // Merge, not overwrite: the fetched prompt carries no ★ attention / *
    // required / custom labels, so replacing the lists wholesale would clear
    // every hand-set mark on the workflow being refreshed.
    updateWorkflow(index, {
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      fetchedAt: new Date().toISOString(),
      nodeDefaults: data.nodeDefaults === undefined
        ? workflow.nodeDefaults
        : carryUserMarks(workflow.nodeDefaults, data.nodeDefaults),
      mediaSlots: data.mediaSlots === undefined
        ? workflow.mediaSlots
        : carryUserMarks(workflow.mediaSlots, data.mediaSlots),
    });
    setStatus({
      kind: "ok",
      text: t("fetchedOk", {
        nodes: data.nodes?.length ?? 0,
        params: data.nodeDefaults?.length ?? 0,
        media: data.mediaSlots?.length ?? 0,
      }),
    });
    setBusy(null);
  };

  const doRunTest = async (index: number): Promise<void> => {
    const workflow = workflows[index];
    if (workflow === undefined) return;
    // A real test run submits a PAID task on RunningHub — confirm first.
    if (!window.confirm(t("testRunConfirm", { label: workflow.label }))) return;
    setBusy(`test:${index}`);
    setStatus(null);
    const result = await remote.runTest({ workflow });
    if (!result.ok) {
      setStatus({
        kind: "error",
        text: `${t("testRunFail")}: ${result.error.message}`,
      });
      setBusy(null);
      return;
    }
    setStatus({
      kind: "ok",
      text: t("testRunOk", {
        localId: result.value.localId,
        status: result.value.status,
      }),
    });
    setBusy(null);
  };

  const doDelete = (index: number): void => {
    const next = workflows.slice();
    next.splice(index, 1);
    setWorkflows(next);
  };

  return (
    <PluginCard
      t={t}
      titleKey="title"
      descriptionKey="description"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SecretField
        id="runninghub-apiKey"
        label={t("apiKey")}
        hint={t("apiKeyHint")}
        text={state.apiKey.text}
        configured={state.apiKeyConfigured}
        stateLabel={t(
          state.apiKeyConfigured ? "apiKeyConfigured" : "apiKeyUnset",
        )}
        disabled={disabled || !state.apiKeyWritable}
        onEdit={(text) => {
          props.edit("apiKey", text);
        }}
      />
      <ValueField
        id="runninghub-apiKeyEnv"
        label={t("apiKeyEnv")}
        hint={t("apiKeyEnvHint")}
        text={state.apiKeyEnv.text}
        overridden={state.apiKeyEnv.overridden}
        invalid={state.apiKeyEnv.invalid}
        overriddenLabel={t("overridden")}
        resetLabel={t("reset")}
        invalidLabel={t("invalidNumber")}
        placeholder="RUNNINGHUB_API_KEY"
        disabled={disabled}
        onEdit={(text) => {
          props.edit("apiKeyEnv", text);
        }}
        onReset={() => {
          props.resetField("apiKeyEnv");
        }}
      />
      <ValueField
        id="runninghub-baseUrl"
        label={t("baseUrl")}
        hint={t("baseUrlHint")}
        text={state.baseUrl.text}
        overridden={state.baseUrl.overridden}
        invalid={state.baseUrl.invalid}
        overriddenLabel={t("overridden")}
        resetLabel={t("reset")}
        invalidLabel={t("invalidNumber")}
        disabled={disabled}
        onEdit={(text) => {
          props.edit("baseUrl", text);
        }}
        onReset={() => {
          props.resetField("baseUrl");
        }}
      />
      <ValueField
        id="runninghub-pollIntervalMs"
        label={t("pollIntervalMs")}
        hint={t("pollIntervalMsHint")}
        text={state.pollIntervalMs.text}
        overridden={state.pollIntervalMs.overridden}
        invalid={state.pollIntervalMs.invalid}
        overriddenLabel={t("overridden")}
        resetLabel={t("reset")}
        invalidLabel={t("invalidNumber")}
        numeric
        disabled={disabled}
        onEdit={(text) => {
          props.edit("pollIntervalMs", text);
        }}
        onReset={() => {
          props.resetField("pollIntervalMs");
        }}
      />
      <ValueField
        id="runninghub-runTimeoutMs"
        label={t("runTimeoutMs")}
        hint={t("runTimeoutMsHint")}
        text={state.runTimeoutMs.text}
        overridden={state.runTimeoutMs.overridden}
        invalid={state.runTimeoutMs.invalid}
        overriddenLabel={t("overridden")}
        resetLabel={t("reset")}
        invalidLabel={t("invalidNumber")}
        numeric
        disabled={disabled}
        onEdit={(text) => {
          props.edit("runTimeoutMs", text);
        }}
        onReset={() => {
          props.resetField("runTimeoutMs");
        }}
      />
      <ValueField
        id="runninghub-queueTimeoutMs"
        label={t("queueTimeoutMs")}
        hint={t("queueTimeoutMsHint")}
        text={state.queueTimeoutMs.text}
        overridden={state.queueTimeoutMs.overridden}
        invalid={state.queueTimeoutMs.invalid}
        overriddenLabel={t("overridden")}
        resetLabel={t("reset")}
        invalidLabel={t("invalidNumber")}
        numeric
        disabled={disabled}
        onEdit={(text) => {
          props.edit("queueTimeoutMs", text);
        }}
        onReset={() => {
          props.resetField("queueTimeoutMs");
        }}
      />
      <ValueField
        id="runninghub-maxConcurrentTasks"
        label={t("maxConcurrentTasks")}
        hint={t("maxConcurrentTasksHint")}
        text={state.maxConcurrentTasks.text}
        overridden={state.maxConcurrentTasks.overridden}
        invalid={state.maxConcurrentTasks.invalid}
        overriddenLabel={t("overridden")}
        resetLabel={t("reset")}
        invalidLabel={t("invalidNumber")}
        numeric
        disabled={disabled}
        onEdit={(text) => {
          props.edit("maxConcurrentTasks", text);
        }}
        onReset={() => {
          props.resetField("maxConcurrentTasks");
        }}
      />
      <div className={css.field}>
        <div className={css.toggleRow}>
          <span className={css.label}>{t("uploadUseLegacy")}</span>
          {state.uploadUseLegacyOverridden ? (
            <Tag tone="neutral">{t("overridden")}</Tag>
          ) : null}
          <Switch
            checked={state.uploadUseLegacy}
            label={t("uploadUseLegacy")}
            disabled={disabled}
            onChange={(checked) => {
              props.editUploadUseLegacy(checked);
            }}
          />
        </div>
        <p className={css.hint}>{t("uploadUseLegacyHint")}</p>
      </div>
      <div className={css.field}>
        <div className={css.toggleRow}>
          <span className={css.label}>{t("taskPanelEnabled")}</span>
          {state.taskPanelEnabledOverridden ? (
            <Tag tone="neutral">{t("overridden")}</Tag>
          ) : null}
          <Switch
            checked={state.taskPanelEnabled}
            label={t("taskPanelEnabled")}
            disabled={disabled}
            onChange={(checked) => {
              props.editTaskPanelEnabled(checked);
            }}
          />
        </div>
        <p className={css.hint}>{t("taskPanelEnabledHint")}</p>
      </div>
      <div className={css.field}>
        <div className={css.toggleRow}>
          <span className={css.label}>{t("describeModel")}</span>
          <div className={css.modelPicker} ref={pickerRef}>
            <button
              type="button"
              className={css.modelPickerTrigger}
              disabled={disabled}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              aria-label={t("describeModel")}
              onClick={openPicker}
            >
              <span className={css.modelPickerValue}>
                {describeSelectionLabel}
              </span>
              <IconChevronDownOutline14 size={14} />
            </button>
            {pickerOpen ? (
              <div
                className={css.modelMenu}
                role="listbox"
                aria-label={t("describeModel")}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={describeProvider === ""}
                  className={
                    describeProvider === ""
                      ? css.modelOptionActive
                      : css.modelOption
                  }
                  onClick={() => {
                    editDescribeModel("", "");
                    setPickerOpen(false);
                  }}
                >
                  {catalog !== null
                    ? t("describeModelDefaultOf", {
                        model: `${catalog.default.provider}/${catalog.default.model}`,
                      })
                    : t("describeModelDefault")}
                </button>
                {catalog?.groups.map((group) => (
                  <section key={group.id}>
                    <p className={css.modelGroup}>{group.name}</p>
                    {group.models.map((model) => (
                      <button
                        type="button"
                        role="option"
                        key={model.id}
                        aria-selected={
                          describeProvider === group.id &&
                          describeModelId === model.id
                        }
                        className={
                          describeProvider === group.id &&
                          describeModelId === model.id
                            ? css.modelOptionActive
                            : css.modelOption
                        }
                        onClick={() => {
                          editDescribeModel(group.id, model.id);
                          setPickerOpen(false);
                        }}
                      >
                        {model.name}
                      </button>
                    ))}
                  </section>
                ))}
                {catalog === null ? (
                  <p className={css.hint}>{t("describeModelLoading")}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        <p className={css.hint}>{t("describeModelHint")}</p>
      </div>
      <div className={css.actions}>
        <Button
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            void doTestConnection();
          }}
        >
          {busy === "test" ? t("testing") : t("testConnection")}
        </Button>
        {status !== null ? (
          <p
            className={status.kind === "error" ? css.statusError : css.statusOk}
            role="status"
          >
            {status.text}
          </p>
        ) : null}
      </div>

      <p className={css.sectionTitle}>{t("workflows")}</p>
      <div className={css.addRow}>
        <span className={css.grow}>
          <input
            className={css.input}
            type="text"
            value={workflowId}
            placeholder={t("workflowIdPlaceholder")}
            aria-label={t("workflowId")}
            disabled={disabled}
            onChange={(e) => {
              setWorkflowId(e.target.value);
            }}
          />
        </span>
        <span className={css.grow}>
          <input
            className={css.input}
            type="text"
            value={workflowLabel}
            placeholder={t("workflowLabelPlaceholder")}
            aria-label={t("workflowLabel")}
            disabled={disabled}
            onChange={(e) => {
              setWorkflowLabel(e.target.value);
            }}
          />
        </span>
        <Button
          size="sm"
          variant="primary"
          disabled={busy !== null || disabled || workflowId.trim() === ""}
          onClick={() => {
            void doFetch();
          }}
        >
          {busy === "fetch" ? t("fetching") : t("addWorkflow")}
        </Button>
      </div>

      {workflows.length === 0 ? (
        <p className={css.hint}>{t("noWorkflows")}</p>
      ) : null}

      {workflows.map((workflow, wfIndex) => {
        const key = `${workflow.workflowId}:${wfIndex}`;
        const validation = validations[key];
        return (
          <div key={key} className={css.workflow}>
            <div className={css.workflowHead}>
              <input
                className={css.input}
                type="text"
                value={workflow.label}
                aria-label={t("workflowLabel")}
                disabled={disabled}
                onChange={(e) => {
                  updateWorkflow(wfIndex, { label: e.target.value });
                }}
              />
              <a
                className={css.workflowIdLink}
                href={`https://www.runninghub.cn/workflow/${workflow.workflowId}`}
                target="_blank"
                rel="noreferrer"
              >
                {workflow.workflowId}
              </a>
              <button
                type="button"
                className={css.iconButton}
                title={copiedKey === key ? t("copied") : t("copyId")}
                aria-label={copiedKey === key ? t("copied") : t("copyId")}
                onClick={() => {
                  void copyWorkflowId(key, workflow.workflowId);
                }}
              >
                {copiedKey === key ? (
                  <IconCheckOutline16 size={14} />
                ) : (
                  <IconCopyOutline16 size={14} />
                )}
              </button>
              <button
                type="button"
                className={css.paramsToggle}
                aria-expanded={expanded[key] === true}
                onClick={() => {
                  setExpanded((prev) => ({
                    ...prev,
                    [key]: prev[key] !== true,
                  }));
                }}
              >
                <span
                  className={
                    expanded[key] === true ? css.chevronOpen : css.chevron
                  }
                >
                  <IconChevronDownOutline14 size={14} />
                </span>
                {t("params")} ({workflow.nodeDefaults.length})
              </button>
            </div>

            <div className={css.descRow}>
              <textarea
                className={css.textarea}
                value={workflow.description ?? ""}
                placeholder={t("workflowDescPlaceholder")}
                aria-label={t("workflowDesc")}
                rows={2}
                disabled={disabled}
                onChange={(e) => {
                  updateWorkflow(wfIndex, {
                    description:
                      e.target.value === "" ? undefined : e.target.value,
                  });
                }}
              />
              <button
                type="button"
                className={css.iconButton}
                title={t("generateDesc")}
                aria-label={t("generateDesc")}
                disabled={busy !== null || disabled}
                onClick={() => {
                  void doDescribe(wfIndex);
                }}
              >
                <IconSparkle16
                  size={14}
                  className={busy === `describe:${key}` ? css.spin : undefined}
                />
              </button>
            </div>

            <textarea
              className={css.textarea}
              value={workflow.usageNote ?? ""}
              placeholder={t("usageNotePlaceholder")}
              aria-label={t("usageNote")}
              rows={2}
              disabled={disabled}
              onChange={(e) => {
                const value = e.target.value;
                const next: WorkflowDefinition = { ...workflow };
                if (value === "") delete next.usageNote;
                else next.usageNote = value;
                updateWorkflow(wfIndex, next);
              }}
            />

            {expanded[key] === true ? (
              <>
                {workflow.nodeDefaults.map((param, paramIndex) => (
                  <div
                    key={`${param.nodeId}.${param.fieldName}`}
                    className={css.paramRow}
                  >
                    <button
                      type="button"
                      className={
                        param.attention === true
                          ? css.attentionActive
                          : css.attention
                      }
                      data-uid="attention-workflow-json"
                      title={t("attentionHint")}
                      aria-label={t("attentionHint")}
                      aria-pressed={param.attention === true}
                      disabled={disabled}
                      onClick={() => {
                        toggleAttention(wfIndex, paramIndex);
                      }}
                    >
                      <IconLightOutline16 size={14} />
                    </button>
                    <span
                      className={css.paramLabel}
                      title={`${param.nodeId}.${param.fieldName}`}
                    >
                      <span className={css.nodeId}>#{param.nodeId}</span>{" "}
                      {param.label ?? param.fieldName}
                      {param.required ? (
                        <span className={css.requiredMark}> *</span>
                      ) : null}
                    </span>
                    <span className={css.paramControl}>
                      <ParamInput
                        param={param}
                        disabled={disabled}
                        onChange={(next) => {
                          updateParam(wfIndex, paramIndex, next);
                        }}
                      />
                    </span>
                  </div>
                ))}

                {workflow.mediaSlots.length > 0
              ? (
                <div className={css.mediaList}>
                  <input
                    className={css.input}
                    type="text"
                    value={workflow.mediaNote ?? ''}
                    placeholder={t('mediaNotePlaceholder')}
                    aria-label={t('mediaNote')}
                    disabled={disabled}
                    onChange={(e) => {
                      const value = e.target.value;
                      const next: WorkflowDefinition = { ...workflow };
                      if (value === "") delete next.mediaNote;
                      else next.mediaNote = value;
                      updateWorkflow(wfIndex, next);
                    }}
                  />
                  {workflow.mediaSlots.map((slot, slotIndex) => (
                    <div key={`${slot.nodeId}.${slot.fieldName}`} className={css.mediaRow}>
                      <button
                        type="button"
                        className={slot.attention === true ? css.attentionActive : css.attention}
                        title={t('mediaAttentionHint')}
                        aria-label={t('mediaAttentionHint')}
                        aria-pressed={slot.attention === true}
                        disabled={disabled}
                        onClick={() => { toggleMediaAttention(wfIndex, slotIndex) }}
                      >
                        <IconLightOutline16 size={14} />
                      </button>
                      <span
                        className={css.mediaLabel}
                        title={`${slot.nodeId}.${slot.fieldName}`}
                      >
                        <span className={css.nodeId}>#{slot.nodeId}</span>
                        {' '}
                        {slot.label ?? slot.fieldName} ({slot.type}){slot.required ? ' *' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )
              : null}

                {validation !== undefined ? (
                  <div>
                    {validation.missingParams !== undefined &&
                    validation.missingParams.length > 0 ? (
                      <p className={css.statusError}>
                        {t("missingParams")}:{" "}
                        {validation.missingParams.join(", ")}
                      </p>
                    ) : null}
                    {validation.requiredMedia !== undefined &&
                    validation.requiredMedia.length > 0 ? (
                      <p className={css.validation}>
                        {t("requiredMedia")}:{" "}
                        {validation.requiredMedia.join(", ")}
                      </p>
                    ) : null}
                    {validation.optionalEmpty !== undefined &&
                    validation.optionalEmpty.length > 0 ? (
                      <p className={css.validation}>
                        {t("optionalEmpty")}:{" "}
                        {validation.optionalEmpty.join(", ")}
                      </p>
                    ) : null}
                    <details>
                      <summary className={css.validation}>
                        {t("nodeInfoList")}
                      </summary>
                      <pre className={css.payload}>
                        {JSON.stringify(validation.nodeInfoList, null, 2)}
                      </pre>
                    </details>
                  </div>
                ) : null}

                <div className={css.workflowActions}>
                  <Button
                    size="sm"
                    disabled={busy !== null || disabled}
                    onClick={() => {
                      void doValidate(wfIndex);
                    }}
                  >
                    {busy === `validate:${key}`
                      ? t("validating")
                      : t("validate")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null || disabled}
                    onClick={() => {
                      void doRunTest(wfIndex);
                    }}
                  >
                    {busy === `test:${wfIndex}`
                      ? t("testRunning")
                      : t("testRun")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null || disabled}
                    onClick={() => {
                      void doRefresh(wfIndex);
                    }}
                  >
                    {busy === `refresh:${wfIndex}`
                      ? t("fetching")
                      : t("refresh")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy !== null || disabled}
                    onClick={() => {
                      doDelete(wfIndex);
                    }}
                  >
                    {t("delete")}
                  </Button>
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </PluginCard>
  );
}

/**
 * Merge an LLM analysis into a workflow: description + usage notes (when
 * fillText) plus the proposed attention marks. A note is never cleared here —
 * only a non-empty one replaces it, so a hand-recorded gotcha survives.
 */
function applyAnalysis(
  workflow: WorkflowDefinition,
  data: DescribeWorkflowData,
  fillText: boolean,
): WorkflowDefinition {
  const next: WorkflowDefinition = { ...workflow };
  if (fillText && data.description !== "") next.description = data.description;
  if (fillText && data.usageNote !== undefined && data.usageNote !== "")
    next.usageNote = data.usageNote;
  if (data.attention !== undefined) {
    const marked = new Set(data.attention);
    next.nodeDefaults = workflow.nodeDefaults.map((param) => {
      const { attention: _drop, ...rest } = param;
      return marked.has(`${param.nodeId}.${param.fieldName}`)
        ? { ...rest, attention: true }
        : rest;
    });
  }
  return next;
}

function ParamInput(props: {
  param: NodeParamOverride;
  disabled: boolean;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const { param, disabled, onChange } = props;
  if (
    param.kind === "select" &&
    param.options !== undefined &&
    param.options.length > 0
  ) {
    return (
      <select
        className={css.input}
        value={param.fieldValue === undefined ? "" : String(param.fieldValue)}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {param.fieldValue === undefined ? (
          <option value="" disabled>
            —
          </option>
        ) : null}
        {param.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (param.kind === "boolean") {
    return (
      <Switch
        checked={Boolean(param.fieldValue)}
        label={param.label ?? param.fieldName}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }
  if (
    param.kind === "number" ||
    param.kind === "int" ||
    param.kind === "float"
  ) {
    return (
      <NumberInput
        value={param.fieldValue}
        intOnly={param.kind === "int"}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }
  if (param.kind === "json") {
    return (
      <input
        className={css.input}
        type="text"
        value={
          param.fieldValue === undefined ? "" : JSON.stringify(param.fieldValue)
        }
        disabled={disabled}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value) as JsonValue);
          } catch {
            /* keep typing */
          }
        }}
      />
    );
  }
  return (
    <input
      className={css.input}
      type="text"
      value={param.fieldValue === undefined ? "" : String(param.fieldValue)}
      disabled={disabled}
      onChange={(e) => {
        onChange(e.target.value);
      }}
    />
  );
}

/**
 * Numeric widget with a local draft: intermediate states like "1." or "-" are
 * not valid numbers, so the draft is what renders and only parseable text is
 * committed — typing decimals into a float field stays possible.
 */
function NumberInput(props: {
  value: JsonValue | undefined;
  intOnly: boolean;
  disabled: boolean;
  onChange: (value: JsonValue | undefined) => void;
}) {
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const shown =
    draft ?? (typeof props.value === "number" ? String(props.value) : "");
  return (
    <input
      className={css.input}
      type="text"
      inputMode={props.intOnly ? "numeric" : "decimal"}
      value={shown}
      disabled={props.disabled}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const trimmed = text.trim();
        if (trimmed === "") {
          props.onChange(undefined);
          return;
        }
        if (props.intOnly && !/^-?\d+$/.test(trimmed)) return;
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) props.onChange(parsed);
      }}
      onBlur={() => {
        setDraft(undefined);
      }}
    />
  );
}
