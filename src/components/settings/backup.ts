/**
 * Library backup and restore (§5.13 `user_backup_create` / `user_backup_restore`, §9.8; integration): the two flows
 * behind Settings › Storage › Library backup and the startup banner's "Restore from backup…".
 *
 * - **Back up** asks where to save (the save dialog starts in `<data>/backups/` with the dated name Rust would pick) and
 *   writes the backup there; cancelling the dialog does nothing.
 * - **Restore** asks for a backup file (`.qdb`, the extension `user_backup_create` writes), confirms that the library
 *   will be replaced (a destructive question, §9.7), then restores it. Rust verifies the file first and keeps the
 *   current library as a new backup, and its events refresh every store (settings, library, memorisation, packs).
 *
 * Both report through toasts and resolve whether they completed; they never reject.
 */
import { open, save } from '@tauri-apps/plugin-dialog'
import { api, call } from '$lib/ipc'
import { app, i18n, ui } from '$lib/stores'
import { baseName } from '$lib/util/format'

/** The extension of the files `user_backup_create` writes (`user-YYYYMMDD-HHMMSSZ.qdb`). */
const EXTENSIONS = ['qdb']

/** `<data>/backups`, in the platform's separator style. */
function backupsDir(): string | undefined {
  const data = app.info.dataDir
  if (!data) return undefined
  const sep = data.includes('\\') ? '\\' : '/'
  return `${data.replace(/[\\/]+$/u, '')}${sep}backups`
}

/** The file name Rust gives a backup made now (`user-20261010-142300Z.qdb`). */
export function backupFileName(now = new Date()): string {
  const iso = now.toISOString() // 2026-10-10T14:23:00.000Z
  return `user-${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}Z.qdb`
}

function filters() {
  return [{ name: i18n.t('settings.backup.filter'), extensions: EXTENSIONS }]
}

/** Saves a backup of the library where the user chooses. */
export async function backUpLibrary(): Promise<boolean> {
  try {
    const dir = backupsDir()
    const name = backupFileName()
    const dest = await save({
      title: i18n.t('settings.backup.saveTitle'),
      defaultPath: dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}${name}` : name,
      filters: filters(),
    })
    if (typeof dest !== 'string' || dest === '') return false
    const written = await call(api.userBackupCreate(dest))
    ui.toast({ message: i18n.t('settings.backup.created', { file: baseName(written) }), tone: 'success' })
    return true
  } catch (e) {
    ui.toastError(e)
    return false
  }
}

/** Replaces the library with a backup file the user picks, after confirming. */
export async function restoreLibrary(): Promise<boolean> {
  let path: string
  try {
    const picked = await open({
      title: i18n.t('settings.backup.openTitle'),
      defaultPath: backupsDir(),
      multiple: false,
      directory: false,
      filters: filters(),
    })
    if (typeof picked !== 'string' || picked === '') return false
    path = picked
  } catch (e) {
    ui.toastError(e)
    return false
  }
  const file = baseName(path)
  const ok = await ui.confirm({
    title: i18n.t('settings.backup.confirmTitle'),
    body: i18n.t('settings.backup.confirmBody', { file }),
    confirmLabel: i18n.t('settings.backup.confirmLabel'),
    danger: true,
  })
  if (!ok) return false
  try {
    await call(api.userBackupRestore(path))
    ui.toast({ message: i18n.t('settings.backup.restored', { file }), tone: 'success' })
    return true
  } catch (e) {
    ui.toastError(e)
    return false
  }
}
