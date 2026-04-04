import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import type { AppSettings } from '../../shared/ipc'
import { defaultSettings } from '../../shared/ipc'

export async function loadSettings(userDataPath: string): Promise<AppSettings> {
  const path = join(userDataPath, 'novel-helper-settings.json')
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return { ...defaultSettings, ...parsed }
  } catch {
    return { ...defaultSettings }
  }
}

export async function saveSettings(
  userDataPath: string,
  settings: AppSettings
): Promise<void> {
  const path = join(userDataPath, 'novel-helper-settings.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(settings, null, 2), 'utf8')
}
