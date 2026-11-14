'use client'

import Image from 'next/image'
import { useLayoutEffect, useMemo, useRef, type MouseEvent, type SyntheticEvent } from 'react'
import { loadArticle, loadArticleIndex } from '../lib/article-data'
import { albumHref, albumTitle, articleHref, formatDate } from '../lib/article-links'
import type { ArticleIndex } from '../lib/article-types'
import type { GalleryAlbum } from '../lib/gallery-types'
import { openArticle, openWriting, type ReadingView } from '../lib/reading-navigation'
import { rememberReading } from '../lib/reading-progress'
import ArticleBody from './article-body'
import { useResource } from '../lib/use-resource'
import styles from './reading-overlay.module.css'

const emptyArticles: ArticleIndex = []

function findSection(root: HTMLElement | null, id: string | null) {
  return id ? root?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? null : null
}

export default function ReadingOverlay({ indexSrc, albums, view, autoFocus }: {
  indexSrc: string
  albums: GalleryAlbum[]
  view: Extract<ReadingView, { kind: 'article' }>
  autoFocus: boolean
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const pageFrame = useRef<HTMLIFrameElement>(null)
  const allowFocus = useRef(autoFocus)
  useLayoutEffect(() => { allowFocus.current = autoFocus }, [autoFocus])
  const { slug, section } = view
  const indexRequest = useMemo(() => ({
    key: indexSrc,
    load: (signal: AbortSignal) => loadArticleIndex(indexSrc, signal),
  }), [indexSrc])
  const indexResource = useResource(indexRequest)
  const indexState = indexResource.state
  const articles = indexState.kind === 'ready' ? indexState.data : emptyArticles
  const articleIndex = articles.findIndex(item => item.slug === slug)
  const entry = articles[articleIndex]
  const bodyRequest = useMemo(() => entry ? {
    key: JSON.stringify([indexSrc, entry.slug, entry.bodySrc]),
    load: (signal: AbortSignal) => loadArticle(entry, signal),
  } : null, [indexSrc, entry])
  const articleResource = useResource(bodyRequest)
  const articleState = articleResource.state
  const article = articleState.kind === 'ready' ? articleState.data : null
  const articleReady = article !== null
  const previous = articles[articleIndex - 1]
  const next = articleIndex >= 0 ? articles[articleIndex + 1] : undefined
  const related = albums.find(item => item.id === article?.album)
  const failed = indexState.kind === 'error' || articleState.kind === 'error'
  const loading = indexState.kind === 'loading' || articleState.kind === 'loading'
  const contentReady = failed || (indexState.kind === 'ready' && (!entry || articleState.kind === 'ready'))

  useLayoutEffect(() => {
    if (!contentReady) return
    const root = scroll.current
    const progress = articleReady ? rememberReading({ slug, section }) : null
    let restored = false
    const frame = requestAnimationFrame(() => {
      const target = findSection(root, section)
      if (root && progress?.scrollTop != null) root.scrollTop = progress.scrollTop
      else if (target) target.scrollIntoView({ block: 'start' })
      else if (root) root.scrollTop = 0
      if (allowFocus.current) (heading.current ?? pageFrame.current)?.focus({ preventScroll: true })
      restored = true
    })
    return () => {
      cancelAnimationFrame(frame)
      if (root && progress && restored) progress.scrollTop = root.scrollTop
    }
  }, [contentReady, articleReady, slug, section, indexSrc, entry?.bodySrc])

  function followArticleLink(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return
    const anchor = event.target.closest('a[href]')
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return
    const url = new URL(anchor.href)
    if (url.origin !== window.location.origin) return
    const params = new URLSearchParams(url.hash.slice(1))
    const targetSlug = url.pathname === '/' ? params.get('article') : null
    if (targetSlug) {
      event.preventDefault()
      const targetSection = params.get('section')
      openArticle({ slug: targetSlug, section: targetSection })
      const target = findSection(scroll.current, targetSection)
      if (targetSlug === slug && target) target.scrollIntoView({ block: 'start' })
      return
    }
    const href = anchor.getAttribute('href')
    if (article && href?.startsWith('#')) {
      let id
      try { id = decodeURIComponent(href.slice(1)) } catch { return }
      const target = findSection(scroll.current, id)
      if (target) {
        event.preventDefault()
        openArticle({ slug: article.slug, section: id })
        target.scrollIntoView({ block: 'start' })
      }
    }
  }

  function preparePage(event: SyntheticEvent<HTMLIFrameElement>) {
    try {
      const doc = event.currentTarget.contentDocument
      if (!doc) return
      const style = doc.createElement('style')
      style.textContent = 'html, body { background: transparent !important; }'
      ;(doc.head ?? doc.documentElement).appendChild(style)
      doc.addEventListener('keydown', keyEvent => {
        if (keyEvent.key === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
    } catch {
      // 页面可能已跳转到跨域文档，无法访问其 document。
    }
  }

  if (article?.src) return (
    <div id="folio-reader" role="region" aria-label="阅读博客" className={`${styles.reader} ${styles.pageReader}`} data-reader>
      <iframe ref={pageFrame} src={article.src + (section ? `#${encodeURIComponent(section)}` : '')} title={article.title} className={styles.page} tabIndex={0} onLoad={preparePage} />
    </div>
  )

  return (
    <div id="folio-reader" role="region" aria-label="阅读博客" className={styles.reader} data-reader onClick={followArticleLink}>
      <div ref={scroll} className={styles.scroll} data-panel-scroll tabIndex={0} aria-busy={loading}>
        <div className={styles.content}>
          {failed ? <div className={styles.empty} role="alert">
            <h1 ref={heading} tabIndex={-1}>博客加载失败</h1>
            <p>{indexState.kind === 'error' ? '暂时无法读取博客列表。' : '暂时无法读取这篇博客。'}请重试。</p>
            <button type="button" className={styles.retry} onClick={indexState.kind === 'error' ? indexResource.retry : articleResource.retry}>重新加载</button>
          </div> : loading ? <div className={styles.empty} role="status">
            <h1>正在加载博客…</h1>
            <p>{indexState.kind === 'loading' ? '正在读取博客列表。' : '正在读取博客内容。'}</p>
          </div> : article ? <article>
            <header className={styles.articleHeading}>
              <h1 ref={heading} tabIndex={-1}>{article.title}</h1>
              {(article.date || article.category) && <div className={styles.meta}>
                {article.date && <time dateTime={article.date}>{formatDate(article.date)}</time>}
                {article.category && <span>{article.category}</span>}
              </div>}
            </header>
            {article.cover && <Image src={article.cover} alt="博客封面" width={1440} height={960} className={styles.cover} />}
            {article.toc.length >= 3 && <details className={styles.toc}>
              <summary>博客目录</summary>
              <nav aria-label="博客目录"><ol>{article.toc.map(item => <li key={item.id} data-level={item.level}><a href={articleHref(article.slug, item.id)}>{item.title}</a></li>)}</ol></nav>
            </details>}
            <ArticleBody html={article.html} />
            {(related || previous || next) && <footer className={styles.articleEnd}>
              {related && <a href={albumHref(related.id)} className={styles.related}>查看关联图库：{albumTitle(related.title)}</a>}
              {(previous || next) && <nav aria-label="其他博客" className={styles.adjacent}>
                {previous && <div><small>上一篇</small><a href={articleHref(previous.slug)} rel="prev">{previous.title}</a></div>}
                {next && <div><small>下一篇</small><a href={articleHref(next.slug)} rel="next">{next.title}</a></div>}
              </nav>}
            </footer>}
          </article> : <div className={styles.empty}>
            <h1 ref={heading} tabIndex={-1}>博客未找到</h1><p>可以返回列表，看看其他博客</p><button type="button" className={styles.back} onClick={() => openWriting()}>返回博客列表</button>
          </div>}
        </div>
      </div>
    </div>
  )
}
