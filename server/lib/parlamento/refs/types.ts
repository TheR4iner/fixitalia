// Reference taxonomy for parlamento_riferimenti rows.
//
// The string values are the persisted form -- they appear in the DB,
// in API responses, and in the URN-NIR scheme used by Normattiva
// (decreto.legge, decreto.legislativo are the literal URN segments).
// Do not rename casually: see PARSER_VERSION about migration.
export type RefTipo =
  | 'legge'
  | 'decreto.legge'
  | 'decreto.legislativo'
  | 'dpr'
  | 'costituzione'
  | 'ac' // atto Camera (proposta di legge)
  | 'as' // atto Senato (disegno di legge)

// Internal-only tipo used by the regex bank for "disegno di legge n.
// NUM" matches whose chamber-of-origin is implicit. The public
// parseRefs() resolves it into 'ac' or 'as' based on the seduta's
// chamber, so this never appears in persisted rows or the public Ref
// shape.
export type InternalRefTipo = RefTipo | 'ddl_ambiguous'

export interface RefContext {
  chamber: 'camera' | 'senato'
  legislatura: number
}

// A single reference detected and resolved as far as is possible
// without external lookups. `url` is null when the destination needs
// async resolution (currently only AS bills via SPARQL); the refs
// ingest pass fills it in a later stage.
export interface Ref {
  tipo: RefTipo
  anno?: number
  numero?: string
  articolo?: number
  urn?: string
  url?: string | null
  raw: string
  start: number
  end_offset: number
}
