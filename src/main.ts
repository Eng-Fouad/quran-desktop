/**
 * Entry point (§7.1, §7.8; WP0C, frozen). Order: select the IPC implementation, load the bundled Quran fonts and the
 * bootstrap in parallel, initialise every store, mount, then tell Rust to show the window after the first paint
 * (`window_ready`, §2.8.2). Any failure before mounting shows the fatal screen instead of a blank window.
 */
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { api, call, initIpc } from '$lib/ipc'
import { app, initStores } from '$lib/stores'

/**
 * Waits for the bundled faces (§8.5): the Hafs font, so the first paint never shows a system-font flash, and the
 * print's furniture labels (LEAD 25), so the running heads and margin labels never change after it (CLS 0). The fonts
 * store reads which of them loaded (`fonts.printLabelsReady`); a face that failed leaves the Hafs text in its place.
 */
async function loadQuranFont(): Promise<void> {
  const faces = [
    ['qd-hafs', 'بسم'],
    ['qd-print-labels', String.fromCodePoint(0xf800 + 1)],
  ] as const
  await Promise.all(
    faces.map(async ([family, text]) => {
      try {
        await document.fonts.load(`32px "${family}"`, text)
      } catch (e) {
        console.warn(`${family} did not load before the first paint`, e)
      }
    }),
  )
}

async function start(): Promise<void> {
  const target = document.getElementById('app')
  if (!target) throw new Error('#app is missing from index.html')
  try {
    await initIpc()
    const [bootstrap] = await Promise.all([call(api.appBootstrap()), loadQuranFont()])
    await initStores(bootstrap)
  } catch (e) {
    app.failBootstrap(e)
  }
  mount(App, { target })
  app.markReady()
}

start().catch((e: unknown) => console.error('Quran failed to start', e))
