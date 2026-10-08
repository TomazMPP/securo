import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { i18nReady } from './lib/i18n'
import App from './App.tsx'

// A tab opened before a deploy still references the previous build's
// hashed chunks, which no longer exist on the server. Reload once to pick
// up the new build instead of leaving a white screen; the timestamp guard
// stops a reload loop if the chunk is genuinely missing.
const PRELOAD_RELOAD_KEY = 'securo.preloadErrorReloadAt'
window.addEventListener('vite:preloadError', (event) => {
  let last = 0
  try {
    last = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) || 0)
  } catch {
    // Storage unavailable: fall through and let the error surface.
    return
  }
  if (Date.now() - last < 10_000) return
  event.preventDefault()
  sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()))
  window.location.reload()
})

// Honour a persisted language before rendering any translated UI.
void i18nReady.then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
