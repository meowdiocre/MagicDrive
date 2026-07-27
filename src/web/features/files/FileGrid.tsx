import { cn } from '@/lib/cn'
import { Skeleton } from '@/components/ui'
import type { Layout } from '@/types'

export function gridClass(layout: Layout) {
  return cn(
    'grid',
    layout === 'grid' && 'grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-px bg-vault-rule max-[40rem]:grid-cols-[minmax(0,1fr)]',
  )
}

export function LoadingRows({ layout }: { layout: Layout }) {
  return (
    <div className={gridClass(layout)} aria-hidden="true">
      {Array.from({ length: layout === 'grid' ? 8 : 8 }, (_, index) => (
        <div
          key={index}
          className={cn(
            'grid items-center gap-4 border-b border-vault-rule px-4',
            layout === 'grid'
              ? 'min-h-24 grid-cols-[2.25rem_minmax(0,1fr)] content-start gap-y-2 border-b-0 bg-vault-surface p-4'
              : 'min-h-14 grid-cols-[2.25rem_minmax(0,1fr)_5.5rem_5rem_7rem_2.25rem] max-[56rem]:grid-cols-[2.25rem_minmax(0,1fr)_2.25rem]',
          )}
        >
          <Skeleton className="size-9 rounded-vault-sm" />
          <Skeleton className="h-3 w-[min(60%,12rem)]" />
          {layout === 'list' && (
            <>
              <Skeleton className="h-3 w-12 max-[56rem]:hidden" />
              <Skeleton className="h-3 w-10 max-[56rem]:hidden" />
              <Skeleton className="h-3 w-16 max-[56rem]:hidden" />
              <Skeleton className="size-4 rounded-full" />
            </>
          )}
        </div>
      ))}
    </div>
  )
}
