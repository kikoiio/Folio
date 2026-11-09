'use client'

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import type { GalleryAlbum, GalleryPhoto } from '../lib/gallery-types'
import { filmstripLayout, filmstripTransform } from '../lib/filmstrip-layout.mjs'
import { MOBILE_QUERY, galleryDragTarget, galleryDragDestination, gallerySwipeDirection, type GalleryAxis, type GallerySwipe, type GalleryDragOrigin } from '../lib/gallery-gestures'
import { claimGalleryEntry, galleryIntroSample, galleryNavigationType, type GalleryEntryClaim } from '../lib/gallery-intro'
import { advanceFilmstrip, heroImage, photoSources, sameFrameWindow, sameSettlement, requestedPhoto, settledPhoto, settledSource, thumbnailSource, type FilmstripMotion, type GalleryViewport, type SettledPhoto } from '../lib/gallery-performance'
import { currentAlbum, rememberAlbum, rememberPhoto, subscribeAlbum } from '../lib/gallery-navigation'
import { allowPhotoPrefetch, photoCache } from '../lib/gallery-photo-cache'
import styles from './page.module.css'

type PanelStyle = CSSProperties & { '--paint-reveal': number; '--panel-side': string }
type Frame = ReturnType<typeof filmstripLayout>[number]
type FilmstripView = { frames: Frame[]; activeIndex: number; moving: boolean; introducing: boolean; settled: SettledPhoto | null; requested: SettledPhoto | null }

let entryClaim: GalleryEntryClaim | null = null
type PhotographSource = { kind: 'responsive'; image: ReturnType<typeof heroImage> } | { kind: 'fixed'; src: string }
type TouchGesture = GallerySwipe & { kind: 'pending' | 'dragging' }

const clamp = (value: number) => Math.max(0, Math.min(1, value))
const smooth = (value: number) => value * value * (3 - 2 * value)
const positions = new Map<string, number>()
const emptyViewport: GalleryViewport = { width: 0, height: 0, dpr: 1, fit: 'cover' }

const Photograph = memo(function Photograph({ image, active, hero, requested, isRequested, previousPhoto, nextPhoto, reading }: {
  image: GalleryPhoto
  active: boolean
  hero: boolean
  requested: SettledPhoto | null
  isRequested: (target: SettledPhoto) => boolean
  previousPhoto: GalleryPhoto | undefined
  nextPhoto: GalleryPhoto | undefined
  reading: boolean
}) {
  const element = useRef<HTMLImageElement>(null)
  const [loadedSource, setLoadedSource] = useState<ReturnType<typeof photoSources>[number] | null>(null)
  const [source, setSource] = useState<PhotographSource>(() => {
    const recalled = photoCache.recalled(image)
    return recalled ? { kind: 'fixed', src: recalled.src } : hero
      ? { kind: 'responsive', image: heroImage(image) }
      : { kind: 'fixed', src: thumbnailSource(image) }
  })
  const rememberLoaded = useCallback(() => {
    const node = element.current
    if (!node?.complete || !node.naturalWidth) return
    const loaded = photoSources(image).find(candidate => new URL(candidate.src, document.baseURI).href === node.currentSrc)
    if (loaded) {
      photoCache.remember(image, loaded)
      setLoadedSource(loaded)
    }
  }, [image])
  useEffect(rememberLoaded, [rememberLoaded])

  useEffect(() => {
    // The initial responsive hero already has a browser-selected request. Do not
    // compete with it or add a second preload (React 19 can emit one itself).
    if (!requested || (requested.revision === 0 && source.kind === 'responsive')) return
    const next = settledSource(image, requested.viewport)
    const node = element.current
    if (node?.complete && node.naturalWidth > 0) {
      const currentSrc = node.currentSrc
      const current = photoSources(image).find(candidate => new URL(candidate.src, document.baseURI).href === currentSrc)
      if (current && current.width >= next.width) return
      if (new URL(next.src, document.baseURI).href === currentSrc) return
    }
    let cancelled = false
    void photoCache.decode(image, next).then(decoded => {
      // A new destination invalidates the decode before React commits it.
      // The selected image can become sharp while its animation is running.
      if (decoded && !cancelled && isRequested(requested)) setSource({ kind: 'fixed', src: next.src })
    })
    return () => { cancelled = true }
  }, [image, requested, isRequested, source.kind])

  useEffect(() => {
    if (reading || !requested || !loadedSource || loadedSource.width < settledSource(image, requested.viewport).width
      || !allowPhotoPrefetch('connection' in navigator ? navigator.connection : undefined)) return
    let cancelled = false
    const timer = setTimeout(async () => {
      // Finish the selected image first, then warm at most two neighbours in order.
      for (const neighbour of [nextPhoto, previousPhoto]) {
        if (cancelled || !isRequested(requested)) break
        if (!neighbour) continue
        const target = settledSource(neighbour, requested.viewport)
        const recalled = photoCache.recalled(neighbour)
        await photoCache.decode(neighbour, recalled && recalled.width >= target.width ? recalled : target, 'low')
      }
    }, 200)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [image, requested, loadedSource, previousPhoto, nextPhoto, isRequested, reading])

  const attributes = source.kind === 'responsive' ? source.image : { src: source.src }
  const upgrading = requested !== null && source.kind === 'fixed'
    && (photoSources(image).find(candidate => candidate.src === source.src)?.width ?? 0) < settledSource(image, requested.viewport).width
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Next's unoptimized Image discards the archive's responsive srcSet.
    <img
      ref={element}
      {...attributes}
      alt={image.alt}
      aria-hidden={!active}
      width={image.width}
      height={image.height}
      className={styles.photo}
      loading="eager"
      fetchPriority={active && (source.kind === 'responsive' || requested) ? 'high' : 'auto'}
      decoding="async"
      onLoad={rememberLoaded}
      data-upgrading={upgrading}
      draggable={false}
    />
  )
})

function paintFrame(node: HTMLAnchorElement, frame: Frame, axis: GalleryAxis) {
  node.style.transform = filmstripTransform(frame, axis)
  node.style.zIndex = String(frame.layer)
}

function useFilmstrip(photos: GalleryPhoto[], initialIndex: number, albumId: string, reading: boolean) {
  const count = photos.length
  const viewport = useRef<HTMLElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const strip = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<number, HTMLAnchorElement>())
  const dimensions = useRef(emptyViewport)
  const photoExtents = useRef<number[]>([])
  const axis = useRef<GalleryAxis>('horizontal')
  const drag = useRef<(GalleryDragOrigin & { selected: number; target: number }) | null>(null)
  const [view, setView] = useState<FilmstripView>(() => ({
    frames: filmstripLayout(initialIndex, 0, count, 0),
    activeIndex: initialIndex,
    moving: false,
    introducing: false,
    settled: { slot: initialIndex, revision: 0, viewport: emptyViewport },
    requested: null,
  }))
  const published = useRef(view)
  const layout = useRef(view.frames)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const introFrame = useRef(0)
  const introRun = useRef(0)
  const introActive = useRef(false)
  const readingNow = useRef(reading)
  readingNow.current = reading
  const motion = useRef<FilmstripMotion & { frame: number; lastTime: number }>({
    position: initialIndex, target: initialIndex, zoom: 0, zoomTarget: 0,
    focus: false, revision: 0, frame: 0, lastTime: 0,
  })

  const paint = useCallback(() => {
    const state = motion.current
    const reveal = smooth(state.zoom)
    const frames = filmstripLayout(state.position, reveal, count,
      axis.current === 'vertical' ? dimensions.current.height : dimensions.current.width, photoExtents.current)
    layout.current = frames
    const activeIndex = Math.round(state.position)
    const moving = state.position !== state.target || state.zoom !== state.zoomTarget
    const introducing = introActive.current
    const settled = settledPhoto(state, dimensions.current)
    const requested = requestedPhoto(state, dimensions.current)
    const previous = published.current
    if (previous.activeIndex !== activeIndex || previous.moving !== moving || previous.introducing !== introducing
      || !sameFrameWindow(previous.frames, frames) || !sameSettlement(previous.settled, settled)
      || !sameSettlement(previous.requested, requested)) {
      const next = { frames, activeIndex, moving, introducing, settled, requested }
      published.current = next
      // Commit only discrete boundaries, before painting the new geometry. New
      // visible nodes/thumbnails and data-moving must land in the same paint.
      flushSync(() => setView(next))
    }
    const photo = photos[activeIndex]
    if (!photo) return
    const weight = (1 - reveal) * 100
    // All layout reads happened in ResizeObserver; this batch only writes styles.
    if (viewport.current) {
      viewport.current.style.backgroundColor = `color-mix(in srgb, ${photo.backdrop} ${weight}%, #e5e1e4)`
      viewport.current.style.color = `color-mix(in srgb, ${photo.ink} ${weight}%, #ededed)`
    }
    if (panel.current) {
      panel.current.style.backgroundColor = photo.swatch
      panel.current.style.setProperty('--paint-reveal', String(reveal))
      panel.current.style.setProperty('--panel-side', `color-mix(in srgb, ${photo.swatch} ${weight}%, #b4a0ad)`)
    }
    for (const frame of frames) {
      const node = nodes.current.get(frame.slot)
      if (node) paintFrame(node, frame, axis.current)
    }
  }, [count, photos])

  const tick = useCallback(function tick(time: number) {
    const state = motion.current
    if (introActive.current) {
      paint()
      state.frame = 0
      return
    }
    const elapsed = time - state.lastTime
    state.lastTime = time
    advanceFilmstrip(state, elapsed)
    paint()
    state.frame = state.position !== state.target || state.zoom !== state.zoomTarget
      ? requestAnimationFrame(tick) : 0
  }, [paint])

  const schedule = useCallback(() => {
    const state = motion.current
    if (state.frame) return
    state.lastTime = performance.now()
    state.frame = requestAnimationFrame(tick)
  }, [tick])

  const stopIntro = useCallback((consume: boolean) => {
    const active = introActive.current
    introRun.current += 1
    introActive.current = false
    cancelAnimationFrame(introFrame.current)
    introFrame.current = 0
    if (!consume || !active) return
    const state = motion.current
    state.target = state.position
    state.zoomTarget = state.zoom
    state.focus = false
    if (entryClaim) {
      entryClaim.animate = false
      entryClaim.applied = true
    }
  }, [])

  const moveTo = useCallback((target: number, zoomTarget = 0, focus = false, scripted = false) => {
    if (!scripted) stopIntro(true)
    clearTimeout(idleTimer.current)
    const state = motion.current
    state.revision++
    state.target = Math.max(0, Math.min(count - 1, target))
    state.focus = focus
    state.zoomTarget = focus ? state.zoom : zoomTarget
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      cancelAnimationFrame(state.frame)
      state.frame = 0
      state.position = Math.round(state.target)
      state.target = state.position
      state.zoom = zoomTarget
      state.zoomTarget = zoomTarget
      state.focus = false
    }
    schedule()
  }, [count, schedule, stopIntro])

  const moveToRef = useRef(moveTo)
  moveToRef.current = moveTo

  const beginDrag = useCallback(() => {
    if (count < 2) return
    stopIntro(true)
    const state = motion.current
    drag.current = { position: state.position, zoom: state.zoom, selected: state.target, target: state.position }
  }, [count, stopIntro])

  const dragTo = useCallback((distance: number) => {
    const origin = drag.current
    if (!origin) return
    const length = axis.current === 'vertical' ? dimensions.current.height : dimensions.current.width
    const next = galleryDragTarget(origin, distance, length, count)
    origin.target = next.target
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) moveTo(next.target, next.zoomTarget)
  }, [count, moveTo])

  const finishDrag = useCallback((direction: -1 | 0 | 1 = 0) => {
    const origin = drag.current
    drag.current = null
    if (!origin) return
    moveTo(galleryDragDestination(origin.selected, origin.target, direction, count), 0, true)
  }, [count, moveTo])

  useEffect(() => {
    const element = viewport.current
    const filmstrip = strip.current
    if (!element || !filmstrip) return
    const resizeObserver = new ResizeObserver(entries => {
      const bounds = entries[0]?.contentRect
      if (!bounds) return
      const nextAxis = window.matchMedia(MOBILE_QUERY).matches ? 'vertical' : 'horizontal'
      if (axis.current !== nextAxis) finishDrag()
      axis.current = nextAxis
      dimensions.current = {
        width: bounds.width,
        height: bounds.height,
        dpr: window.devicePixelRatio || 1,
        fit: getComputedStyle(filmstrip).getPropertyValue('--photo-fit').trim() === 'contain' ? 'contain' : 'cover',
      }
      photoExtents.current = nextAxis === 'vertical' && bounds.height > 0
        ? photos.map(photo => Math.min(1, bounds.width * photo.height / photo.width / bounds.height))
        : []
      schedule()
    })
    resizeObserver.observe(filmstrip)
    let reducedMotionUntil = 0
    const onWheel = (event: WheelEvent) => {
      if (element.dataset.reading === 'true') return
      if (count < 2 || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      if (event.target instanceof Element && event.target.closest('select, dialog')) return
      event.preventDefault()
      if (introActive.current) stopIntro(true)
      const direction = Math.sign(event.deltaY)
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        if (performance.now() < reducedMotionUntil) return
        reducedMotionUntil = performance.now() + 240
        moveTo(motion.current.target + direction)
        return
      }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1
      const distance = Math.min(Math.abs(event.deltaY * unit), 160)
      const state = motion.current
      // Spend the first part of the gesture revealing the strip, then browse it.
      const currentZoom = Math.max(state.zoom, state.zoomTarget)
      const zoomDistance = Math.min(distance, (1 - currentZoom) * 720)
      const zoomTarget = clamp(currentZoom + zoomDistance / 720)
      moveTo(state.target + direction * (distance - zoomDistance) / 520, zoomTarget)
      idleTimer.current = setTimeout(() => moveTo(Math.round(state.position), 0, true), 1300)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    const state = motion.current
    return () => {
      resizeObserver.disconnect()
      element.removeEventListener('wheel', onWheel)
      clearTimeout(idleTimer.current)
      cancelAnimationFrame(state.frame)
      state.frame = 0
    }
  }, [count, moveTo, schedule, finishDrag, photos, stopIntro])

  const snapTo = useCallback((index: number) => {
    const state = motion.current
    cancelAnimationFrame(state.frame)
    state.frame = 0
    state.position = index
    state.target = index
    state.zoom = 0
    state.zoomTarget = 0
    state.focus = false
    state.revision += 1
    paint()
  }, [paint])

  const playIntro = useCallback((index: number) => {
    const run = ++introRun.current
    introActive.current = true
    const state = motion.current
    state.position = 0
    state.target = Math.max(0, count - 1)
    state.zoom = 1
    state.zoomTarget = 1
    state.focus = false
    paint()
    let startedAt = 0
    const loop = (now: number) => {
      if (introRun.current !== run) return
      const measured = dimensions.current.width > 0
      if (!measured || startedAt === 0) {
        if (measured) startedAt = now
        introFrame.current = requestAnimationFrame(loop)
        return
      }
      if (entryClaim) {
        entryClaim.animate = false
        entryClaim.applied = true
      }
      const sample = galleryIntroSample(now - startedAt, count, index)
      if (sample.phase === 'arrive') {
        state.position = sample.position
        state.target = sample.position
        state.zoom = 1
        state.zoomTarget = 1
        paint()
        introActive.current = false
        introRun.current += 1
        cancelAnimationFrame(state.frame)
        state.frame = 0
        moveToRef.current(index, 1, true, true)
        return
      }
      state.position = sample.position
      state.target = sample.position
      state.zoom = 1
      state.zoomTarget = 1
      state.focus = false
      paint()
      introFrame.current = requestAnimationFrame(loop)
    }
    introFrame.current = requestAnimationFrame(loop)
    return () => {
      if (introRun.current !== run) return
      introRun.current += 1
      introActive.current = false
      cancelAnimationFrame(introFrame.current)
      introFrame.current = 0
    }
  }, [count, paint])

  useLayoutEffect(() => {
    let started = false
    let stop = () => {}
    const start = () => {
      if (started || readingNow.current || document.visibilityState === 'hidden'
        || (document as { prerendering?: boolean }).prerendering === true) return
      started = true
      const entry = claimGalleryEntry(entryClaim, {
        albumId,
        count,
        navigationType: galleryNavigationType(performance),
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        random: Math.random(),
      })
      entryClaim = entry.claim
      document.documentElement.removeAttribute('data-folio-entry')
      const ownsEntry = entry.claim.albumId === albumId
      if (ownsEntry && entry.current.animate) {
        stop = playIntro(entry.current.index)
        return
      }
      const restingIndex = Math.min(positions.get(albumId) ?? 0, Math.max(0, count - 1))
      if (ownsEntry && !entry.claim.applied && entry.current.index !== restingIndex) snapTo(entry.current.index)
      if (ownsEntry) entry.claim.applied = true
    }
    const wake = () => queueMicrotask(start)
    document.addEventListener('visibilitychange', wake)
    document.addEventListener('prerenderingchange', wake)
    window.addEventListener('hashchange', wake)
    start()
    return () => {
      document.removeEventListener('visibilitychange', wake)
      document.removeEventListener('prerenderingchange', wake)
      window.removeEventListener('hashchange', wake)
      stop()
    }
  }, [albumId, count, playIntro, snapTo])

  const registerFrame = useCallback((slot: number, node: HTMLAnchorElement | null) => {
    if (!node) { nodes.current.delete(slot); return }
    nodes.current.set(slot, node)
    const frame = layout.current.find(frame => frame.slot === slot)
    if (frame) paintFrame(node, frame, axis.current)
  }, [])
  const isRequested = useCallback((target: SettledPhoto) => sameSettlement(target, requestedPhoto(motion.current, dimensions.current)), [])
  const select = useCallback((index: number) => moveTo(index, 0, true), [moveTo])
  const step = useCallback((direction: number) => {
    if (introActive.current) stopIntro(true)
    moveTo(Math.round(motion.current.target) + direction, 0, true)
  }, [moveTo, stopIntro])
  return { viewport, panel, strip, axis, registerFrame, isRequested, ...view, select, step, beginDrag, dragTo, finishDrag }
}

export default function Gallery({ albums, reading, children }: {
  albums: GalleryAlbum[]
  reading: boolean
  children: ReactNode
}) {
  const albumId = useSyncExternalStore(subscribeAlbum, currentAlbum, () => '')
  const album = albums.find((item) => item.id === albumId) ?? albums[0]
  useLayoutEffect(() => {
    if (!album?.photos.length) document.documentElement.removeAttribute('data-folio-entry')
  }, [album])
  if (!album || !album.photos.length) {
    return <main id="content" tabIndex={-1} className={styles.stage} data-reading={reading}>
      <div className={styles.panelShell} data-content-panel><div className={styles.panel}>
        <p className={styles.empty}>还没有图片作品</p>{children}
      </div></div>
    </main>
  }
  return <AlbumGallery key={album.id} album={album} reading={reading}>{children}</AlbumGallery>
}

function AlbumGallery({ album, reading, children }: {
  album: GalleryAlbum
  reading: boolean
  children: ReactNode
}) {
  const { photos } = album
  const initialIndex = Math.min(positions.get(album.id) ?? 0, photos.length - 1)
  const { viewport, panel, strip, axis, frames, activeIndex, moving, introducing, settled, requested, isRequested, registerFrame, select, step, beginDrag, dragTo, finishDrag } = useFilmstrip(photos, initialIndex, album.id, reading)
  const gesture = useRef<TouchGesture | null>(null)
  const suppressClickUntil = useRef(0)
  const photo = photos[activeIndex]
  const cancelGesture = useCallback(() => {
    gesture.current = null
    suppressClickUntil.current = performance.now() + 350
    finishDrag()
  }, [finishDrag])
  useEffect(() => {
    const cancelMultiTouch = (event: PointerEvent) => {
      if (gesture.current && event.pointerType === 'touch' && !event.isPrimary) {
        cancelGesture()
        suppressClickUntil.current = Infinity
      }
    }
    document.addEventListener('pointerdown', cancelMultiTouch, true)
    return () => document.removeEventListener('pointerdown', cancelMultiTouch, true)
  }, [cancelGesture])
  useEffect(() => {
    if (reading) cancelGesture()
  }, [reading, cancelGesture])
  useEffect(() => {
    positions.set(album.id, activeIndex)
    rememberAlbum(album.id)
    rememberPhoto({ albumId: album.id, swatch: photo.swatch })
  }, [album.id, activeIndex, photo.swatch])
  // These establish the SSR colors only. Animation owns subsequent style writes.
  const [initialStyle] = useState(() => ({
    panel: { backgroundColor: photo.swatch, '--paint-reveal': 0, '--panel-side': photo.swatch } satisfies PanelStyle,
    stage: { backgroundColor: photo.backdrop, color: photo.ink } satisfies CSSProperties,
  }))

  return (
    <main id="content" tabIndex={-1} ref={viewport} className={styles.stage} style={initialStyle.stage} data-reading={reading} onKeyDown={event => {
      if (reading) return
      if (event.target instanceof Element && event.target.closest('select, dialog')) return
      const forward = event.key === 'ArrowRight' || (axis.current === 'vertical' && event.key === 'ArrowDown')
      const backward = event.key === 'ArrowLeft' || (axis.current === 'vertical' && event.key === 'ArrowUp')
      if (forward || backward) {
        event.preventDefault()
        step(forward ? 1 : -1)
      }
    }}>
      <div ref={panel} className={styles.panelShell} style={initialStyle.panel} data-content-panel>
        <div className={styles.panel}>
          <section className={styles.gallery} aria-label={album.title} aria-roledescription="图片轮播" aria-busy={introducing} inert={reading}>
            <div ref={strip} className={styles.filmstrip} data-moving={moving} data-settled={settled !== null}
              onPointerDown={event => {
                if (gesture.current && gesture.current.pointerId !== event.pointerId) return
                if (!event.isPrimary || event.button !== 0) return
                suppressClickUntil.current = 0
                if (event.pointerType === 'mouse') return
                gesture.current = {
                  kind: 'pending', pointerId: event.pointerId, x: event.clientX, y: event.clientY,
                  axis: window.matchMedia(MOBILE_QUERY).matches ? 'vertical' : 'horizontal',
                }
              }}
              onPointerMove={event => {
                const start = gesture.current
                if (!start || start.pointerId !== event.pointerId) return
                const currentAxis = window.matchMedia(MOBILE_QUERY).matches ? 'vertical' : 'horizontal'
                if (start.axis !== currentAxis) { cancelGesture(); return }
                const dx = event.clientX - start.x
                const dy = event.clientY - start.y
                const distance = start.axis === 'vertical' ? dy : dx
                const crossDistance = start.axis === 'vertical' ? dx : dy
                if (start.kind === 'pending') {
                  if (Math.hypot(dx, dy) < 10) return
                  if (Math.abs(distance) <= Math.abs(crossDistance) * 1.2) { cancelGesture(); return }
                  gesture.current = { ...start, kind: 'dragging' }
                  beginDrag()
                  event.currentTarget.setPointerCapture(event.pointerId)
                }
                suppressClickUntil.current = Infinity
                dragTo(-distance)
              }}
              onPointerCancel={event => {
                if (gesture.current?.pointerId === event.pointerId) cancelGesture()
              }}
              onLostPointerCapture={event => {
                if (event.target === event.currentTarget && gesture.current?.pointerId === event.pointerId) cancelGesture()
              }}
              onPointerUp={event => {
                const start = gesture.current
                if (!start || start.pointerId !== event.pointerId) return
                gesture.current = null
                if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
                  suppressClickUntil.current = performance.now() + 350
                }
                const direction = gallerySwipeDirection(start, {
                  pointerId: event.pointerId, x: event.clientX, y: event.clientY,
                  axis: window.matchMedia(MOBILE_QUERY).matches ? 'vertical' : 'horizontal',
                })
                if (start.kind === 'dragging') {
                  suppressClickUntil.current = performance.now() + 350
                  const sameAxis = start.axis === (window.matchMedia(MOBILE_QUERY).matches ? 'vertical' : 'horizontal')
                  if (sameAxis) dragTo(start.axis === 'vertical' ? start.y - event.clientY : start.x - event.clientX)
                  finishDrag(direction)
                } else if (direction) {
                  suppressClickUntil.current = performance.now() + 350
                  step(direction)
                }
              }}>
              {frames.map(frame => {
                const { slot } = frame
                const image = photos[slot]
                return (
                  <a
                    key={slot}
                    ref={node => registerFrame(slot, node)}
                    href={image.src}
                    className={styles.photoFrame}
                    data-active={slot === activeIndex}
                    data-visible={frame.visible}
                    aria-label={`放大第 ${slot + 1} 张图片`}
                    tabIndex={frame.visible ? 0 : -1}
                    onClick={event => {
                      event.preventDefault()
                      if (event.detail === 0 || performance.now() >= suppressClickUntil.current) select(slot)
                    }}
                    style={{ zIndex: frame.layer, transform: filmstripTransform(frame, axis.current) }}
                  >
                    {frame.visible && <Photograph image={image} active={slot === activeIndex}
                      hero={slot === initialIndex && settled?.revision === 0}
                      requested={requested?.slot === slot ? requested : null} isRequested={isRequested}
                      previousPhoto={photos[slot - 1]} nextPhoto={photos[slot + 1]} reading={reading} />}
                  </a>
                )
              })}
            </div>
          </section>
          {children}
        </div>
      </div>
    </main>
  )
}
