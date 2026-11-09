export type GalleryEntryPlan = { animate: boolean; index: number }
export type GalleryEntryClaim = GalleryEntryPlan & { albumId: string; applied: boolean }
export type GalleryIntroSample = { phase: 'sweep' | 'arrive'; position: number }

// Long enough to read as a stop, at the first photo and again on the last.
export const galleryIntroHoldMs = 480

// A search gesture: drift off the current photo, flick through the rest, then
// settle onto the target. The middle is a scrub, not a pace meant to be read.
const galleryIntroShoulderMs = 400
const galleryIntroShoulderPhotos = 0.42
const galleryIntroCruiseMs = 36
const galleryIntroSlideCapMs = 4800

function galleryIntroSlidePlan(distance: number) {
  const span = Math.max(0, distance)
  const shoulder = span === 0 ? 0 : Math.min(galleryIntroShoulderPhotos, span * 0.3)
  const cruise = Math.max(0, span - shoulder * 2)
  let cruiseMs = cruise * galleryIntroCruiseMs
  if (galleryIntroShoulderMs * 2 + cruiseMs > galleryIntroSlideCapMs && cruise > 0) {
    cruiseMs = galleryIntroSlideCapMs - galleryIntroShoulderMs * 2
  }
  return { shoulder, cruise, cruiseMs, duration: span === 0 ? 0 : galleryIntroShoulderMs * 2 + cruiseMs }
}

export function galleryIntroSlideMs(distance: number) {
  return galleryIntroSlidePlan(distance).duration
}

export function galleryIntroSlideOffset(elapsed: number, distance: number) {
  const plan = galleryIntroSlidePlan(distance)
  if (plan.duration === 0) return 0
  const time = Math.min(plan.duration, Math.max(0, elapsed))
  if (time <= galleryIntroShoulderMs) {
    const u = time / galleryIntroShoulderMs
    return plan.shoulder * u * u
  }
  if (time >= galleryIntroShoulderMs + plan.cruiseMs) {
    const u = Math.min(1, (time - galleryIntroShoulderMs - plan.cruiseMs) / galleryIntroShoulderMs)
    return plan.shoulder + plan.cruise + plan.shoulder * (1 - (1 - u) * (1 - u))
  }
  return plan.shoulder + plan.cruise * ((time - galleryIntroShoulderMs) / plan.cruiseMs)
}

export function galleryIntroSweepMs(count: number) {
  return galleryIntroSlideMs(Math.max(0, Math.floor(count) - 1))
}

export function galleryIntroReturnMs(count: number, index: number) {
  const end = Math.max(0, Math.floor(count) - 1)
  const choice = Math.max(0, Math.min(end, Math.floor(index)))
  return galleryIntroSlideMs(Math.abs(end - choice))
}

export function galleryNavigationType(clock: {
  getEntriesByType?: (type: string) => ArrayLike<{ type?: string } | object>
  navigation?: { type?: number }
} | undefined) {
  const first = clock?.getEntriesByType?.('navigation')?.[0]
  const timing = first && 'type' in first && typeof first.type === 'string' ? first.type : undefined
  if (timing) return timing
  const legacy = clock?.navigation?.type
  if (legacy === 1) return 'reload'
  if (legacy === 2) return 'back_forward'
  if (legacy === 0) return 'navigate'
  return undefined
}

export function planGalleryEntry(input: {
  count: number
  navigationType: string | undefined
  reducedMotion: boolean
  random: number
}): GalleryEntryPlan {
  const count = Math.max(0, Math.floor(input.count))
  if (count === 0) return { animate: false, index: 0 }
  const fresh = input.navigationType !== 'reload' && input.navigationType !== 'back_forward'
  const index = fresh ? Math.min(count - 1, Math.floor(Math.max(0, input.random) * count)) : 0
  return { animate: fresh && !input.reducedMotion && count >= 2, index }
}

// The first visit chooses once. Later albums and repeated mounts reuse that choice.
export function claimGalleryEntry(claim: GalleryEntryClaim | null, input: {
  albumId: string
  count: number
  navigationType: string | undefined
  reducedMotion: boolean
  random: number
}) {
  if (claim) {
    return {
      claim,
      current: claim.albumId === input.albumId
        ? { animate: claim.animate, index: claim.index }
        : { animate: false, index: 0 },
    }
  }
  const current = planGalleryEntry(input)
  return { claim: { albumId: input.albumId, ...current, applied: false }, current }
}

export function galleryIntroSample(elapsed: number, count: number, index: number): GalleryIntroSample {
  const end = Math.max(0, Math.floor(count) - 1)
  const choice = Math.max(0, Math.min(end, Math.floor(index)))
  const sweepMs = galleryIntroSweepMs(count)
  const returnMs = galleryIntroReturnMs(count, choice)
  const time = Math.max(0, elapsed)
  if (end === 0 || sweepMs === 0) return { phase: 'arrive', position: choice }
  if (time < galleryIntroHoldMs) return { phase: 'sweep', position: 0 }
  const travel = time - galleryIntroHoldMs
  if (travel < sweepMs) return { phase: 'sweep', position: galleryIntroSlideOffset(travel, end) }
  const afterSweep = travel - sweepMs
  if (afterSweep < galleryIntroHoldMs) return { phase: 'sweep', position: end }
  const returning = afterSweep - galleryIntroHoldMs
  // Summing the earlier phases can miss an exact end by a fraction of a millisecond.
  if (returnMs === 0 || returning >= returnMs - 1e-4) return { phase: 'arrive', position: choice }
  const span = Math.abs(choice - end)
  const direction = choice < end ? -1 : 1
  return { phase: 'sweep', position: end + direction * galleryIntroSlideOffset(returning, span) }
}
