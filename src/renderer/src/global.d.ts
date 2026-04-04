import type { NovelApi } from '../../shared/novel-api'

declare global {
  interface Window {
    /** 由 preload 注入；预加载失败时为 undefined */
    novel?: NovelApi
  }
}

export {}
