/// <reference types="vite/client" />

import type { CardroomApi } from '../preload/index.ts'

declare global {
  interface Window {
    cardroom: CardroomApi
  }
}

export {}
