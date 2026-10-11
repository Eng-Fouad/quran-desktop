/**
 * Entry point (§7.1, §7.8; WP0C, frozen). Order: select the IPC implementation, load the bundled Quran font and the
 * bootstrap in parallel, initialise every store, mount, then tell Rust to show the window after the first paint
 * (`window_ready`, §2.8.2). Any failure before mounting shows the fatal screen instead of a blank window.
 */
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { api, call, initIpc } from '$lib/ipc'
import { app, initStores } from '$lib/stores'

/** Waits for the bundled Hafs font (§8.5), so the first paint never shows a system-font flash. */
async function loadQuranFont(): Promise<void> {
  try {
    await document.fonts.load('32px "qd-hafs"', 'بسم')
  } catch (e) {
    console.warn('qd-hafs did not load before the first paint', e)
  }
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
