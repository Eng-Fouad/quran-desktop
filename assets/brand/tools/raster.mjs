// @ts-check
/**
 * The browser side of the brand pipeline: the locally installed Microsoft Edge through playwright-core (channel
 * `msedge`; nothing is downloaded). It does two things only:
 *  - decode the source artwork (WebP) to exact, straight-alpha RGBA pixels;
 *  - screenshot the HTML review sheet.
 * Every other pixel operation is plain JavaScript (pixels.mjs), so the outputs do not depend on the browser build.
 *
 * Decoding goes through a WebGL texture upload with UNPACK_PREMULTIPLY_ALPHA off and no colour conversion: Chromium
 * then decodes the original bytes without premultiplying, and readPixels returns them unchanged (verified identical to
 * libwebp/Pillow for the source, including the colour under transparent pixels). Without WebGL it falls back to a
 * 2D canvas, which is exact for opaque pixels and premultiplied-exact for the rest.
 * Override the channel with QD_BROWSER_CHANNEL (e.g. `chrome`, or `bundled` for Playwright's own chromium).
 */
/* global document, getComputedStyle, Image, requestAnimationFrame, Blob, URL, atob, btoa, isSecureContext */
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { chromium } from 'playwright-core'

/** @typedef {import('playwright-core').Browser} Browser */
/** @typedef {import('playwright-core').Page} Page */

/** A secure origin (served by page.route, no network) so every decoding API is available. */
const ORIGIN = 'http://localhost/qd-brand/'

export class Rasteriser {
  /** @type {Browser | undefined} */
  #browser

  async #launch() {
    if (this.#browser) return this.#browser
    const env = process.env.QD_BROWSER_CHANNEL
    const channel = env === 'bundled' ? undefined : (env ?? 'msedge')
    try {
      this.#browser = await chromium.launch({
        channel,
        headless: true,
        args: ['--disable-gpu', '--force-color-profile=srgb', '--disable-lcd-text'],
      })
    } catch (e) {
      throw new Error(
        `could not launch the "${channel ?? 'bundled chromium'}" browser (set QD_BROWSER_CHANNEL): ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      )
    }
    return this.#browser
  }

  /** @param {{ width: number, height: number }} viewport @returns {Promise<Page>} */
  async #page(viewport) {
    const browser = await this.#launch()
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
    await page.route(`${ORIGIN}**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>brand</title>' }),
    )
    await page.goto(ORIGIN)
    return page
  }

  /**
   * Decode an image file (WebP, PNG) to straight-alpha RGBA.
   * @param {Buffer} bytes
   * @param {string} mime
   * @returns {Promise<{ width: number, height: number, data: Buffer, method: string }>}
   */
  async decode(bytes, mime) {
    const page = await this.#page({ width: 64, height: 64 })
    try {
      const res = await page.evaluate(
        async ({ b64, type }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bin], { type }))
          const img = new Image()
          img.src = url
          await img.decode()
          const w = img.naturalWidth
          const h = img.naturalHeight
          let px = new Uint8Array(w * h * 4)
          let method = 'webgl'
          const glCanvas = document.createElement('canvas')
          glCanvas.width = w
          glCanvas.height = h
          const gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })
          if (gl) {
            const tex = gl.createTexture()
            gl.bindTexture(gl.TEXTURE_2D, tex)
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
            gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, img)
            const fb = gl.createFramebuffer()
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px)
          } else {
            method = 'canvas2d'
            const c = document.createElement('canvas')
            c.width = w
            c.height = h
            const ctx = c.getContext('2d', { willReadFrequently: true })
            if (!ctx) throw new Error('no 2D canvas')
            ctx.drawImage(img, 0, 0)
            px = new Uint8Array(ctx.getImageData(0, 0, w, h, { colorSpace: 'srgb' }).data.buffer)
          }
          URL.revokeObjectURL(url)
          let s = ''
          for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000))
          return { width: w, height: h, data: btoa(s), method, secure: isSecureContext }
        },
        { b64: bytes.toString('base64'), type: mime },
      )
      const data = Buffer.from(res.data, 'base64')
      if (data.length !== res.width * res.height * 4) throw new Error('decode: short pixel buffer')
      return { width: res.width, height: res.height, data, method: res.method }
    } finally {
      await page.close()
    }
  }

  /**
   * Screenshot an HTML document (the review sheet).
   * @param {string} html
   * @param {{ width: number, height: number }} viewport
   */
  async screenshotHtml(html, viewport) {
    const page = await this.#page(viewport)
    try {
      await page.setContent(html)
      await page.waitForFunction(() => [...document.images].every((i) => i.complete))
      // CSS images (masks, backgrounds) have no load event: decode each data: URL once, then give paint a frame.
      await page.evaluate(async () => {
        const urls = new Set()
        for (const el of document.querySelectorAll('*')) {
          const style = getComputedStyle(el)
          for (const v of [style.maskImage, style.backgroundImage])
            for (const m of v.matchAll(/url\("([^"]+)"\)/g)) if (m[1]) urls.add(m[1])
        }
        await Promise.all(
          [...urls].map((src) => {
            const img = new Image()
            img.src = src
            return img.decode().catch(() => undefined)
          }),
        )
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      })
      return await page.screenshot({ fullPage: true })
    } finally {
      await page.close()
    }
  }

  async close() {
    await this.#browser?.close()
    this.#browser = undefined
  }
}
