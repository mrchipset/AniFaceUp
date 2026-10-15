/**
 * Root-absolute asset path helper.
 *
 * Vite `base` is `/`, so bundled `public/` assets resolve root-absolute
 * (`/mediapipe/...`, `/models/...`) in dev and in the packaged app.
 */
export function asset(p: string): string {
  const base = import.meta.env.BASE_URL
  return base + String(p).replace(/^\/+/, '')
}
