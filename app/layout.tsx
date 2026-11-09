import type { Metadata } from 'next'
import { site } from '../.folio/site'
import SkipLink from './skip-link'
import './globals.css'

export const metadata: Metadata = {
  title: { default: site.title, template: `%s · ${site.title}` },
  description: site.description,
  icons: site.icons,
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Extensions such as Trancy may inject attributes into <html> before hydration.
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: "(function(){try{var spec=performance.getEntriesByType('navigation')[0];var kind=spec&&spec.type;if(kind==='reload'||kind==='back_forward')return;if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;if(new URLSearchParams(location.hash.slice(1)).has('article'))return;document.documentElement.dataset.folioEntry='intro'}catch(error){}})()" }} />
        <SkipLink />
        {children}
      </body>
    </html>
  )
}
