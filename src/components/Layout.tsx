import { useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { Menu, Moon, Sun } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useTheme } from '@/hooks/useTheme'
import { t } from '@/i18n/it'

const NAV_ITEMS = [
  { to: t.sections.parlamento.route, label: t.sections.parlamento.title },
  { to: t.sections.appalti.route, label: t.sections.appalti.title },
  { to: t.sections.opereIncompiute.route, label: t.sections.opereIncompiute.title },
  { to: t.sections.fondiEuropei.route, label: t.sections.fondiEuropei.title },
  { to: t.sections.spesaPubblica.route, label: t.sections.spesaPubblica.title },
  { to: t.sections.leTueTasse.route, label: t.sections.leTueTasse.title },
  // Not a data section, but it belongs in the primary nav as the last
  // item: it is the only route that says who is behind the project.
  { to: t.contatti.route, label: t.contatti.title },
] as const

function navLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    'rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground',
    isActive && 'bg-muted text-foreground',
  )
}

function mobileNavLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    'block rounded-md px-3 py-2 text-base font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
    isActive && 'bg-muted text-foreground',
  )
}

function footerLinkClass({ isActive }: { isActive: boolean }) {
  return cn(
    'underline-offset-4 transition-colors hover:text-foreground hover:underline',
    isActive && 'text-foreground',
  )
}

function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme()
  const isDark = resolved === 'dark'
  const nextLabel = isDark ? t.nav.theme.toLight : t.nav.theme.toDark

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setPreference(isDark ? 'light' : 'dark')}
      aria-label={nextLabel}
      title={nextLabel}
      className={cn('pointer-coarse:size-11', className)}
    >
      {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </Button>
  )
}

export function Layout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:gap-4 sm:px-6">
          <NavLink
            to="/"
            className="font-heading text-lg font-semibold tracking-tight text-foreground"
            aria-label={t.brand.name}
          >
            {t.brand.name}
          </NavLink>

          <nav
            aria-label={t.nav.primary}
            className="ml-6 hidden items-center gap-1 lg:flex"
          >
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} className={navLinkClass} end>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto hidden lg:block">
            <ThemeToggle />
          </div>

          <div className="ml-auto flex items-center gap-1 lg:hidden">
            <ThemeToggle />
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t.nav.openMenu}
                  className="pointer-coarse:size-11"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72">
                <SheetHeader>
                  <SheetTitle>{t.brand.name}</SheetTitle>
                </SheetHeader>
                <div className="flex flex-col gap-4 px-4 pb-4">
                  <nav aria-label={t.nav.primary} className="flex flex-col gap-1">
                    {NAV_ITEMS.map((item) => (
                      <SheetClose asChild key={item.to}>
                        <NavLink to={item.to} className={mobileNavLinkClass} end>
                          {item.label}
                        </NavLink>
                      </SheetClose>
                    ))}
                  </nav>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10 xl:max-w-7xl xl:py-12">
        {children}
      </main>

      <footer className="mt-auto border-t border-border/70 py-6">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 text-xs text-muted-foreground sm:px-6 xl:max-w-7xl">
          <div className="flex flex-col gap-1">
            <p>{t.brand.tagline}</p>
            <p>{t.brand.footerNote}</p>
          </div>

          {/* Attribution and privacy are obligations, not decoration: the
              open-data licences require crediting the originating body, and
              the notice has to be reachable from every page. The footer is
              the only surface that qualifies. */}
          <nav aria-label={t.footer.nav} className="flex flex-wrap gap-x-4 gap-y-1">
            <NavLink to={t.fonti.route} className={footerLinkClass}>
              {t.fonti.title}
            </NavLink>
            <NavLink to={t.privacy.route} className={footerLinkClass}>
              {t.privacy.title}
            </NavLink>
            <NavLink to={t.contatti.route} className={footerLinkClass}>
              {t.contatti.title}
            </NavLink>
            <a
              href={t.footer.codeUrl}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 transition-colors hover:text-foreground hover:underline"
            >
              {t.footer.codeLabel}
            </a>
          </nav>

          <p>{t.footer.credit}</p>
        </div>
      </footer>
    </div>
  )
}
