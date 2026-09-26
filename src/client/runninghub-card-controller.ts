/**
 * The RunningHub card's staged form over the `runninghub` settings namespace.
 *
 * Mirrors the DSH settings-card pattern: scalar fields stage through CardForm
 * and land in the section on save, while the API key never enters the section
 * — it is written through the credentials domain under the reference the
 * `apiKeyEnv` field names (default `RUNNINGHUB_API_KEY`), so the literal never
 * rides a settings response. The workflows array stages as one draft written
 * by the same save.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RunningHubConfig } from '../settings.ts'
import type { WorkflowDefinition } from '../types.ts'
import {
  CardForm, numberField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/** Settings namespace the host plugin registers. */
export const RUNNINGHUB_NS = 'runninghub'

/** Credential reference the provider resolves when the section names none. */
export const DEFAULT_API_KEY_REF = 'RUNNINGHUB_API_KEY'

/** Form field the credential control stages under. */
const API_KEY_FIELD = 'apiKey'

/** The section fields this card edits (scalars through CardForm, the rest staged directly). */
export type RunningHubSection = Pick<
  RunningHubConfig,
  | 'apiKeyEnv' | 'baseUrl' | 'pollIntervalMs' | 'runTimeoutMs' | 'queueTimeoutMs'
  | 'maxConcurrentTasks' | 'uploadUseLegacy' | 'taskPanelEnabled' | 'describeModel' | 'workflows'
>

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials/set` can affect it; false disables the control. */
  writable: boolean
}

/** What the RunningHub card renders. */
export interface RunningHubCardState extends CardShell {
  /** Credential reference naming the environment key. */
  apiKeyEnv: CardFieldState
  /** API base URL. */
  baseUrl: CardFieldState
  /** Poll interval for running tasks. */
  pollIntervalMs: CardFieldState
  /** Run timeout. */
  runTimeoutMs: CardFieldState
  /** Queue timeout. */
  queueTimeoutMs: CardFieldState
  /** Local concurrency gate. */
  maxConcurrentTasks: CardFieldState
  /** 'provider/model' override for description generation; '' = agent default. */
  describeModel: CardFieldState
  /** The staged credential, which starts blank on every load. */
  apiKey: CardFieldState
  /** Whether the Host reports a credential configured for the referenced key. */
  apiKeyConfigured: boolean
  /** Whether the credentials domain accepts a write for it; false disables the control. */
  apiKeyWritable: boolean
  /** Legacy upload endpoint toggle (draft when it differs from the section). */
  uploadUseLegacy: boolean
  /** True when saving would leave a user-layer entry for the toggle. */
  uploadUseLegacyOverridden: boolean
  /** Floating task-panel toggle (draft when it differs from the section). */
  taskPanelEnabled: boolean
  /** True when saving would leave a user-layer entry for the toggle. */
  taskPanelEnabledOverridden: boolean
  /** The workflows the card edits: the draft while staged, else the section value. */
  workflows: WorkflowDefinition[]
  /** True when the workflows draft differs from the section. */
  workflowsDirty: boolean
}

/** The registration-side face the RunningHub card's slot entry injects. */
export interface RunningHubCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useRunningHubCard. */
    runningHubCard: SnapshotStore<RunningHubCardState>
  }
  /** Stage the legacy-upload toggle. */
  editUploadUseLegacy: (checked: boolean) => void
  /** Stage a clear of the legacy-upload override. */
  resetUploadUseLegacy: () => void
  /** Stage the floating task-panel toggle. */
  editTaskPanelEnabled: (checked: boolean) => void
  /** Stage a clear of the task-panel override. */
  resetTaskPanelEnabled: () => void
  /** Stage a whole workflows array (add/remove/update compute it in the component). */
  stageWorkflows: (workflows: WorkflowDefinition[]) => void
}

/** Bridges the `runninghub` scope and the credentials domain onto the card. */
export class RunningHubCardController {
  private readonly form: CardForm<RunningHubSection>
  private readonly store: SnapshotStore<RunningHubCardState>
  private credential: CredentialState = { ref: '', configured: false, writable: true }
  private workflowsDraft: WorkflowDefinition[] | undefined
  private uploadDraft: boolean | undefined
  private panelDraft: boolean | undefined
  private panelReset = false

  /**
   * @param scope - the bound settings scope for the `runninghub` namespace.
   * @param ctx - the card plugin's context, whose `remote.credentials` namespace
   * answers for the credential the section references.
   */
  constructor(
    private readonly scope: ConfigForm<RunningHubSection>,
    private readonly ctx: ClientContext,
  ) {
    this.form = new CardForm(
      scope,
      [
        textField('apiKeyEnv'),
        textField('baseUrl'),
        numberField('pollIntervalMs'),
        numberField('runTimeoutMs'),
        numberField('queueTimeoutMs'),
        numberField('maxConcurrentTasks'),
        textField('describeModel'),
      ],
      [{ field: API_KEY_FIELD, write: value => this.writeKey(value) }],
    )
    this.store = this.form.bind(() => this.state())
    scope.subscribe(() => { void this.readCredential() })
    void this.readCredential()
  }

  /** The card snapshot plus every action the component calls. */
  face(): RunningHubCardFace {
    const actions = this.form.actions()
    return {
      hooks: { runningHubCard: this.store },
      edit: (field, text) => { actions.edit(field, text); this.republish() },
      resetField: (field) => { actions.resetField(field); this.republish() },
      save: () => { void this.save() },
      discard: () => {
        actions.discard()
        this.workflowsDraft = undefined
        this.uploadDraft = undefined
        this.uploadReset = false
        this.panelDraft = undefined
        this.panelReset = false
        this.republish()
      },
      editUploadUseLegacy: (checked) => { this.uploadDraft = checked; this.uploadReset = false; this.republish() },
      resetUploadUseLegacy: () => { this.uploadDraft = undefined; this.uploadReset = true; this.republish() },
      editTaskPanelEnabled: (checked) => { this.panelDraft = checked; this.panelReset = false; this.republish() },
      resetTaskPanelEnabled: () => { this.panelDraft = undefined; this.panelReset = true; this.republish() },
      stageWorkflows: (workflows) => { this.workflowsDraft = workflows; this.republish() },
    }
  }

  private uploadReset = false

  /** The current projection, rebuilt from the scope plus local drafts. */
  private state(): RunningHubCardState {
    const snapshot = this.scope.getSnapshot()
    const shell = this.form.shell()
    const workflowsDirty = this.workflowsDraft !== undefined
    const uploadDirty = this.uploadDraft !== undefined || this.uploadReset
    const panelDirty = this.panelDraft !== undefined || this.panelReset
    const base = snapshot.base as RunningHubSection | undefined
    return {
      ...shell,
      dirty: shell.dirty || workflowsDirty || uploadDirty || panelDirty,
      apiKeyEnv: this.form.field('apiKeyEnv'),
      baseUrl: this.form.field('baseUrl'),
      pollIntervalMs: this.form.field('pollIntervalMs'),
      runTimeoutMs: this.form.field('runTimeoutMs'),
      queueTimeoutMs: this.form.field('queueTimeoutMs'),
      maxConcurrentTasks: this.form.field('maxConcurrentTasks'),
      describeModel: this.form.field('describeModel'),
      apiKey: this.form.field(API_KEY_FIELD),
      apiKeyConfigured: this.credential.configured,
      apiKeyWritable: this.credential.writable,
      uploadUseLegacy: this.uploadReset
        ? base?.uploadUseLegacy ?? false
        : this.uploadDraft ?? snapshot.value?.uploadUseLegacy ?? false,
      uploadUseLegacyOverridden: this.uploadReset
        ? false
        : this.uploadDraft !== undefined || hasOwn(snapshot, 'uploadUseLegacy'),
      taskPanelEnabled: this.panelReset
        ? base?.taskPanelEnabled ?? true
        : this.panelDraft ?? snapshot.value?.taskPanelEnabled ?? true,
      taskPanelEnabledOverridden: this.panelReset
        ? false
        : this.panelDraft !== undefined || hasOwn(snapshot, 'taskPanelEnabled'),
      workflows: this.workflowsDraft ?? snapshot.value?.workflows ?? [],
      workflowsDirty,
    }
  }

  /** Rebuild the store after a local draft or credential change. */
  private republish(): void {
    this.store.set(this.state())
  }

  /**
   * Write the scalar form, the toggle, and the workflows draft in one save.
   * The form owns its own failure flag; the extra writes re-read the section
   * afterwards, and a write that did not land keeps its draft.
   */
  private async save(): Promise<void> {
    if (this.state().invalid) return
    await this.form.save()
    const workflows = this.workflowsDraft
    if (workflows !== undefined) {
      await this.scope.set('workflows', workflows)
      if (workflowsEqual(this.scope.getSnapshot().value?.workflows, workflows)) {
        this.workflowsDraft = undefined
      }
    }
    if (this.uploadReset) {
      await this.scope.unset('uploadUseLegacy')
      if (!hasOwn(this.scope.getSnapshot(), 'uploadUseLegacy')) this.uploadReset = false
    } else if (this.uploadDraft !== undefined) {
      const value = this.uploadDraft
      await this.scope.set('uploadUseLegacy', value)
      if (this.scope.getSnapshot().value?.uploadUseLegacy === value) this.uploadDraft = undefined
    }
    if (this.panelReset) {
      await this.scope.unset('taskPanelEnabled')
      if (!hasOwn(this.scope.getSnapshot(), 'taskPanelEnabled')) this.panelReset = false
    } else if (this.panelDraft !== undefined) {
      const value = this.panelDraft
      await this.scope.set('taskPanelEnabled', value)
      if (this.scope.getSnapshot().value?.taskPanelEnabled === value) this.panelDraft = undefined
    }
    await this.readCredential()
    this.republish()
  }

  /**
   * Ask the Host what it holds for the referenced credential. The literal
   * never crosses the wire; a stale answer for a previous reference is dropped.
   */
  private async readCredential(): Promise<void> {
    const ref = refOf(this.scope.getSnapshot())
    const result = await this.ctx.remote.credentials.describe([ref])
    if (result.ok) {
      const info = result.value[ref]
      if (info !== undefined) {
        this.credential = { ref, configured: info.configured, writable: info.writable }
      }
    }
    this.republish()
  }

  /**
   * Write the staged credential through the credentials domain, then re-read:
   * the Host is the only authority on whether the key now exists.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  private async writeKey(value: string): Promise<boolean> {
    await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value)
    await this.readCredential()
    return this.credential.configured
  }
}

/** Whether the user layer holds an own entry for the field. */
function hasOwn(snapshot: ConfigFormSnapshot<RunningHubSection>, field: string): boolean {
  const user = snapshot.user as Record<string, unknown> | undefined
  return user !== undefined && Object.hasOwn(user, field)
}

/**
 * The credential reference the section names, or the provider's default.
 * @param snapshot - the current scope snapshot.
 * @returns the reference to address.
 */
function refOf(snapshot: ConfigFormSnapshot<RunningHubSection>): string {
  const declared = snapshot.value?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : DEFAULT_API_KEY_REF
}

/** Shallow array compare good enough to confirm a workflows write landed. */
function workflowsEqual(a: WorkflowDefinition[] | undefined, b: WorkflowDefinition[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b)
}
