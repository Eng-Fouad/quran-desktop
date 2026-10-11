/**
 * What the Downloads manager's buttons and menus do (§9.7, §10.3 "pack row" and "SurahGrid cell"). Owner: WP12a.
 * Every action reports its failure as a toast (`ui.toastError`); destructive ones ask first (`ui.confirm`, §9.7
 * "Destructive actions use ConfirmDialog").
 */
import type { LucideIcon } from '@lucide/svelte'
import Download from '@lucide/svelte/icons/download'
import FolderOpen from '@lucide/svelte/icons/folder-open'
import Pause from '@lucide/svelte/icons/pause'
import Play from '@lucide/svelte/icons/play'
import RotateCw from '@lucide/svelte/icons/rotate-cw'
import Trash from '@lucide/svelte/icons/trash'
import X from '@lucide/svelte/icons/x'
import CircleArrowUp from '@lucide/svelte/icons/circle-arrow-up'
import type { MenuEntry } from '$components/ui'
import type { InstallScope, JobSnapshot, PackInfo } from '$lib/ipc/bindings'
import { app, i18n, packs, player, quran, settings, ui } from '$lib/stores'
import { hasContent, isActivePhase, isInstalled } from '$lib/stores/packs.svelte'

/** Whether downloads can start now: network use allowed and the app online. */
export function canDownload(): boolean {
  return packs.canDownload
}

export type PackActionId =
  | 'download'
  | 'downloadRest'
  | 'update'
  | 'pause'
  | 'resume'
  | 'retry'
  | 'stop'
  | 'cancel'
  | 'remove'
  | 'openFolder'

export interface PackAction {
  id: PackActionId
  label: string
  icon: LucideIcon
  run: () => void
  /** `text`: a labelled button; `icon`: an icon button (the label is its name and tooltip). */
  style: 'text' | 'icon'
  variant: 'primary' | 'secondary' | 'ghost'
  disabled?: boolean
  danger?: boolean
}

function report(e: unknown): void {
  ui.toastError(e)
}

export function download(p: PackInfo, scope?: InstallScope): void {
  packs.install(p.id, scope).catch(report)
}

export function pause(p: PackInfo): void {
  packs.pause(p.id).catch(report)
}

export function resume(p: PackInfo): void {
  packs.resume(p.id).catch(report)
}

/** Drops a download that waits for a connection (and the failed job it may stand for). */
export function cancelWaiting(p: PackInfo): void {
  packs.cancel(p.id).catch(report)
}

export function retry(p: PackInfo): void {
  packs.retry(p.id).catch(report)
}

export function update(p: PackInfo): void {
  packs.update(p.id).catch(report)
}

/** KiB of the pack on this computer (what removing it frees). */
export function onDiskKib(p: PackInfo): number {
  if (p.installMode === 'on_demand') {
    const items = packs.items.get(p.id)
    if (items) return items.reduce((sum, i) => sum + i.kib, 0)
  }
  return p.installedKib > 0 ? p.installedKib : isInstalled(p) ? p.sizeKib : 0
}

/** Stops a job: asks first once something was downloaded (a whole pack loses it; items stay). */
export async function stop(p: PackInfo, job: JobSnapshot | undefined): Promise<void> {
  if (job && job.receivedKib > 0) {
    const ok = await ui.confirm({
      title: i18n.t('downloads.confirm.stopTitle', { name: packs.title(p) }),
      body: i18n.t(
        p.installMode === 'on_demand' ? 'downloads.confirm.stopItemsBody' : 'downloads.confirm.stopWholeBody',
      ),
      confirmLabel: i18n.t('downloads.actions.stop'),
      danger: true,
    })
    if (!ok) return
  }
  await packs.cancel(p.id).catch(report)
}

/** Removes a pack from this computer after a confirmation naming what it frees. */
export async function remove(p: PackInfo): Promise<void> {
  const kib = onDiskKib(p)
  const size = i18n.bytes(kib)
  const ok = await ui.confirm({
    title: i18n.t('downloads.confirm.removeTitle', { name: packs.title(p) }),
    body:
      p.installMode === 'on_demand'
        ? i18n.t('downloads.confirm.removeItemsBody', { size })
        : i18n.t('downloads.confirm.removeBody', { size }),
    confirmLabel: i18n.t('downloads.actions.remove'),
    danger: true,
  })
  if (!ok) return
  try {
    await packs.remove(p.id)
    ui.toast({ message: i18n.t('downloads.toast.removed', { name: packs.title(p), size }), tone: 'success' })
  } catch (e) {
    report(e)
  }
}

/** Removes every downloaded surah of a reciter (the stream cache stays). */
export async function removeAllSurahs(p: PackInfo): Promise<void> {
  const pinned = (packs.items.get(p.id) ?? []).filter((i) => i.pinned)
  if (pinned.length === 0) return
  const size = i18n.bytes(pinned.reduce((sum, i) => sum + i.kib, 0))
  const ok = await ui.confirm({
    title: i18n.t('downloads.confirm.removeAllTitle', { name: packs.title(p) }),
    body: i18n.t('downloads.confirm.removeAllBody', { size }),
    confirmLabel: i18n.t('downloads.actions.removeAll'),
    danger: true,
  })
  if (!ok) return
  try {
    await packs.removeItems(
      p.id,
      pinned.map((i) => i.item),
    )
    ui.toast({
      message: i18n.tp('downloads.toast.surahsRemoved', pinned.length, { name: packs.title(p) }),
      tone: 'success',
    })
  } catch (e) {
    report(e)
  }
}

/** Removes one downloaded surah of a reciter (no confirmation: one click downloads it again). */
export async function removeSurah(p: PackInfo, surah: number): Promise<void> {
  try {
    await packs.removeItems(p.id, [surah])
    ui.toast({
      message: i18n.t('downloads.toast.surahRemoved', {
        surah: quran.surahName(surah),
        name: packs.title(p),
      }),
      tone: 'success',
    })
  } catch (e) {
    report(e)
  }
}

/** Plays a surah with this reciter (switching the reciter first when it is another one). */
export async function playSurah(reciterId: number, surah: number): Promise<void> {
  try {
    if (settings.value.reciterId !== reciterId) await player.setReciter(reciterId)
    const range = quran.surahRange(surah)
    await player.playRange(range.from, range.to)
  } catch (e) {
    report(e)
  }
}

export function openFolder(): void {
  app.revealDataDir().catch(report)
}

/**
 * The buttons of a pack row, in order (§9.7 actions on the end side). A job decides first (Pause/Stop, Resume,
 * Retry); without one: Update, Download or "Download the rest", and Remove.
 */
export function rowActions(p: PackInfo, job: JobSnapshot | undefined): PackAction[] {
  const online = canDownload()
  const t = (key: Parameters<typeof i18n.t>[0]) => i18n.t(key)
  const out: PackAction[] = []
  const stopAction: PackAction = {
    id: 'stop',
    label: t('downloads.actions.stop'),
    icon: X,
    run: () => void stop(p, job),
    style: 'icon',
    variant: 'ghost',
    disabled: job?.phase === 'installing',
  }
  if (packs.isWaiting(p.id)) {
    out.push({
      id: 'cancel',
      label: t('common.cancel'),
      icon: X,
      run: () => cancelWaiting(p),
      style: 'icon',
      variant: 'ghost',
    })
    return out
  }
  if (job && isActivePhase(job.phase)) {
    out.push({
      id: 'pause',
      label: t('downloads.actions.pause'),
      icon: Pause,
      run: () => pause(p),
      style: 'icon',
      variant: 'ghost',
      disabled: job.phase === 'installing',
    })
    out.push(stopAction)
    return out
  }
  if (job?.phase === 'paused') {
    out.push({
      id: 'resume',
      label: t('downloads.actions.resume'),
      icon: Play,
      run: () => resume(p),
      style: 'text',
      variant: 'secondary',
      disabled: !online,
    })
    out.push(stopAction)
    return out
  }
  if (job?.phase === 'failed') {
    out.push({
      id: 'retry',
      label: t('downloads.actions.retry'),
      icon: RotateCw,
      run: () => retry(p),
      style: 'text',
      variant: 'secondary',
      disabled: !online,
    })
    out.push(stopAction)
    return out
  }
  const removeAction: PackAction = {
    id: 'remove',
    label: t('downloads.actions.remove'),
    icon: Trash,
    run: () => void remove(p),
    style: 'icon',
    variant: 'ghost',
    danger: true,
  }
  if (p.state.type === 'update_available') {
    out.push({
      id: 'update',
      label: t('downloads.actions.update'),
      icon: CircleArrowUp,
      run: () => update(p),
      style: 'text',
      variant: 'primary',
      disabled: !online,
    })
    out.push(removeAction)
    return out
  }
  if (p.state.type === 'installed') {
    out.push(removeAction)
    return out
  }
  const some = hasContent(p) || (packs.items.get(p.id)?.some((i) => i.kib > 0) ?? false)
  if (p.kind !== 'recitation') {
    out.push({
      id: some && p.installMode === 'on_demand' ? 'downloadRest' : 'download',
      label:
        p.installMode === 'on_demand'
          ? some
            ? i18n.t('downloads.actions.downloadRestSize', { size: i18n.bytes(packs.remainingKib(p)) })
            : t('downloads.actions.downloadAll')
          : t('downloads.actions.download'),
      icon: Download,
      run: () => download(p),
      style: 'text',
      variant: 'secondary',
      disabled: !online,
    })
  }
  if (some) out.push(removeAction)
  return out
}

/** The pack row's context menu (§10.3): the row's actions, then Open folder. */
export function rowMenu(p: PackInfo, job: JobSnapshot | undefined): MenuEntry[] {
  const entries: MenuEntry[] = rowActions(p, job).map((a) => ({
    id: a.id,
    label: a.label,
    icon: a.icon,
    disabled: a.disabled,
    danger: a.danger,
    onSelect: a.run,
  }))
  if (p.kind === 'recitation' && !job) {
    const rest = packs.remainingKib(p)
    if (rest > 0) {
      entries.unshift({
        id: 'downloadAll',
        label: i18n.t('downloads.actions.downloadAllSize', { size: i18n.bytes(rest) }),
        icon: Download,
        disabled: !canDownload(),
        onSelect: () => download(p),
      })
    }
  }
  entries.push({ type: 'separator', id: 'sep' })
  entries.push({
    id: 'openFolder',
    label: i18n.t('downloads.actions.openFolder'),
    icon: FolderOpen,
    onSelect: openFolder,
  })
  return entries
}
