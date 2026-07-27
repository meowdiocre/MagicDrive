import { useEffect, useState } from 'react'
import { BookOpenText, RotateCcw } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { errorMessage } from '@/api/client'
import { Button, Skeleton } from '@/components/ui'
import { fileUrl } from './fileUrl'
import { readTextPreview, TEXT_PREVIEW_LIMIT } from './readTextPreview'
import type { FileItem } from '@/types'

function isSameOrigin(value: string | undefined): boolean {
  if (!value) return false
  try {
    return new URL(value, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

export default function FolderReadme({
  item,
  driveId,
  onOpen,
}: {
  item: FileItem
  driveId: string
  onOpen: () => void
}) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    setText(null)
    setError('')
    fetch(fileUrl.raw(item.id, driveId), {
      headers: { Range: `bytes=0-${TEXT_PREVIEW_LIMIT - 1}` },
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error(`README preview failed (${response.status})`)
        const value = await readTextPreview(response)
        if (current) setText(value)
      })
      .catch(cause => {
        if (current && !(cause instanceof DOMException && cause.name === 'AbortError')) {
          setError(errorMessage(cause, 'README preview failed'))
        }
      })
    return () => { current = false; controller.abort() }
  }, [driveId, item.id, retry])

  return (
    <section
      className="min-w-0 overflow-hidden rounded-vault-md border border-vault-rule bg-vault-surface"
      aria-labelledby="folder-readme-heading"
      aria-busy={text === null && !error}
    >
      <header className="flex min-h-11 items-center justify-between gap-3 border-b border-vault-rule px-4">
        <h2 id="folder-readme-heading" className="flex min-w-0 items-center gap-2 text-sm font-semibold text-vault-ink">
          <BookOpenText className="size-4 shrink-0 text-vault-accent" aria-hidden="true" />
          <span className="truncate">README.md</span>
        </h2>
        <Button variant="ghost" size="sm" onClick={onOpen}>Open file</Button>
      </header>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-sm text-vault-danger" role="alert">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => setRetry(value => value + 1)}>
            <RotateCcw /> Retry
          </Button>
        </div>
      ) : text === null ? (
        <div className="grid gap-3 p-6" aria-label="Loading README preview">
          <Skeleton className="h-6 w-2/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="mt-2 h-4 w-1/4" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ) : (
        <article className="min-w-0 p-5 text-sm leading-7 text-vault-ink sm:p-6">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: props => <h1 className="mb-4 border-b border-vault-rule pb-2 text-2xl font-semibold tracking-[-0.03em]" {...props} />,
              h2: props => <h2 className="mb-3 mt-7 border-b border-vault-rule pb-1.5 text-xl font-semibold tracking-[-0.02em] first:mt-0" {...props} />,
              h3: props => <h3 className="mb-2 mt-6 text-base font-semibold" {...props} />,
              p: props => <p className="my-3 max-w-[75ch] text-vault-muted first:mt-0 last:mb-0" {...props} />,
              a: ({ href, ...props }) => {
                const external = Boolean(href && !isSameOrigin(href))
                return <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} className="font-medium text-vault-accent underline decoration-vault-accent/40 underline-offset-2 hover:decoration-vault-accent" {...props} />
              },
              ul: props => <ul className="my-3 list-disc space-y-1 pl-6 text-vault-muted" {...props} />,
              ol: props => <ol className="my-3 list-decimal space-y-1 pl-6 text-vault-muted" {...props} />,
              li: props => <li className="pl-1 marker:text-vault-subtle" {...props} />,
              blockquote: props => <blockquote className="my-4 border-l border-vault-rule-strong pl-4 text-vault-muted" {...props} />,
              pre: props => <pre className="my-4 overflow-x-auto rounded-vault-sm bg-vault-paper-2 p-4 font-vault-mono text-xs leading-6" {...props} />,
              code: props => <code className="rounded-vault-xs bg-vault-paper-2 px-1.5 py-0.5 font-vault-mono text-[0.85em]" {...props} />,
              hr: props => <hr className="my-6 border-vault-rule" {...props} />,
              table: props => <div className="my-4 overflow-x-auto"><table className="w-full border-collapse text-left text-sm" {...props} /></div>,
              th: props => <th className="border border-vault-rule bg-vault-paper-2 px-3 py-2 font-semibold" {...props} />,
              td: props => <td className="border border-vault-rule px-3 py-2 text-vault-muted" {...props} />,
              img: ({ src, alt, ...props }) => {
                const sameOrigin = isSameOrigin(src)
                return sameOrigin
                  ? <img src={src} alt={alt ?? ''} className="my-4 max-w-full rounded-vault-sm" loading="lazy" {...props} />
                  : <span className="my-4 block text-xs text-vault-subtle">Image hidden for privacy.</span>
              },
              input: props => <input className="mr-2 accent-vault-accent" {...props} />,
            }}
          >
            {text}
          </ReactMarkdown>
        </article>
      )}
    </section>
  )
}
