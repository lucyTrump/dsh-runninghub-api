/**
 * RunningHub settings card, browser half: one `plugins.bundle.config` entry
 * keyed by this bundle's package name, which the Plugins page renders on the
 * bundle's own page.
 *
 * DSH 0.1.6-alpha.2 moved plugin configuration from the Settings section to
 * the Plugins page and retired the `settings.plugin.item` slot this card used
 * to register into; a card left on the retired slot never mounts, because
 * `slots.inject` waits for a declaration that no longer happens.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// The generated Remote contribution (built by scripts/gen-typert.mjs). A
// package self-reference ('dsh-runninghub-api/remote') would need the package
// linked into its own node_modules at build time; the relative path always
// resolves. Bundled inline — it never reaches the client module table.
import runninghubRemote from '../../lib/typert.remote-client.js'
import type { RunningHubCardSlotFace } from './RunningHubCard.tsx'
import { RunningHubCard } from './RunningHubCard.tsx'
import { RunWorkflowRow } from './RunWorkflowRow.tsx'
import { TaskPanel, type TaskPanelInjected } from './TaskPanel.tsx'
import {
  RUNNINGHUB_NS, RunningHubCardController, type RunningHubSection,
} from './runninghub-card-controller.ts'
import { en, zh, type RunningHubLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.runninghub': RunningHubLocaleKey
  }
  interface SlotMap {
    /**
     * ui-layout's frame-wide floating layer (list, additive, click-through).
     * Merged locally so this program need not depend on the layout package
     * for a seat it does not own; the runtime declaration is ui-layout's.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

export type { RunningHubCardProps, RunningHubCardSlotFace } from './RunningHubCard.tsx'
export type { RunningHubCardState } from './runninghub-card-controller.ts'

const NS = 'settings.runninghub'

/**
 * Key this bundle's configuration registers under. The Plugins page pairs a
 * `plugins.bundle.config` entry with the installed bundle whose package name
 * the key matches, so it must stay the package name in `package.json` — the
 * same name the bundle's `cordis.patch.yml` row (and `dsh.profile.bundles`)
 * carries.
 */
const BUNDLE_NAME = 'dsh-runninghub-api'

/**
 * Required services (cordis fiber inject). `remote.credentials` writes the API
 * key. `remote.runninghub` is NOT injected: as an out-of-tree plugin this card
 * mounts its own Remote contribution below (an inject entry cannot depend on a
 * service the same plugin provides).
 */
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.credentials']

/**
 * Mount the RunningHub configuration form on the Plugins page's bundle page.
 * @param ctx - the browser plugin context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Self-mount the host Remote (in-tree this lived in the api-remotes
  // assembly), then hand off to a child plugin: cordis forbids reading a
  // service without declaring it in `inject`, and this plugin cannot inject
  // the service it mounts itself. The child activates once the mount has
  // registered `remote.runninghub`.
  await ctx.remote.$mount(runninghubRemote)
  ctx.plugin(cardPlugin)
}

const cardPlugin = {
  name: 'dsh-runninghub-api: card',
  inject: ['slots', 'locale', 'settingsScope', 'remote.credentials', 'remote.runninghub', 'remote.session'],
  apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-client-runninghub: locale')

  const scope = ctx.settingsScope.bind<RunningHubSection>({ namespace: RUNNINGHUB_NS })
  const controller = new RunningHubCardController(scope, ctx)

  // Bundle page form: the Plugins page renders this between the bundle's
  // description and its rows, in the `page` view only.
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
    name: 'plugins.bundle.config',
    key: BUNDLE_NAME,
    locale: NS,
    inject: (): RunningHubCardSlotFace => ({
      ...controller.face(),
      remote: {
        fetchWorkflow: request => ctx.remote.runninghub.fetchWorkflow(request),
        testConnection: () => ctx.remote.runninghub.testConnection(),
        validateWorkflow: request => ctx.remote.runninghub.validateWorkflow(request),
        runTest: request => ctx.remote.runninghub.runTest(request),
        describeWorkflow: request => ctx.remote.runninghub.describeWorkflow({
          ...request,
          locale: ctx.locale.getLocale().active,
        }),
        modelCatalog: () => ctx.remote.session.modelCatalog(),
      },
    }),
  }, RunningHubCard))

  // Floating task panel: a shell.overlay entry (additive list seat over the
  // whole frame). The taskPanelEnabled setting hides it inside the component.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'runninghub-tasks',
    locale: NS,
    inject: (): TaskPanelInjected => ({
      scope,
      listTasks: () => ctx.remote.runninghub.listTasks(),
      cancelTask: localId => ctx.remote.runninghub.cancelTask({ localId }),
      refreshTasks: () => ctx.remote.runninghub.refreshTasks(),
    }),
  }, TaskPanel))

  // Chat panel: render the submitted nodeInfoList payload for `runninghub_run_workflow`.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'runninghub_run_workflow',
    locale: NS,
  }, RunWorkflowRow))
  },
}
