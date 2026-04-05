import { readFile, writeFile, mkdir } from 'fs/promises'
import { dirname, join } from 'path'
import {
  isSessionSnapshotV1,
  type SessionSnapshotV1
} from '../../shared/session'

const FILE_NAME = 'novel-helper-session.json'

export async function loadSessionSnapshot(
  userDataPath: string
): Promise<SessionSnapshotV1 | null> {
  const path = join(userDataPath, FILE_NAME)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isSessionSnapshotV1(parsed) ? parsed : null
  } catch {
    return null
  }
}

export async function saveSessionSnapshot(
  userDataPath: string,
  snapshot: SessionSnapshotV1
): Promise<void> {
  const path = join(userDataPath, FILE_NAME)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(snapshot), 'utf8')
}
