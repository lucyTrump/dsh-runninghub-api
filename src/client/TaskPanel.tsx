/**
 * Floating RunningHub task panel: a shell.overlay entry pinned bottom-right.
 * Polls the host ledger through the RunningHub remote, lists active tasks
 * (local queue / platform queue / running) with one-click cancel, then a few
 * recent terminal tasks for feedback. The `taskPanelEnabled` setting hides it.
 */

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CancelTaskData, ListTasksData, TaskSummary } from '../types.ts'
import type { RunningHubSection } from './runninghub-card-controller.ts'
import css from './TaskPanel.module.css'

/** Injected face: the bound settings scope plus the two task remotes. */
export interface TaskPanelInjected {
  scope: SettingsScope<RunningHubSection>
  listTasks: () => Promise<RemoteResult<ListTasksData>>
  cancelTask: (localId: string) => Promise<RemoteResult<CancelTaskData>>
  refreshTasks: () => Promise<RemoteResult<ListTasksData>>
}

type Props = TaskPanelInjected & PropsLocale<'settings.runninghub'>

const LIVE = new Set(['PENDING', 'QUEUED', 'RUNNING'])
const POLL_MS = 3000
const RECENT_LIMIT = 5

const STATUS_KEY = {
  PENDING: 'taskStatusPENDING',
  QUEUED: 'taskStatusQUEUED',
  RUNNING: 'taskStatusRUNNING',
  SUCCEEDED: 'taskStatusSUCCEEDED',
  FAILED: 'taskStatusFAILED',
  CANCELLED: 'taskStatusCANCELLED',
  TIMEOUT: 'taskStatusTIMEOUT',
} as const

function dotClass(status: TaskSummary['status']): string {
  if (LIVE.has(status)) return `${css.dot} ${css.live}`
  if (status === 'SUCCEEDED') return `${css.dot} ${css.succeeded}`
  if (status === 'FAILED' || status === 'TIMEOUT') return `${css.dot} ${css.failed}`
  return `${css.dot} ${css.muted}`
}

function timeOf(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function TaskPanel({ scope, listTasks, cancelTask, refreshTasks, t }: Props) {
  const enabled = useSyncExternalStore(
    listener => scope.subscribe(listener),
    () => scope.getSnapshot().value?.taskPanelEnabled ?? true,
  )
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [cancelling, setCancelling] = useState<string | undefined>(undefined)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let alive = true
    const tick = () => {
      listTasks()
        .then(result => { if (alive && result.ok) setTasks(result.value.tasks) })
        .catch(() => { /* transient remote failure: keep the last list */ })
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [enabled, listTasks])

  if (!enabled) return null

  const newestFirst = [...tasks].reverse()
  const live = newestFirst.filter(task => LIVE.has(task.status))
  const recent = newestFirst.filter(task => !LIVE.has(task.status)).slice(0, RECENT_LIMIT)

  const cancel = (localId: string) => {
    setCancelling(localId)
    cancelTask(localId)
      .catch(() => { /* the next poll reflects whatever happened */ })
      .finally(() => {
        setCancelling(undefined)
        listTasks().then(result => { if (result.ok) setTasks(result.value.tasks) }).catch(() => {})
      })
  }

  /** Manual platform re-query: settles records whose poller is gone. */
  const refresh = () => {
    setRefreshing(true)
    refreshTasks()
      .then(result => { if (result.ok) setTasks(result.value.tasks) })
      .catch(() => { /* keep the last list */ })
      .finally(() => setRefreshing(false))
  }

  const row = (task: TaskSummary, cancellable: boolean) => (
    <div className={css.row} key={task.localId}>
      <span className={dotClass(task.status)} />
      <div className={css.info}>
        <span className={css.label}>{task.label ?? task.workflowId}</span>
        <span className={css.meta}>
          {t(STATUS_KEY[task.status])} · {timeOf(task.createdAt)}
          {task.error !== undefined && task.error !== '' ? ` · ${task.error}` : ''}
        </span>
      </div>
      {cancellable ? (
        <button
          type="button"
          className={css.cancel}
          disabled={cancelling === task.localId}
          onClick={() => cancel(task.localId)}
        >
          {cancelling === task.localId ? t('taskPanelCancelling') : t('taskPanelCancel')}
        </button>
      ) : null}
    </div>
  )

  return (
    <div className={css.root}>
      {open ? (
        <div className={css.panel} role="dialog" aria-label={t('taskPanelTitle')}>
          <div className={css.titleRow}>
            <p className={css.title}>{t('taskPanelTitle')}</p>
            <button
              type="button"
              className={css.cancel}
              disabled={refreshing}
              onClick={refresh}
            >
              {refreshing ? t('taskPanelRefreshing') : t('taskPanelRefresh')}
            </button>
          </div>
          {live.length === 0 && recent.length === 0 ? (
            <p className={css.empty}>{t('taskPanelEmpty')}</p>
          ) : null}
          {live.length > 0 ? (
            <>
              <p className={css.section}>{t('taskPanelLive')}</p>
              {live.map(task => row(task, true))}
            </>
          ) : null}
          {recent.length > 0 ? (
            <>
              <p className={css.section}>{t('taskPanelRecent')}</p>
              {recent.map(task => row(task, false))}
            </>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className={css.fab}
        aria-expanded={open}
        aria-label={t('taskPanelTitle')}
        onClick={() => setOpen(value => !value)}
      >
        {t('taskPanelTitle')}
        {live.length > 0 ? <span className={css.badge}>{live.length}</span> : null}
      </button>
    </div>
  )
}
