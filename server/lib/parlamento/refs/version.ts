// PARSER_VERSION is stamped on every parlamento_riferimenti row at
// extraction time. The refs ingest pass treats any seduta whose
// refs_parser_version is below this as stale and re-extracts.
//
// Bump this whenever any of the regex bank, normaliser, or URL builder
// changes in a way that could produce different rows for the same
// intervento testo. Do not bump for purely additive changes that only
// produce new matches (existing rows would still be correct), but do
// bump if start/end_offset semantics shift, if a tipo is renamed, or
// if the URN canonicalisation rules change.
//
// Version history:
//   1 -- initial release (regex bank covers legge / decreto-legge /
//        decreto-legislativo / dpr / costituzione / ac / as / ddl).
//   2 -- denormalised chamber + legislatura columns onto each row to
//        avoid record-link traversal in WHERE clauses (audit fix).
//        Re-extraction also rewrites rows with the corrected schema.
export const PARSER_VERSION = 2
