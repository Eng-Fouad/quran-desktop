/** The part of pngjs 7 (no bundled types) that the QA harness uses: synchronous PNG decode and encode. */
declare module 'pngjs' {
  export class PNG {
    constructor(options: { width: number; height: number })
    width: number
    height: number
    /** RGBA, 4 bytes per pixel. */
    data: Buffer
    static sync: {
      read(buffer: Buffer): PNG
      write(png: PNG): Buffer
    }
  }
}
