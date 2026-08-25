import { useNavigate, useParams, useLocation } from 'react-router-dom'

import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { useQuery } from '@/hooks/useQuery'
import {
  fetchInterventi,
  fetchSedutaDetail,
  type Chamber,
} from '@/services/parlamento'
import { isChamber } from '@/lib/parlamento-params'
import { t } from '@/i18n/it'
import { SedutaReader } from '@/components/parlamento/SedutaReader'

// Aula (plenary) transcript route. Addressing only -- the reader itself lives
// in components/parlamento/SedutaReader.tsx and is shared with the committee
// route, which addresses a sitting by document scope instead of by number.

// The reader renders the whole transcript as a single continuous document, so
// it fetches every intervento in one request. 5000 clears the current largest
// seduta (2885 interventi) with headroom and matches the backend's page-size
// ceiling. (A previous 1000 here silently truncated the 57 sedute above that.)
const READER_FETCH_LIMIT = 5000

export default function SedutaPage() {
  const params = useParams<{ chamber: string; leg: string; numero: string }>()
  const chamber = isChamber(params.chamber) ? params.chamber : null
  const legislatura = Number(params.leg)
  const numero = Number(params.numero)
  const navigate = useNavigate()
  const location = useLocation()

  const valid = Boolean(chamber) && Number.isFinite(legislatura) && Number.isFinite(numero)

  // 5-minute TTL: a re-run of the body pass should show new content promptly
  // without forcing the operator to clear localStorage.
  const detailQuery = useQuery(
    ['parlamento/seduta', chamber, legislatura, numero] as const,
    () => fetchSedutaDetail(chamber as Chamber, legislatura, numero),
    { ttlMs: 5 * 60 * 1000 },
  )
  const interventiQuery = useQuery(
    ['parlamento/interventi', chamber, legislatura, numero] as const,
    () => fetchInterventi(chamber as Chamber, legislatura, numero, 1, READER_FETCH_LIMIT),
    { ttlMs: 5 * 60 * 1000 },
  )

  function goBack() {
    if (location.key !== 'default') navigate(-1)
    else navigate('/parlamento')
  }

  if (!valid || !chamber) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t.parlamento.invalidPage}</CardTitle>
        </CardHeader>
      </Card>
    )
  }

  const chamberLabel =
    chamber === 'camera' ? t.parlamento.cameraLabel : t.parlamento.senatoLabel

  return (
    <SedutaReader
      chamber={chamber}
      legislatura={legislatura}
      title={`${chamberLabel} -- ${t.parlamento.seduteList.seduta} ${numero}`}
      detailQuery={detailQuery}
      interventiQuery={interventiQuery}
      onBack={goBack}
      backLabel={t.parlamento.seduta.back}
      hash={location.hash}
      // Preserves the pre-refactor behaviour: an empty Senato Aula sitting is
      // reported as a temporary source problem, because historically that is
      // what it was (the WAF blocking the body pass).
      treatEmptyAsBlocked={chamber === 'senato'}
    />
  )
}
