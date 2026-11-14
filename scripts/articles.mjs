import fs from 'node:fs/promises'
import path from 'node:path'
import matter from 'gray-matter'
import MarkdownIt from 'markdown-it'

export function articleSlug(relative) {
  const stem = relative.replace(/\.(md|mdx|html)$/i, '')
  return stem.replace(/\/index$/i, '')
}

function textFrom(tokens = []) {
  return tokens.map(token => {
    if (['text', 'code_inline'].includes(token.type)) return token.content
    if (['softbreak', 'hardbreak'].includes(token.type)) return ' '
    return token.children ? textFrom(token.children) : ''
  }).join('')
}

function optionalText(data, name) {
  const value = data[name]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`Article ${name} must be text`)
  return value.trim() || null
}

function articleDate(value) {
  if (value === undefined || value === null) return null
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : value
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Article date must be YYYY-MM-DD')
  const parsed = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid article date')
  return date
}

function resolveUrl(value, relative, assets, image = false) {
  if (!value) return ''
  const href = value.trim()
  if (/[\u0000-\u0020\\]/.test(href.replaceAll(' ', ''))) return ''
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    const allowed = image ? /^https?:\/\//i : /^(https?:\/\/|mailto:|tel:)/i
    return allowed.test(href) ? href : ''
  }
  if (href.startsWith('//')) return ''
  if (href.startsWith('/') || href.startsWith('#')) return href
  const match = /^([^?#]*)(.*)$/.exec(href)
  if (!match) return ''
  let decoded
  try { decoded = decodeURIComponent(match[1]) } catch { return '' }
  if (/[\u0000-\u001f\\]/.test(decoded) || path.posix.isAbsolute(decoded)) return ''
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decoded))
  if (resolved === '..' || resolved.startsWith('../') || resolved.split('/').some(part => part.startsWith('.'))) return ''
  if (/\.(md|mdx|html)$/i.test(resolved) && !image) {
    const params = new URLSearchParams([['article', articleSlug(resolved)]])
    const fragmentIndex = match[2].indexOf('#')
    if (fragmentIndex >= 0) {
      let section
      try { section = decodeURIComponent(match[2].slice(fragmentIndex + 1)) } catch { return '' }
      if (section) params.set('section', section)
    }
    return `/#${params}`
  }
  const asset = assets.get(resolved)
  return `${asset ?? `/media/blogs/${resolved.split('/').map(encodeURIComponent).join('/')}`}${match[2]}`
}

export function parseArticle({ source, relative, assets = new Map() }) {
  const normalized = source.replace(/^\uFEFF+/, '')
  if (/^---[^\r\n]+/.test(normalized)) throw new Error('Only YAML article frontmatter is supported')
  const { data, content } = matter(normalized, {
    engines: { javascript: () => { throw new Error('Executable frontmatter is not supported') } },
  })
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Article frontmatter must be an object')
  if (data.draft !== undefined && typeof data.draft !== 'boolean') throw new Error('Article draft must be true or false')
  if (data.draft) return null
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
  const tokens = md.parse(content, {})
  const headingIndex = tokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1')
  const headingTitle = headingIndex >= 0 ? textFrom(tokens[headingIndex + 1]?.children) : ''
  const title = optionalText(data, 'title') || headingTitle || path.posix.basename(relative).replace(/\.(md|mdx)$/i, '').replaceAll(/[_-]/g, ' ')
  if (headingIndex >= 0 && headingTitle === title) tokens.splice(headingIndex, 3)

  const toc = []
  const usedIds = new Map()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.type === 'paragraph_open' && token.level === 0) {
      const first = tokens[index + 1]?.children?.[0]
      if (first?.type === 'text' && first.content.startsWith('\u3000\u3000')) token.attrSet('data-indent', 'manual')
    }
    if (token.type === 'heading_open') {
      const text = textFrom(tokens[index + 1]?.children)
      const base = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section'
      const occurrence = (usedIds.get(base) ?? 0) + 1
      usedIds.set(base, occurrence)
      let id = occurrence === 1 ? base : `${base}-${occurrence}`
      while (usedIds.has(`id:${id}`)) id += '-1'
      usedIds.set(`id:${id}`, true)
      token.attrSet('id', id)
      const level = Number(token.tag.slice(1))
      if (level === 2 || level === 3) toc.push({ id, title: text, level })
    }
  }

  const renderImage = md.renderer.rules.image
  md.renderer.rules.image = (items, index, options, env, renderer) => {
    const token = items[index]
    const src = resolveUrl(token.attrGet('src'), relative, assets, true)
    if (!src) return md.utils.escapeHtml(token.content)
    token.attrSet('src', src)
    token.attrSet('loading', 'lazy')
    return renderImage(items, index, options, env, renderer)
  }
  md.renderer.rules.link_open = (items, index, options, _env, renderer) => {
    const token = items[index]
    token.attrSet('href', resolveUrl(token.attrGet('href'), relative, assets))
    return renderer.renderToken(items, index, options)
  }
  md.renderer.rules.table_open = () => '<div class="table-scroll"><table>\n'
  md.renderer.rules.table_close = () => '</table></div>\n'

  const firstParagraph = tokens.findIndex(token => token.type === 'paragraph_open')
  const summary = firstParagraph >= 0 ? textFrom(tokens[firstParagraph + 1]?.children).trim() : ''
  const summaryCharacters = Array.from(summary)
  const cover = optionalText(data, 'cover')
  return {
    slug: articleSlug(relative), title,
    directory: path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative),
    description: optionalText(data, 'description') || summaryCharacters.slice(0, 140).join('') + (summaryCharacters.length > 140 ? '…' : ''),
    date: articleDate(data.date),
    category: optionalText(data, 'category') || (path.posix.dirname(relative) === '.' ? null : path.posix.dirname(relative).replaceAll('/', ' / ')),
    cover: cover ? resolveUrl(cover, relative, assets, true) || null : null,
    album: optionalText(data, 'album'),
    html: md.renderer.render(tokens, md.options, {}), toc,
  }
}

function decodeEntities(value) {
  return value
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (_, hex, dec) => {
      const code = parseInt(hex ?? dec, hex ? 16 : 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
}

function metaContent(source, name) {
  for (const match of source.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = match[0]
    if (/\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1].toLowerCase() !== name) continue
    return decodeEntities(/\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '')
  }
  return null
}

export function parseHtmlArticle({ source, relative }) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)
  const title = decodeEntities(titleMatch?.[1] ?? '').trim() || path.posix.basename(relative).replace(/\.html$/i, '').replaceAll(/[_-]/g, ' ')
  const directory = path.posix.dirname(relative)
  return {
    slug: articleSlug(relative), title,
    directory: directory === '.' ? '' : directory,
    description: (metaContent(source, 'description') ?? '').trim(),
    date: articleDate(metaContent(source, 'date') || null),
    category: directory === '.' ? null : directory.replaceAll('/', ' / '),
    cover: null, album: null,
    html: '', toc: [],
    src: `/media/blogs/${relative.split('/').map(encodeURIComponent).join('/')}`,
  }
}

export async function readArticles(root, files, assets = new Map()) {
  const articles = []
  const slugs = new Set()
  for (const relative of files) {
    if (!/\.(md|mdx|html)$/i.test(relative)) continue
    const normalized = relative.split(path.sep).join('/')
    const source = await fs.readFile(path.join(root, relative), 'utf8')
    const article = /\.html$/i.test(normalized)
      ? parseHtmlArticle({ source, relative: normalized })
      : parseArticle({ source, relative: normalized, assets })
    if (!article) continue
    if (slugs.has(article.slug)) throw new Error(`Duplicate article URL: ${article.slug}`)
    slugs.add(article.slug)
    articles.push(article)
  }
  return articles.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.slug.localeCompare(b.slug, 'en'))
}
