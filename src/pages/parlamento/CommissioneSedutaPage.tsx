import { useNavigate, useParams, useLocation } from 'react-router-dom'

import { Badge } from '@/components/ui/badge'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchCommissioneInterventi,
  fetchCommissioneSedutaDetail,
  type Chamber,
} from '@/services/parlamento'
import { t } from '@/i18n/it'
import { SedutaReader } from '@/components/parlamento/SedutaReader'

// Committee transcript route. Addressing only; the reader is shared with the
// Aula route (components/parlamento/SedutaReader.tsx).
//
// A committee sitting is addressed by its document scope rather than by a
// number, because committee resoconti are numbered per-committee and per
// inquiry -- "resoconto 6" names dozens of different documents.

// Committee sittings are far shorter than plenary ones (tens of interventi,
// not thousands), but the ceiling matches the backend's so an unusually long
// audizione is never silently truncated.
const READER_FETCH_LIMIT = 5000

export default function CommissioneSedutaPage() {
  const params = useParams<{ scope: string }>()
  const scope = params.scope ?? ''
  const navigate = useNavigate()
  const location = useLocation()

  const detailQuery = useQuery(
    ['parlamento/commissione/seduta', scope] as const,
    () => fetchCommissioneSedutaDetail(scope),
    { ttlMs: 5 * 60 * 1000 },
  )
  const interventiQuery = useQuery(
    ['parlamento/commissione/interventi', scope] as const,
    () => fetchCommissioneInterventi(scope, 1, READER_FETCH_LIMIT),
    { ttlMs: 5 * 60 * 1000 },
  )

  const seduta = detailQuery.data?.seduta
  const chamber: Chamber = seduta?.chamber ?? 'camera'
  const isSommario = seduta?.tipo_resoconto === 'sommario'

  function goBack() {
    if (seduta?.organo_slug) {
      navigate(`/parlamento/commissioni/${encodeURIComponent(seduta.organo_slug)}`)
    } else {
      navigate('/parlamento/commissioni')
    }
  }

  const title = seduta?.organo_nome
    ? `${seduta.organo_nome} -- ${t.parlamento.commissioni.sedutaLabel} ${seduta.numero}`
    : t.parlamento.commissioni.navTitle

  return (
    <SedutaReader
      chamber={chamber}
      legislatura={seduta?.legislatura ?? null}
      title={title}
      detailQuery={detailQuery}
      interventiQuery={interventiQuery}
      onBack={goBack}
      backLabel={t.parlamento.commissioni.backToSedute}
      hash={location.hash}
      badges={
        <Badge
          variant={isSommario ? 'secondary' : 'outline'}
          className="text-xs"
        >
          {isSommario
            ? t.parlamento.commissioni.sommarioBadge
            : t.parlamento.commissioni.stenograficoBadge}
        </Badge>
      }
      // A summary is not a transcript. Saying so once, prominently, above the
      // text is the difference between quoting a speaker and quoting the
      // secretariat's paraphrase of them.
      notice={
        isSommario ? (
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t.parlamento.commissioni.sommarioNotice}
          </p>
        ) : undefined
      }
    />
  )
}
