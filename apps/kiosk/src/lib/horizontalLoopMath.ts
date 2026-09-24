/** Return the nearest periodic copy of `target` to `current` on a looping timeline. */
export function nearestLoopTime(current: number, target: number, duration: number): number {
  if (![current, target, duration].every(Number.isFinite) || duration <= 0) return target;
  let delta = target - current;
  if (Math.abs(delta) > duration / 2) delta += delta < 0 ? duration : -duration;
  return current + delta;
}
