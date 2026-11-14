import type { Article, ArticleIndex, ArticleIndexEntry, ArticleMetadata } from './article-types'

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected article data')
  return Object.fromEntries(Object.entries(value))
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected article text')
  return value
}

function nonemptyText(value: unknown): string {
  const result = text(value)
  if (!result.trim()) throw new Error('Expected nonempty article text')
  return result
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value)
}

function slug(value: unknown): string {
  const result = nonemptyText(value)
  if (/[\\\u0000-\u001f\u007f]/u.test(result) || result.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid article slug')
  }
  return result
}

function date(value: unknown): string | null {
  const result = nullableText(value)
  if (result === null) return null
  const parsed = new Date(`${result}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) {
    throw new Error('Invalid article date')
  }
  return result
}

function cover(value: unknown): string | null {
  const result = nullableText(value)
  if (result === null) return null
  if (/[\\\u0000-\u0020\u007f]/u.test(result)) throw new Error('Invalid article cover')
  if (result.startsWith('/') && !result.startsWith('//')) return result
  const url = new URL(result)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Invalid article cover')
  return result
}

function metadata(value: Record<string, unknown>): ArticleMetadata {
  return {
    ...(value.directory === undefined ? {} : { directory: value.directory === '' ? '' : slug(value.directory) }),
    slug: slug(value.slug),
    title: nonemptyText(value.title),
    description: text(value.description),
    date: date(value.date),
    category: nullableText(value.category),
    cover: cover(value.cover),
    album: nullableText(value.album),
  }
}

function assetSrc(value: unknown, kind: 'article' | 'index'): string {
  const result = text(value)
  if (!new RegExp(`^/articles/${kind}-[a-f0-9]{64}\\.json$`).test(result)) throw new Error('Invalid article asset URL')
  return result
}

function pageSrc(value: unknown): string {
  const result = text(value)
  const prefix = '/media/blogs/'
  if (!result.startsWith(prefix) || /[\u0000-\u0020\u007f\\]/u.test(result) || result.slice(prefix.length).split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid article page URL')
  }
  return result
}

export function parseArticleIndex(value: unknown): ArticleIndex {
  if (!Array.isArray(value)) throw new Error('Expected article index')
  const slugs = new Set<string>()
  return value.map((item: unknown) => {
    const entry = object(item)
    const details = metadata(entry)
    if (slugs.has(details.slug)) throw new Error('Duplicate article slug')
    slugs.add(details.slug)
    return { ...details, bodySrc: assetSrc(entry.bodySrc, 'article') }
  })
}

export function parseArticleBody(value: unknown): Article {
  const article = object(value)
  if (!Array.isArray(article.toc)) throw new Error('Expected article contents')
  const ids = new Set<string>()
  const toc = article.toc.map((item: unknown) => {
    const entry = object(item)
    const id = nonemptyText(entry.id)
    const level = entry.level
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6 || ids.has(id)) {
      throw new Error('Invalid article heading')
    }
    ids.add(id)
    return { id, title: text(entry.title), level }
  })
  return { ...metadata(article), html: text(article.html), toc, ...(article.src === undefined ? {} : { src: pageSrc(article.src) }) }
}

const indexes = new Map<string, ArticleIndex>()
const bodies = new Map<string, Article>()

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

async function fetchJson(src: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(src, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Article request failed (${response.status})`)
  const value: unknown = await response.json()
  signal?.throwIfAborted()
  return value
}

export async function loadArticleIndex(src: string, signal?: AbortSignal): Promise<ArticleIndex> {
  const key = assetSrc(src, 'index')
  signal?.throwIfAborted()
  const cached = indexes.get(key)
  if (cached) {
    remember(indexes, key, cached, 2)
    return cached
  }
  const result = parseArticleIndex(await fetchJson(key, signal))
  remember(indexes, key, result, 2)
  return result
}

export async function loadArticle(entry: ArticleIndexEntry, signal?: AbortSignal): Promise<Article> {
  const key = assetSrc(entry.bodySrc, 'article')
  signal?.throwIfAborted()
  const cached = bodies.get(key)
  if (cached) {
    if (cached.slug !== entry.slug) throw new Error('Article slug mismatch')
    remember(bodies, key, cached, 8)
    return cached
  }
  const result = parseArticleBody(await fetchJson(key, signal))
  if (result.slug !== entry.slug) throw new Error('Article slug mismatch')
  remember(bodies, key, result, 8)
  return result
}
