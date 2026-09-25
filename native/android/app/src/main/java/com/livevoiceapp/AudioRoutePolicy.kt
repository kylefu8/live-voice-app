package com.livevoiceapp

/** Pure priority rule: preserve a system-selected headset; proximity changes
 * only built-in devices, never steals the route from an external device. */
internal data class RouteCandidate(val id: Int, val external: Boolean, val receiver: Boolean = false, val speaker: Boolean = false)

internal fun chooseAudioRoute(devices: List<RouteCandidate>, currentId: Int?, near: Boolean): Int? {
  devices.firstOrNull { it.id == currentId && it.external }?.let { return it.id }
  devices.firstOrNull { it.external }?.let { return it.id }
  if (near) devices.firstOrNull { it.receiver }?.let { return it.id }
  return devices.firstOrNull { it.speaker }?.id ?: devices.firstOrNull { it.id == currentId }?.id
}
