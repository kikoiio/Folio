import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const publicPrefix = '/articles/'

function metadata(article) {
  const { slug, title, description, date, category, cover, album } = article
  return { slug, title, description, date, category, cover, album,
    ...(article.directory === undefined ? {} : { directory: article.directory }) }
}

function asset(kind, value) {
  const json = `${JSON.stringify(value)}\n`
  const hash = createHash('sha256').update(json).digest('hex')
  return { file: `${kind}-${hash}.json`, json }
}

async function writeIfChanged(file, json) {
  try {
    if (await fs.readFile(file, 'utf8') === json) return
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, json, { flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

/**
 * Write immutable assets served from /articles/. Publish the index last;
 * the caller may prune files only after the entire archive sync succeeds.
 * @param {import('../lib/article-types').Article[]} articles
 * @param {string} publicArticlesRoot Path to public/articles.
 */
export async function writeArticleAssets(articles, publicArticlesRoot) {
  const slugs = new Set()
  for (const article of articles) {
    if (slugs.has(article.slug)) throw new Error(`Duplicate article URL: ${article.slug}`)
    slugs.add(article.slug)
  }

  await fs.mkdir(publicArticlesRoot, { recursive: true })
  const index = []
  const files = []
  for (const article of articles) {
    const details = metadata(article)
    const body = asset('article', {
      ...details,
      html: article.html,
      toc: article.toc.map(({ id, title, level }) => ({ id, title, level })),
      ...(article.src === undefined ? {} : { src: article.src }),
    })
    // Slugs never become file paths, including nested or non-ASCII slugs.
    await writeIfChanged(path.join(publicArticlesRoot, body.file), body.json)
    files.push(body.file)
    index.push({ ...details, bodySrc: `${publicPrefix}${body.file}` })
  }
  const listing = asset('index', index)
  await writeIfChanged(path.join(publicArticlesRoot, listing.file), listing.json)
  files.push(listing.file)
  return { indexSrc: `${publicPrefix}${listing.file}`, files }
}
