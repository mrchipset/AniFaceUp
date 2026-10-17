/**
 * Persistence for user-tunable UI settings.
 *
 * Reads/writes a versioned record in `localStorage`. Any malformed, partial or
 * stale payload is treated as "no saved settings" rather than throwing, so a
 * bad value can never break boot.
 */
import {
  SETTINGS_KEY,
  SETTINGS_VERSION,
  type MaskShape,
  type PersistedSettings,
} from '../config'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBool(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isMask(value: unknown): value is MaskShape {
  return value === 'none' || value === 'round' || value === 'circle'
}

/** Strict shape validation for a persisted payload. */
function isSettings(value: unknown): value is PersistedSettings {
  if (!isRecord(value) || value.version !== SETTINGS_VERSION) return false

  const { blur, composite, selection, transform } = value
  if (!isBool(value.mirror) || !isBool(value.landmarks) || !isBool(value.mesh)) return false
  if (!isBool(value.pipEnabled) || !isBool(value.minimizeToTray)) return false

  if (
    !isRecord(blur) ||
    !isBool(blur.on) ||
    !isBool(blur.invert) ||
    !isNum(blur.px)
  ) {
    return false
  }

  if (
    !isRecord(composite) ||
    !isBool(composite.on) ||
    !isNum(composite.size) ||
    !isNum(composite.dx) ||
    !isNum(composite.dy)
  ) {
    return false
  }

  if (
    !isRecord(selection) ||
    !isNum(selection.w) ||
    !isNum(selection.h) ||
    !isNum(selection.cx) ||
    !isNum(selection.cy) ||
    !isNum(selection.mul) ||
    !isMask(selection.mask) ||
    !isNum(selection.radius) ||
    !isNum(selection.feather) ||
    !isBool(selection.keepAspect)
  ) {
    return false
  }

  if (
    !isRecord(transform) ||
    !isNum(transform.scale) ||
    !isNum(transform.x) ||
    !isNum(transform.y) ||
    !isNum(transform.z)
  ) {
    return false
  }

  return true
}

/** Load saved settings, or `null` when absent/invalid. Never throws. */
export function loadSettings(): PersistedSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSettings(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Persist settings. Never throws (storage may be unavailable/quota-capped). */
export function saveSettings(settings: PersistedSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Ignore: persistence is best-effort and must not disrupt the app.
  }
}
