/**
 * Entry point (§7.1, §7.8; WP0C, frozen). Order: select the IPC implementation, load the bundled Quran fonts and the
 * bootstrap in parallel, initialise every store, mount, then tell Rust to show the window after the first paint
 * (`window_ready`, §2.8.2). Any failure before mounting shows the fatal screen instead of a blank window.
 */
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { api, call, initIpc } from '$lib/ipc'
import { app, fonts, initStores } from '$lib/stores'
import { loadBundledFaces } from '$lib/stores/fonts.svelte'

async function start(): Promise<void> {
  const target = document.getElementById('app')
  if (!target) throw new Error('#app is missing from index.html')
  try {
    await initIpc()
    const [bootstrap] = await Promise.all([call(api.appBootstrap()), loadBundledFaces()])
    await initStores(bootstrap)
    // Settings' init may have set the Arabic UI's lang and dir, which makes WebKit drop the faces just loaded.
    await fonts.settleBundledFaces()
  } catch (e) {
    app.failBootstrap(e)
  }
  mount(App, { target })
  app.markReady()
}

start().catch((e: unknown) => console.error('Quran failed to start', e))
