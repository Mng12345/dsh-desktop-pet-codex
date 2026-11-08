/** Durable authority for list membership. Old window mirrors cannot resurrect a removed row. */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { endpointDir, ensureEndpointDir } from './endpoint.js'
import type { SessionId } from '../core/types.js'

export const watchFile = (): string => join(endpointDir(), 'watch.json')

/** null means a first run: import the window's legacy list once. [] is a real saved list. */
export const loadWatch = (): readonly SessionId[] | null => {
  try {
    const raw: unknown = JSON.parse(readFileSync(watchFile(), 'utf8'))
    if (typeof raw !== 'object' || raw === null || !('version' in raw) || raw.version !== 1 ||
        !('ids' in raw) || !Array.isArray(raw.ids) ||
        !raw.ids.every((id: unknown) => typeof id === 'string' && id.length > 0)) return null
    return [...new Set(raw.ids as string[])].sort()
  } catch {
    return null
  }
}

/** Atomic replacement also records an empty list, so removal survives an immediate restart. */
export const saveWatch = (ids: ReadonlySet<SessionId>): boolean => {
  try {
    if (!ensureEndpointDir()) return false
    const file = watchFile()
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ids: [...ids].sort() }, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
    return true
  } catch {
    return false
  }
}
