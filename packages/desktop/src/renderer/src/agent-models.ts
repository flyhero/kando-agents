import { useEffect, useState } from 'react'
import type { AgentKind, ChatCatalog, ChatModel } from '@kando/protocol'
import { useCore } from './core-store'

// A model and effort picked for an agent to start in; absent is its default.
export type ModelChoice = { model?: string; effort?: string }

// The models an agent offers, asked of core once per agent while the caller is shown: undefined
// while the answer is on its way, null when there is none.
export function useAgentCatalog(agent: AgentKind | null, enabled: boolean): ChatCatalog | null | undefined {
  const rpc = useCore((s) => s.rpc)
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentKind, ChatCatalog | null>>>({})
  useEffect(() => {
    if (!agent || !rpc || !enabled || agent in catalogs) return
    let current = true
    const settle = (catalog: ChatCatalog | null) => {
      if (current) setCatalogs((known) => ({ ...known, [agent]: catalog }))
    }
    rpc.call('conversations.chatCatalog', { agent }).then(settle, () => settle(null))
    return () => { current = false }
  }, [agent, rpc, enabled, catalogs])
  return agent ? catalogs[agent] : null
}

export type ResolvedModel = {
  defaultModel: ChatModel | undefined
  // The model it will run: the one picked, else the default.
  model: ChatModel | undefined
  // The one picked, when the catalog lists it; undefined is the default.
  modelId: string | undefined
  efforts: readonly string[]
  effort: string | undefined
}

// A choice as the catalog can take it: a model it lists, an effort that model takes.
export function resolveModel(catalog: ChatCatalog | null | undefined, choice: ModelChoice): ResolvedModel {
  const defaultModel = catalog?.models.find((each) => each.isDefault)
  const picked = catalog?.models.find((each) => each.id === choice.model)
  const model = picked ?? defaultModel
  const efforts = model?.efforts ?? []
  return {
    defaultModel,
    model,
    modelId: picked?.id,
    efforts,
    effort: choice.effort && efforts.includes(choice.effort) ? choice.effort : undefined
  }
}
