import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'

import { Layout } from '@/components/Layout'
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary'
import { Skeleton } from '@/components/ui/skeleton'
import { t } from '@/i18n/it'
import HomePage from '@/pages/HomePage'

// Home renders eagerly so the landing route never shows a fallback.
// Every data page is split into its own chunk -- each pulls in Recharts
// plus its own services, which together add up to the bulk of the
// bundle. Loading them on demand means the first-visit bundle covers
// only the home route.
const AppaltiPage = lazy(() => import('@/pages/AppaltiPage'))
const OpereIncompiutePage = lazy(() => import('@/pages/OpereIncompiutePage'))
const FondiEuropeiPage = lazy(() => import('@/pages/FondiEuropeiPage'))
const SpesaPubblicaPage = lazy(() => import('@/pages/SpesaPubblicaPage'))
const ParlamentoPage = lazy(() => import('@/pages/ParlamentoPage'))
const SedutaPage = lazy(() => import('@/pages/parlamento/SedutaPage'))
const SearchResultsPage = lazy(() => import('@/pages/parlamento/SearchResultsPage'))
const PersonaPage = lazy(() => import('@/pages/parlamento/PersonaPage'))
const LeggiCitatePage = lazy(() => import('@/pages/parlamento/LeggiCitatePage'))
const LeggePage = lazy(() => import('@/pages/parlamento/LeggePage'))
const LegislaturePage = lazy(() => import('@/pages/parlamento/LegislaturePage'))
const TransfughiPage = lazy(() => import('@/pages/parlamento/TransfughiPage'))
const OdgSearchPage = lazy(() => import('@/pages/parlamento/OdgSearchPage'))
const LeTueTassePage = lazy(() => import('@/pages/LeTueTassePage'))
const ContattiPage = lazy(() => import('@/pages/ContattiPage'))
const FontiPage = lazy(() => import('@/pages/FontiPage'))
const PrivacyPage = lazy(() => import('@/pages/PrivacyPage'))

// Holding state during the lazy chunk fetch. Shaped like a page header
// (title + badge + two-line lede) so the layout doesn't visibly jump
// when the real page commits. aria-hidden because the values are
// placeholder skeletons, not announceable content.
function RouteFallback() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-64 sm:h-9 sm:w-80" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-4 w-full max-w-3xl" />
      <Skeleton className="h-4 w-3/4 max-w-2xl" />
    </div>
  )
}

export default function App() {
  return (
    <Layout>
      <RouteErrorBoundary>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/appalti" element={<AppaltiPage />} />
            <Route path="/opere-incompiute" element={<OpereIncompiutePage />} />
            <Route path="/fondi-europei" element={<FondiEuropeiPage />} />
            <Route path="/spesa-pubblica" element={<SpesaPubblicaPage />} />
            <Route path="/parlamento" element={<ParlamentoPage />} />
            <Route path="/parlamento/cerca" element={<SearchResultsPage />} />
            <Route
              path="/parlamento/persona/:chamber/:idPersona"
              element={<PersonaPage />}
            />
            <Route
              path="/parlamento/sedute/:chamber/:leg/:numero"
              element={<SedutaPage />}
            />
            <Route path="/parlamento/leggi-citate" element={<LeggiCitatePage />} />
            <Route
              path="/parlamento/leggi/:tipo/:anno/:numero"
              element={<LeggePage />}
            />
            <Route path="/parlamento/legislature/:n" element={<LegislaturePage />} />
            <Route path="/parlamento/transfughi" element={<TransfughiPage />} />
            <Route path="/parlamento/odg/cerca" element={<OdgSearchPage />} />
            <Route path="/le-tue-tasse" element={<LeTueTassePage />} />
            <Route path="/contatti" element={<ContattiPage />} />
            <Route path={t.fonti.route} element={<FontiPage />} />
            <Route path={t.privacy.route} element={<PrivacyPage />} />
          </Routes>
        </Suspense>
      </RouteErrorBoundary>
    </Layout>
  )
}
