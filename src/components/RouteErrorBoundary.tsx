import { Component, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n/it'

interface Props {
  /** Changes whenever the route does, so the boundary resets on navigation. */
  resetKey: string
  onReset: () => void
  children: ReactNode
}

interface State {
  hasError: boolean
}

// Class component because React only exposes error catching through the
// lifecycle methods (getDerivedStateFromError / componentDidCatch); there is
// no hook equivalent. This app uses the component <Routes> API rather than a
// data router, so React Router's built-in errorElement is unavailable and we
// supply our own boundary instead.
class ErrorBoundaryInner extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    // Surface the crash in the console for debugging; without this the
    // original stack would be swallowed once the fallback renders.
    console.error('Route render error:', error)
  }

  componentDidUpdate(prev: Props) {
    // A new route mounted -- clear the error so the next page gets a fresh
    // chance to render instead of being stuck behind the fallback.
    if (this.state.hasError && prev.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (!this.state.hasError) return this.props.children
    const c = t.common.errorBoundary
    return (
      <section className="flex flex-col items-start gap-4 py-8" role="alert">
        <div className="space-y-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">
            {c.title}
          </h1>
          <p className="max-w-prose text-sm text-muted-foreground">{c.body}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={this.props.onReset}>{c.retry}</Button>
          <Button variant="outline" asChild>
            <a href="/">{c.home}</a>
          </Button>
        </div>
      </section>
    )
  }
}

/**
 * Wraps the routed page tree so a render crash in any page shows a friendly
 * fallback (keeping the surrounding Layout/nav intact) instead of blanking the
 * whole app. Resets automatically when the route changes; the retry button
 * forces a remount of the same route.
 */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <ErrorBoundaryInner
      resetKey={location.pathname}
      onReset={() => navigate(0)}
    >
      {children}
    </ErrorBoundaryInner>
  )
}
