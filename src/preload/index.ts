import { contextBridge, ipcRenderer } from 'electron'
import type { KeyStorageKind, MatchEvent, MatchSettings, ModelInfo } from '../shared/types.ts'

export interface ConfigPayload {
  hasApiKey: boolean
  settings: MatchSettings
  configPath: string
  /** How well the key is protected at rest, which varies by OS. */
  keyStorage: KeyStorageKind
}

const api = {
  getConfig: (): Promise<ConfigPayload> => ipcRenderer.invoke('config:get'),

  setApiKey: (key: string): Promise<{ hasApiKey: boolean }> =>
    ipcRenderer.invoke('config:setApiKey', key),

  verifyApiKey: (key?: string): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke('config:verifyApiKey', key),

  listModels: (force?: boolean): Promise<{ models: ModelInfo[]; cached: boolean }> =>
    ipcRenderer.invoke('models:list', force),

  startMatch: (settings: MatchSettings): Promise<boolean> =>
    ipcRenderer.invoke('match:start', settings),

  /** Pushes mid-match changes (stake, pace, round limit) to a running match. */
  updateLiveSettings: (settings: MatchSettings): Promise<boolean> =>
    ipcRenderer.invoke('match:updateLive', settings),

  pauseMatch: (): Promise<boolean> => ipcRenderer.invoke('match:pause'),
  resumeMatch: (): Promise<boolean> => ipcRenderer.invoke('match:resume'),
  stopMatch: (): Promise<boolean> => ipcRenderer.invoke('match:stop'),

  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url),

  /** Subscribes to live match events. Returns an unsubscribe function. */
  onMatchEvent: (handler: (event: MatchEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: MatchEvent): void => handler(payload)
    ipcRenderer.on('match:event', listener)
    return () => ipcRenderer.removeListener('match:event', listener)
  }
}

export type CardroomApi = typeof api

contextBridge.exposeInMainWorld('cardroom', api)
