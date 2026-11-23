export type Issue = { id: string; title: string; status: string; updatedAt: string }
export type News = { id: string; text: string; isRead: boolean; at: number; status: string }
export type Draft = { summary: string; reply: string; handBack?: boolean; close?: boolean }
export type Handled = { at: number; text: string; isMoved: boolean; note: string }
export type PlanItem = {
  issue: string; title: string; who: 'you' | 'claude'; why: string
  state: 'todo' | 'doing' | 'done' | 'needs_you' | 'skipped'; note: string; rank: number
}
export type Plan = { at: number; items: PlanItem[] }

declare module 'claude-code' {
  interface PluginState {
    'marexec-ping': {
      watching: boolean
      issues: Shaped<Issue[]>
      news: Shaped<News[]>
      drafts: Shaped<Record<string, Draft>>
      handled: Shaped<Record<string, Handled>>
      expanded: string
      tab: string
      showAll: boolean
      lastReadAt: number
      nextCheckAt: number
      now: number
      working: string
      plan: Shaped<Plan>
    }
  }
}
