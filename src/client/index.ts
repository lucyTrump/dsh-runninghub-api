/**
 * RunningHub settings card, browser half: one `settings.plugin.item` entry
 * keyed by the `runninghub` namespace the host plugin registers.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The generated Remote contribution (built by scripts/gen-typert.mjs). A
// package self-reference ('dsh-runninghub-api/remote') would need the package
// linked into its own node_modules at build time; the relative path always
// resolves. Bundled inline — it never reaches the client module table.
import runninghubRemote from '../../lib/typert.remote-client.js'
import type { RunningHubCardSlotFace } from './RunningHubCard.tsx'
import { RunningHubCard } from './RunningHubCard.tsx'
import { RunWorkflowRow } from './RunWorkflowRow.tsx'
import {
  RUNNINGHUB_NS, RunningHubCardController, type RunningHubSection,
} from './runninghub-card-controller.ts'
import { en, zh, type RunningHubLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.runninghub': RunningHubLocaleKey
  }
}

export type { RunningHubCardProps, RunningHubCardSlotFace } from './RunningHubCard.tsx'
export type { RunningHubCardState } from './runninghub-card-controller.ts'

const NS = 'settings.runninghub'

/**
 * Required services (cordis fiber inject). `remote.credentials` writes the API
 * key. `remote.runninghub` is NOT injected: as an out-of-tree plugin this card
 * mounts its own Remote contribution below (an inject entry cannot depend on a
 * service the same plugin provides).
 */
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.credentials']

/**
 * Mount the RunningHub settings card in the configurable-plugins tab.
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

  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: RUNNINGHUB_NS,
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

  // Chat panel: render the submitted nodeInfoList payload for `runninghub_run_workflow`.
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'runninghub_run_workflow',
    locale: NS,
  }, RunWorkflowRow))
  },
}
