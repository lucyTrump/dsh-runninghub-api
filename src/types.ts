/** Client-safe Remote boundary types for the `runninghub` namespace. */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { NodeInfoItem } from './gateway.ts'
import type { MediaSlot, NodeParamOverride, WorkflowDefinition } from './settings.ts'
import type { WorkflowNodeInfo } from './workflow.ts'

// Re-export the shared shape types so the Typert generator resolves every
// Remote boundary type from this public `./types` subpath (not the root `.`).
export type { MediaSlot, NodeParamOverride, WorkflowDefinition } from './settings.ts'
export type { ParsedWorkflow, WorkflowNodeInfo } from './workflow.ts'
export type { NodeInfoItem } from './gateway.ts'
export type { JsonValue } from '@deepseek-ai/dsh-util-values'

export interface FetchWorkflowRequest {
  workflowId: string
}

/** A: parsed workflow fetched by id (success payload only; failures throw). */
export interface FetchWorkflowData {
  workflowId: string
  prompt?: JsonValue
  nodes?: WorkflowNodeInfo[]
  nodeDefaults?: NodeParamOverride[]
  mediaSlots?: MediaSlot[]
}

export interface ValidateWorkflowRequest {
  workflow: WorkflowDefinition
}

/** Free dry-run result: the assembled payload plus any missing required params/slots. */
export interface ValidateWorkflowData {
  nodeInfoList: NodeInfoItem[]
  missingParams?: string[]
  requiredMedia?: string[]
  optionalEmpty?: string[]
}

export interface DescribeWorkflowRequest {
  workflow: WorkflowDefinition
  /** UI locale id (e.g. "zh-CN"); the description is written in that language. */
  locale?: string
}

/** LLM workflow analysis: a catalog description plus proposed attention params. */
export interface DescribeWorkflowData {
  description: string
  /** Proposed attention params ("nodeId.fieldName"), validated against the workflow. */
  attention?: string[]
}

export interface RunTestRequest {
  workflow: WorkflowDefinition
}

/**
 * Real test-run result: the task was submitted through the local concurrency
 * gate (this costs money on RunningHub). Media slots are NOT auto-filled from
 * the settings card — a workflow with required media slots cannot be test-run.
 */
export interface RunTestData {
  localId: string
  status: string
  nodeInfoList: NodeInfoItem[]
}

/** One ledger task as the floating panel renders it (mirrors ledger TaskStatus). */
export interface TaskSummary {
  localId: string
  taskId?: string
  status: 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT'
  label?: string
  workflowId: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  error?: string
}

/** The panel's task list, ledger order (oldest first). */
export interface ListTasksData {
  tasks: TaskSummary[]
}

export interface CancelTaskRequest {
  localId: string
}

export interface CancelTaskData {
  outcome: 'requested' | 'not-found' | 'already-finished'
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No API key in the resolved `runninghub` settings. */
    'runninghub/no-api-key': {}
    /** The workflow fetch (endpoint A) failed. */
    'runninghub/fetch-failed': {}
    /** Dry-run payload assembly failed. */
    'runninghub/validate-failed': {}
    /** The API key was rejected by RunningHub (connection probe). */
    'runninghub/auth-failed': {}
    /** No LLM service or default model is configured for description generation. */
    'runninghub/llm-unavailable': {}
    /** The description generation call failed. */
    'runninghub/describe-failed': {}
  }
}
