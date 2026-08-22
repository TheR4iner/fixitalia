import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { CardFooter } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatNumber } from '@/lib/format'
import { t } from '@/i18n/it'

// Paginator shared by every paginated list in the section.
//
// This markup existed in four near-identical copies (the sedute list, the
// persona speeches list, the per-law citations list, and the OdG search
// results), which had already drifted: two rendered first/last jump buttons
// and two did not, and the disabled logic differed between them. One
// component keeps the keyboard targets, the touch sizing, and the aria
// labelling consistent wherever it appears.
//
// Two ways to bound the range, matching the two things the API can tell us:
//
//   totalPages   the exact page count, when the endpoint returns an exact
//                total (the sedute list, per-law citations).
//   hasMore      only "is there a page after this one", when the endpoint
//                reports a lower-bound total to avoid an expensive count
//                (search-backed listings). Jump-to-last is hidden in this
//                mode because the last page is not knowable.

interface PaginationProps {
  page: number
  onPageChange: (next: number) => void
  /** Exact page count when known. Omit when only `hasMore` is available. */
  totalPages?: number
  /** Whether a page exists after this one. Required when totalPages is absent. */
  hasMore?: boolean
  /** Exact row count, rendered alongside the page indicator when known. */
  total?: number
  /** Disables both directions while a fetch is in flight. */
  isFetching?: boolean
  className?: string
}

export function Pagination({
  page,
  onPageChange,
  totalPages,
  hasMore,
  total,
  isFetching = false,
  className,
}: PaginationProps) {
  const knowsLastPage = typeof totalPages === 'number'
  const canGoBack = page > 1
  const canGoForward = knowsLastPage ? page < totalPages : Boolean(hasMore)

  // Nothing to paginate: a single known page and no further results.
  if (!canGoBack && !canGoForward) return null

  return (
    <CardFooter className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <span className="text-xs tabular-nums text-muted-foreground">
        {t.parlamento.pagination.page} {formatNumber(page)}
        {knowsLastPage ? (
          <>
            {' '}
            {t.parlamento.pagination.of} {formatNumber(totalPages)}
          </>
        ) : null}
        {typeof total === 'number' ? (
          <span className="ml-2 hidden sm:inline">
            ({formatNumber(total)}
            {/* A lower-bound total is marked so "20" never reads as "exactly 20". */}
            {!knowsLastPage && hasMore ? '+' : ''} {t.parlamento.pagination.results})
          </span>
        ) : null}
      </span>

      <div className="flex items-center gap-1">
        {knowsLastPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPageChange(1)}
            disabled={!canGoBack || isFetching}
            aria-label={t.parlamento.pagination.first}
            title={t.parlamento.pagination.first}
            className="h-8 w-8 p-0 pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={!canGoBack || isFetching}
          aria-label={t.parlamento.pagination.previous}
          className="pointer-coarse:h-11 pointer-coarse:px-3"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          <span className="ml-1 hidden sm:inline">{t.parlamento.pagination.previous}</span>
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={!canGoForward || isFetching}
          aria-label={t.parlamento.pagination.next}
          className="pointer-coarse:h-11 pointer-coarse:px-3"
        >
          <span className="mr-1 hidden sm:inline">{t.parlamento.pagination.next}</span>
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>

        {knowsLastPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPageChange(totalPages)}
            disabled={!canGoForward || isFetching}
            aria-label={t.parlamento.pagination.last}
            title={t.parlamento.pagination.last}
            className="h-8 w-8 p-0 pointer-coarse:h-11 pointer-coarse:w-11"
          >
            <ChevronsRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </CardFooter>
  )
}
