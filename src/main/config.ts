import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { defaultSettings, type KeyStorageKind, type MatchSettings } from '../shared/types.ts'

/**
 * Only the API key is persisted. Table setup deliberately is not: every launch
 * starts from a clean table, so a session never inherits models or rules from
 * whatever was being tried last time.
 */
interface StoredConfig {
  /**
   * Base64 of the key as encrypted by Electron `safeStorage`, which means DPAPI
   * on Windows, the Keychain on macOS, and a keyring on Linux.
   */
  apiKeyEncrypted?: string
  /** Only used when no encryption backend is available at all. */
  apiKeyPlain?: string
}

let cache: StoredConfig | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'cardroom-config.json')
}

function read(): StoredConfig {
  if (cache) return cache
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredConfig & { settings?: unknown }
    // Older versions stored table setup here; drop it so it never comes back.
    delete parsed.settings
    cache = parsed
  } catch {
    cache = {}
  }
  return cache
}

function write(next: StoredConfig): void {
  cache = next
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
}

export function getApiKey(): string {
  const stored = read()
  if (stored.apiKeyEncrypted) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.apiKeyEncrypted, 'base64'))
    } catch {
      return ''
    }
  }
  return stored.apiKeyPlain ?? ''
}

export function setApiKey(key: string): void {
  const stored = { ...read() }
  delete stored.apiKeyEncrypted
  delete stored.apiKeyPlain

  const trimmed = key.trim()
  if (trimmed) {
    // Prefer the OS credential store so the key is not sitting in a readable
    // file. On Linux this can still be the weak backend — see keyStorageKind.
    if (safeStorage.isEncryptionAvailable()) {
      stored.apiKeyEncrypted = safeStorage.encryptString(trimmed).toString('base64')
    } else {
      stored.apiKeyPlain = trimmed
    }
  }
  write(stored)
}

export function hasApiKey(): boolean {
  return getApiKey().length > 0
}

/**
 * What the key's storage is actually worth on this machine.
 *
 * Windows and macOS always give a real credential store. Linux does not: with
 * no desktop keyring installed, Electron selects its `basic_text` backend,
 * which still reports `isEncryptionAvailable() === true` while "encrypting"
 * with a key compiled into Chromium. That is obfuscation, and the UI says so
 * rather than claiming the key is encrypted.
 *
 * Must be called after `app.whenReady()`.
 */
export function keyStorageKind(): KeyStorageKind {
  if (!safeStorage.isEncryptionAvailable()) return 'plaintext'
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return 'obfuscated'
  }
  return 'os-keychain'
}

/** Every launch begins with an empty table; nothing here is read from disk. */
export function getSettings(): MatchSettings {
  return defaultSettings()
}

export function configFileLocation(): string {
  return existsSync(configPath()) ? configPath() : `${configPath()} (not created yet)`
}
