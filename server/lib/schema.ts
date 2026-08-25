import { getDb } from './db.ts'

// SurrealDB schema bootstrap. Run on server startup and from the ingest CLI
// to ensure tables and indexes exist. All statements are idempotent: DEFINE
// TABLE/FIELD/INDEX with IF NOT EXISTS means we can re-run safely.
//
// Design choices:
// - Table is SCHEMALESS so we can keep raw source fields alongside the
//   curated fields we project. That makes future additions cheap.
// - Record id is the CUP code when present, otherwise a synthesised hash.
//   This makes upserts during re-ingestion idempotent for the same record.
// - Indexes cover the access patterns of the read routes: by NUTS region,
//   by ISTAT code, and ordering by budget.

const SCHEMA_STATEMENTS = `
  DEFINE TABLE IF NOT EXISTS opere_incompiute SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS titolo              ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS cup                 ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS stazione_appaltante ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS provincia           ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS stato               ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS codice_istat        ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS cod_nuts            ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS regione             ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS importo_intervento  ON opere_incompiute TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS importo_oneri       ON opere_incompiute TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS perc_avanzamento    ON opere_incompiute TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS opera_fruibile      ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS uso_ridimensionato  ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS anno_riferimento    ON opere_incompiute TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS fonte_url           ON opere_incompiute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at         ON opere_incompiute TYPE datetime DEFAULT time::now();

  DEFINE INDEX IF NOT EXISTS idx_regione          ON opere_incompiute FIELDS regione;
  DEFINE INDEX IF NOT EXISTS idx_codice_istat     ON opere_incompiute FIELDS codice_istat;
  DEFINE INDEX IF NOT EXISTS idx_importo          ON opere_incompiute FIELDS importo_intervento;
  DEFINE INDEX IF NOT EXISTS idx_anno_riferimento ON opere_incompiute FIELDS anno_riferimento;

  -- Spesa Pubblica / state payments by functional mission.
  -- Source: BDAP "Pagamenti Bilancio dello Stato per Missione".
  --
  -- Holds TWO snapshots, discriminated by the periodo field: 'annuale' is the
  -- December (full-year) cumulative of the last complete year, 'progressivo'
  -- is the year-to-date cumulative of the year in progress. Every aggregate
  -- read MUST filter on periodo, otherwise the two are summed together and
  -- the totals are meaningless. See lib/ingest/spesaPubblica.ts.
  DEFINE TABLE IF NOT EXISTS spesa_missioni SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS codice_missione   ON spesa_missioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS missione          ON spesa_missioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS anno              ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS mese_contabile    ON spesa_missioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS mese_numero       ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS periodo           ON spesa_missioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS pacchetto         ON spesa_missioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS op_erario         ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS op_tesoreria      ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS op_esterno        ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS oa_tesoreria      ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS oa_spesa_deleg    ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS rsf_stipendi      ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS rsf_altro         ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS totale_pagato     ON spesa_missioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS fonte_url         ON spesa_missioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at       ON spesa_missioni TYPE datetime DEFAULT time::now();

  DEFINE INDEX IF NOT EXISTS idx_spesa_anno    ON spesa_missioni FIELDS anno;
  DEFINE INDEX IF NOT EXISTS idx_spesa_totale  ON spesa_missioni FIELDS totale_pagato;
  DEFINE INDEX IF NOT EXISTS idx_spesa_periodo ON spesa_missioni FIELDS periodo;

  -- Fondi Europei / EU cohesion funds.
  -- Source: OpenCoesione aggregati API (single JSON call). One row per
  -- region / per theme / per year, each populated from a separate table
  -- so read queries stay simple.
  DEFINE TABLE IF NOT EXISTS fondi_regioni SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS codice                     ON fondi_regioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS nome                       ON fondi_regioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS costo_pubblico             ON fondi_regioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS costo_pubblico_coesione    ON fondi_regioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti                  ON fondi_regioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti_coesione         ON fondi_regioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS progetti                   ON fondi_regioni TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS fonte_url                  ON fondi_regioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at                ON fondi_regioni TYPE datetime DEFAULT time::now();

  DEFINE INDEX IF NOT EXISTS idx_fondi_regioni_nome     ON fondi_regioni FIELDS nome;
  DEFINE INDEX IF NOT EXISTS idx_fondi_regioni_costo    ON fondi_regioni FIELDS costo_pubblico;

  DEFINE TABLE IF NOT EXISTS fondi_temi SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS codice                     ON fondi_temi TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS nome                       ON fondi_temi TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS costo_pubblico             ON fondi_temi TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS costo_pubblico_coesione    ON fondi_temi TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti                  ON fondi_temi TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti_coesione         ON fondi_temi TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS progetti                   ON fondi_temi TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS fonte_url                  ON fondi_temi TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at                ON fondi_temi TYPE datetime DEFAULT time::now();

  DEFINE TABLE IF NOT EXISTS fondi_yearly SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS anno                 ON fondi_yearly TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS ammontare_impegni    ON fondi_yearly TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS ammontare_pagamenti  ON fondi_yearly TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS fonte_url            ON fondi_yearly TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at          ON fondi_yearly TYPE datetime DEFAULT time::now();

  DEFINE INDEX IF NOT EXISTS idx_fondi_yearly_anno ON fondi_yearly FIELDS anno;

  -- Top-level totals from OpenCoesione. Kept as its own one-row table
  -- because the API totals CANNOT be reconstructed by summing the
  -- regional rows -- multi-region projects are counted in each of their
  -- regions, so SUM(fondi_regioni.costo_pubblico) overstates the true
  -- pipeline value by ~50%.
  DEFINE TABLE IF NOT EXISTS fondi_totali SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS costo_pubblico             ON fondi_totali TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS costo_pubblico_coesione    ON fondi_totali TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti                  ON fondi_totali TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti_coesione         ON fondi_totali TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS progetti                   ON fondi_totali TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS data_aggiornamento         ON fondi_totali TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS fonte_url                  ON fondi_totali TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at                ON fondi_totali TYPE datetime DEFAULT time::now();

  -- Appalti / contracting authorities from ANAC.
  -- One row per "stazione appaltante" (contracting station) in the
  -- national registry, about 48k rows. Small enough that SurrealDB can
  -- group and count on it in under 50ms per query.
  DEFINE TABLE IF NOT EXISTS appalti_stazioni SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS codice_fiscale             ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS partita_iva                ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS denominazione              ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS codice_ausa                ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS natura_giuridica_codice    ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS natura_giuridica           ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS provincia_codice           ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS provincia                  ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS regione                    ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS citta                      ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS codice_istat               ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS cap                        ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS flag_in_house              ON appalti_stazioni TYPE option<bool>;
  DEFINE FIELD IF NOT EXISTS flag_partecipata           ON appalti_stazioni TYPE option<bool>;
  DEFINE FIELD IF NOT EXISTS stato                      ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS fonte_url                  ON appalti_stazioni TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at                ON appalti_stazioni TYPE datetime DEFAULT time::now();

  DEFINE INDEX IF NOT EXISTS idx_appalti_natura         ON appalti_stazioni FIELDS natura_giuridica_codice;
  DEFINE INDEX IF NOT EXISTS idx_appalti_provincia      ON appalti_stazioni FIELDS provincia_codice;
  DEFINE INDEX IF NOT EXISTS idx_appalti_regione        ON appalti_stazioni FIELDS regione;
  DEFINE INDEX IF NOT EXISTS idx_appalti_stato          ON appalti_stazioni FIELDS stato;

  -- Project completion status breakdown from OpenCoesione
  -- aggregati.stati_progetti. Five rows: Concluso, In corso, Liquidato,
  -- Non avviato, Non determinabile. Each row has the cost/payment totals
  -- for projects in that status plus the project count.
  DEFINE TABLE IF NOT EXISTS fondi_stati SCHEMALESS;

  DEFINE FIELD IF NOT EXISTS codice                  ON fondi_stati TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS nome                    ON fondi_stati TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS costo_pubblico          ON fondi_stati TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS costo_pubblico_coesione ON fondi_stati TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti               ON fondi_stati TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS pagamenti_coesione      ON fondi_stati TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS progetti                ON fondi_stati TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS ordine                  ON fondi_stati TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS fonte_url               ON fondi_stati TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at             ON fondi_stati TYPE datetime DEFAULT time::now();

  -- =====================================================================
  -- Parlamento: parliamentary sessions, agenda items, interventions, speakers.
  --
  -- Sources:
  --   * dati.camera.it (SPARQL) -- list of Camera sedute, daily refresh.
  --   * documenti.camera.it/leg{N}/resoconti/assemblea/xml/.../stenografico.xml
  --     -- one clean XML transcript per Camera session.
  --   * dati.senato.it (SPARQL + bulk) -- Senato sedute and intervention metadata.
  --   * senato.it/show-doc?tipodoc=Resaula&... -- Senato HTML transcripts.
  --
  -- The shape is corpus-style (one row per intervention / per OdG) rather
  -- than aggregate-style (KPIs, regional rollups) like the other sections.
  -- Full-text search over the corpus is served by Meilisearch (see
  -- server/lib/meilisearch.ts), not a SurrealDB search index; SurrealDB is
  -- the source of truth and the Meili index is a disposable replica.
  -- =====================================================================

  DEFINE TABLE IF NOT EXISTS parlamento_sedute SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS chamber       ON parlamento_sedute TYPE string;
  DEFINE FIELD IF NOT EXISTS legislatura   ON parlamento_sedute TYPE number;
  DEFINE FIELD IF NOT EXISTS numero        ON parlamento_sedute TYPE number;
  DEFINE FIELD IF NOT EXISTS data          ON parlamento_sedute TYPE datetime;
  DEFINE FIELD IF NOT EXISTS titolo        ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS source_url    ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS xml_url       ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS html_url      ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS video_url     ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS interventi_n  ON parlamento_sedute TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS odg_n         ON parlamento_sedute TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS body_status   ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS body_error    ON parlamento_sedute TYPE option<string>;
  -- refs_status: 'pending' | 'ok' | 'failed'. Tracks the per-seduta
  -- progress of the reference-extraction pass independently of the body
  -- pass, so iterating on the parser does not require re-fetching XML.
  -- refs_parser_version mirrors PARSER_VERSION at the time of the last
  -- successful pass; the refs ingest re-runs whenever it is stale.
  DEFINE FIELD IF NOT EXISTS refs_status         ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS refs_parser_version ON parlamento_sedute TYPE option<number>;
  -- ---------------------------------------------------------------------
  -- Organo: which body actually sat. 'assemblea' is the plenary corpus that
  -- predates this field; 'commissione' is a committee sitting.
  --
  -- Committee sittings share this table (rather than living in a sibling
  -- one) because everything downstream of a seduta -- parlamento_odg,
  -- parlamento_interventi, the refs extractor, the Meilisearch sync, the
  -- persona/mandato speaker model -- is identical for both. Splitting the
  -- table would have meant duplicating all of it and, worse, would have left
  -- committee speeches out of full-text search until each of those pipelines
  -- was taught about the second table.
  --
  -- The cost of sharing is that (chamber, legislatura, numero) is NO LONGER
  -- unique: committee resoconti are numbered per-committee, so camera/19/1
  -- names one plenary sitting but also one sitting of every committee. Every
  -- query that means "a plenary sitting" must therefore say so. See the
  -- organo = "assemblea" filters in routes/parlamento.ts -- they are load
  -- bearing, not decoration.
  DEFINE FIELD IF NOT EXISTS organo         ON parlamento_sedute TYPE option<string>;
  -- Committee identity, in each chamber's own code space:
  --   camera -> idCommissione, zero-padded 2 digits ("03", "70")
  --   senato -> "{tipo}-{cod}" from dati.senato.it/commissione/{tipo}-{cod}
  DEFINE FIELD IF NOT EXISTS organo_cod     ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS organo_nome    ON parlamento_sedute TYPE option<string>;
  -- Chamber-qualified url-safe key for the committee, e.g. "camera-03". This
  -- is what the reader routes on, because organo_cod alone collides across
  -- chambers.
  DEFINE FIELD IF NOT EXISTS organo_slug    ON parlamento_sedute TYPE option<string>;
  -- 'stenografico' (verbatim) or 'sommario' (third-person summary). This is a
  -- content warning as much as metadata: Senato publishes committee work as
  -- sommari, whose sentences paraphrase the speaker rather than quote them,
  -- so the reader must not present them as quotations.
  DEFINE FIELD IF NOT EXISTS tipo_resoconto ON parlamento_sedute TYPE option<string>;
  -- Source-specific classification of a committee sitting. The two chambers
  -- populate these differently and the values are NOT comparable across them:
  --
  --   camera: tipologia is the sitting kind ('indag' = indagine conoscitiva,
  --           'audiz2' = audizione, 'altro', or a sede code) and
  --           sottotipologia names the specific inquiry when there is one
  --           ('c03_commercio'). Both are literal path segments of the
  --           upstream URL, so they are stored verbatim rather than
  --           normalised -- the body pass rebuilds the URL from them.
  --   senato: tipologia holds the committee's CATEGORY ('Commissioni
  --           permanenti', 'Giunte', ...) from the LOD graph, because the
  --           sommari carry no per-sitting kind. sottotipologia is unused.
  --
  -- Anything rendering these must therefore branch on chamber. The reader's
  -- label map only covers the Camera values and falls back to no badge.
  DEFINE FIELD IF NOT EXISTS tipologia      ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS sottotipologia ON parlamento_sedute TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ingested_at   ON parlamento_sedute TYPE datetime DEFAULT time::now();
  DEFINE INDEX IF NOT EXISTS idx_seduta_data    ON parlamento_sedute FIELDS data;
  DEFINE INDEX IF NOT EXISTS idx_seduta_chamber ON parlamento_sedute FIELDS chamber;
  DEFINE INDEX IF NOT EXISTS idx_seduta_status  ON parlamento_sedute FIELDS body_status;
  DEFINE INDEX IF NOT EXISTS idx_seduta_refs_status ON parlamento_sedute FIELDS refs_status;
  -- Composite index for the per-seduta point lookup that every reader load
  -- runs twice (detail + interventi handlers): WHERE chamber = $c AND
  -- legislatura = $l AND numero = $n. A leading-prefix match also serves the
  -- (chamber, legislatura) per-leg filters. Replaces an index-narrow-then-scan
  -- (idx_seduta_chamber narrows to one chamber, then scans for leg+numero)
  -- with a direct hit. The /sedute listing keeps WITH NOINDEX for sort
  -- correctness, so this index does not affect it.
  DEFINE INDEX IF NOT EXISTS idx_seduta_chamber_leg_num ON parlamento_sedute FIELDS chamber, legislatura, numero;
  -- The listing and calendar endpoints always narrow by organo first (the
  -- reader shows plenary and committee work in separate views), so this is
  -- the leading column. (chamber, legislatura) trails it to serve the
  -- per-leg filters within a view.
  DEFINE INDEX IF NOT EXISTS idx_seduta_organo ON parlamento_sedute FIELDS organo, chamber, legislatura;
  -- Serves the committee detail page: every sitting of one committee, newest
  -- first.
  DEFINE INDEX IF NOT EXISTS idx_seduta_organo_slug ON parlamento_sedute FIELDS organo_slug, data;



  DEFINE TABLE IF NOT EXISTS parlamento_odg SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS seduta_id  ON parlamento_odg TYPE record<parlamento_sedute>;
  DEFINE FIELD IF NOT EXISTS posizione  ON parlamento_odg TYPE number;
  DEFINE FIELD IF NOT EXISTS titolo     ON parlamento_odg TYPE string;
  DEFINE FIELD IF NOT EXISTS anchor     ON parlamento_odg TYPE string;
  -- chamber / legislatura / data are denormalised from the owning seduta for
  -- exactly the reason parlamento_riferimenti denormalises them (see the
  -- comment on that table below): /odg/search filters and sorts on these, and
  -- doing it through the seduta record link dereferences the link once per
  -- row. Measured on the live corpus (212,939 odg rows): the traversing form
  -- of the search count took 2823ms; the denormalised form is a plain column
  -- scan. All three are immutable for the life of a seduta -- a sitting never
  -- changes chamber, legislature, or date -- so there is no sync hazard.
  -- Written by the three body-pass session ingests; backfilled for existing
  -- rows by scripts/backfill-odg-denorm.ts.
  DEFINE FIELD IF NOT EXISTS chamber     ON parlamento_odg TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS legislatura ON parlamento_odg TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS data        ON parlamento_odg TYPE option<datetime>;
  -- titolo_lower is titolo pre-lowercased at ingest, and it is what actually
  -- makes /odg/search fast. Benchmarked on the live corpus (212,939 rows):
  --
  --   count(), no predicate                            130ms
  --   titolo CONTAINS $q                              1147ms
  --   string::lowercase(titolo) CONTAINS lower($q)    2575ms
  --
  -- i.e. recomputing a lowercased copy of every title on every query cost
  -- ~1.4s, dwarfing everything else -- including the seduta link traversal
  -- the filters used to do, which measured as noise (2685ms with it vs
  -- 2667ms without). Comparing against a stored lowercase column keeps the
  -- match case-insensitive at the cheaper price.
  -- organo mirrors the owning seduta's, for the same reason chamber and
  -- legislatura do: /odg/search filters on it, and resolving it through the
  -- seduta record link costs a link dereference per row (measured at 2.8s on
  -- the 213k-row corpus). Without it, committee agenda items would silently
  -- appear in searches meant for plenary business.
  DEFINE FIELD IF NOT EXISTS organo ON parlamento_odg TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS titolo_lower ON parlamento_odg TYPE option<string>;
  DEFINE INDEX IF NOT EXISTS idx_odg_seduta ON parlamento_odg FIELDS seduta_id, posizione;
  -- Serves the leg/chamber narrowing on /odg/search. The titolo predicate is a
  -- CONTAINS, which no index can seek, so the scan itself is unavoidable --
  -- this just keeps the scan on plain columns and lets the planner skip whole
  -- legislatures when the filter is set.
  DEFINE INDEX IF NOT EXISTS idx_odg_chamber_leg ON parlamento_odg FIELDS chamber, legislatura;
  DEFINE INDEX IF NOT EXISTS idx_odg_data        ON parlamento_odg FIELDS data;
  DEFINE INDEX IF NOT EXISTS idx_odg_organo      ON parlamento_odg FIELDS organo, chamber, legislatura;


  DEFINE TABLE IF NOT EXISTS parlamento_interventi SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS seduta_id    ON parlamento_interventi TYPE record<parlamento_sedute>;
  DEFINE FIELD IF NOT EXISTS odg_id       ON parlamento_interventi TYPE option<record<parlamento_odg>>;
  DEFINE FIELD IF NOT EXISTS posizione    ON parlamento_interventi TYPE number;
  -- mandato_id resolves the speaker to a specific (person × legislature ×
  -- chamber) mandate. Optional because a transcript can name a role with no
  -- profile link ("PRESIDENTE.") -- those rows still render via oratore_nome.
  DEFINE FIELD IF NOT EXISTS mandato_id   ON parlamento_interventi TYPE option<record<parlamento_mandato>>;
  DEFINE FIELD IF NOT EXISTS oratore_nome ON parlamento_interventi TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS gruppo       ON parlamento_interventi TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS ruolo        ON parlamento_interventi TYPE option<string>;
  -- testo is plain Unicode with paragraph breaks encoded as a double
  -- newline so the reader can split into paragraphs without an HTML
  -- round-trip. The Meilisearch sync strips these markers before indexing
  -- so they do not leak into search snippets.
  DEFINE FIELD IF NOT EXISTS testo        ON parlamento_interventi TYPE string;
  DEFINE FIELD IF NOT EXISTS anchor       ON parlamento_interventi TYPE string;
  DEFINE INDEX IF NOT EXISTS idx_int_seduta  ON parlamento_interventi FIELDS seduta_id, posizione;
  DEFINE INDEX IF NOT EXISTS idx_int_mandato ON parlamento_interventi FIELDS mandato_id;

  -- Full-text search over parlamento_interventi lives in Meilisearch, not
  -- SurrealDB. The earlier SurrealDB BM25 SEARCH index (idx_int_text, with a
  -- snowball(italian) analyzer) was retired 2026-06-16: its rebuild OOM-killed
  -- on this corpus and its postings/HIGHLIGHTS blobs were a major source of the
  -- RocksDB blob bloat. Meilisearch does its own Italian stemming and
  -- highlighting; SurrealDB keeps only the point/range indexes above and stays
  -- the source of truth. See server/lib/meilisearch.ts and
  -- scripts/meili-sync.ts for the index build.

  -- =====================================================================
  -- Persona + Mandato: the parliamentary entity model.
  --
  -- A "persona" is a real human, identified by the chamber's official numeric
  -- ID (camera.it /deputati/elenco/{leg}-{id_persona}/ or senato.it
  -- /loc/link.asp?tipodoc=sanasen&id={id_persona}). The id is stable across
  -- legislatures within one chamber. Cross-chamber identity (someone who
  -- served in both Camera and Senato) is intentionally NOT unified here:
  -- the two websites assign independent IDs and we don't try to bridge them.
  -- Each cross-chamber career counts as two personas.
  --
  -- A "mandato" is one term of office: (person × chamber × legislature). A
  -- person who served three legs in Camera has one persona row + three
  -- mandato rows. Per-leg data (gruppo, circoscrizione, ruolo, ...) lives on
  -- the mandato.
  --
  -- Both tables use composite record IDs:
  --   parlamento_persona:[chamber, id_persona]
  --   parlamento_mandato:[chamber, leg, id_persona]
  -- so every upsert is naturally idempotent.
  --
  -- One-time cleanup of pre-refactor tables (2026-05-15): the old
  -- parlamento_oratori (leg-blind) and parlamento_deputati (leg-19-only)
  -- are removed. After the first boot post-refactor these REMOVE statements
  -- become no-ops; they stay in the file so a stale DB also self-heals.
  --
  -- Removing the parlamento_oratori table is not enough: parlamento_interventi
  -- has a typed FIELD 'oratore_id TYPE option<record<parlamento_oratori>>' plus
  -- an index 'idx_int_oratore' that survive the DROP and point at a now-
  -- nonexistent table. Inserts validate the field type, fail to resolve the
  -- target table, and SurrealDB drops the connection ("fetch failed" on the
  -- client) before the row lands. So the whole body pass becomes a no-op on
  -- any DB that ever held the old schema. Strip both explicitly here.
  -- The 'html' / 'testo_hash' fields are also leftovers from earlier passes.
  -- =====================================================================
  REMOVE TABLE IF EXISTS parlamento_oratori;
  REMOVE TABLE IF EXISTS parlamento_deputati;
  REMOVE INDEX IF EXISTS idx_int_oratore ON parlamento_interventi;
  REMOVE FIELD IF EXISTS oratore_id ON parlamento_interventi;
  REMOVE FIELD IF EXISTS html ON parlamento_interventi;
  REMOVE FIELD IF EXISTS testo_hash ON parlamento_interventi;

  DEFINE TABLE IF NOT EXISTS parlamento_persona SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS chamber          ON parlamento_persona TYPE string ASSERT $value IN ["camera", "senato"];
  DEFINE FIELD IF NOT EXISTS id_persona       ON parlamento_persona TYPE number;
  DEFINE FIELD IF NOT EXISTS nome             ON parlamento_persona TYPE string;
  DEFINE FIELD IF NOT EXISTS data_nascita     ON parlamento_persona TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS comune_nascita   ON parlamento_persona TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS first_seen_at    ON parlamento_persona TYPE datetime DEFAULT time::now();
  DEFINE INDEX IF NOT EXISTS idx_persona_chamber_id ON parlamento_persona FIELDS chamber, id_persona UNIQUE;
  DEFINE INDEX IF NOT EXISTS idx_persona_nome       ON parlamento_persona FIELDS nome;

  DEFINE TABLE IF NOT EXISTS parlamento_mandato SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS persona_id        ON parlamento_mandato TYPE record<parlamento_persona>;
  DEFINE FIELD IF NOT EXISTS chamber           ON parlamento_mandato TYPE string ASSERT $value IN ["camera", "senato"];
  DEFINE FIELD IF NOT EXISTS legislatura       ON parlamento_mandato TYPE number;
  DEFINE FIELD IF NOT EXISTS id_persona        ON parlamento_mandato TYPE number;
  -- Display name as it appears for this leg; may differ slightly from the
  -- persona's canonical name (transcripts use "ROSSI", profile says "Rossi
  -- Mario"). Keeping it on the mandato avoids a join on the read path.
  DEFINE FIELD IF NOT EXISTS nome              ON parlamento_mandato TYPE option<string>;
  -- Per-leg group / role / electoral context. Populated by the deputati
  -- profile scraper; partially derivable from transcripts for some fields.
  DEFINE FIELD IF NOT EXISTS gruppo_attuale    ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS gruppo_storico    ON parlamento_mandato TYPE option<array>;
  DEFINE FIELD IF NOT EXISTS circoscrizione    ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS collegio          ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS lista_elezione    ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS data_proclamazione ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS formazione        ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS uffici            ON parlamento_mandato TYPE option<array>;
  DEFINE FIELD IF NOT EXISTS organi            ON parlamento_mandato TYPE option<array>;
  DEFINE FIELD IF NOT EXISTS ruolo             ON parlamento_mandato TYPE option<string>;
  -- Denormalised speech count for ranking / display.
  DEFINE FIELD IF NOT EXISTS interventi_n      ON parlamento_mandato TYPE option<number>;
  -- Profile-scrape bookkeeping (used by cameraDeputatiBulk).
  DEFINE FIELD IF NOT EXISTS source_url        ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS scrape_status     ON parlamento_mandato TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS fetched_at        ON parlamento_mandato TYPE option<datetime>;
  DEFINE INDEX IF NOT EXISTS idx_mandato_persona       ON parlamento_mandato FIELDS persona_id;
  DEFINE INDEX IF NOT EXISTS idx_mandato_chamber_leg   ON parlamento_mandato FIELDS chamber, legislatura;
  DEFINE INDEX IF NOT EXISTS idx_mandato_chamber_leg_id ON parlamento_mandato FIELDS chamber, legislatura, id_persona UNIQUE;
  DEFINE INDEX IF NOT EXISTS idx_mandato_gruppo        ON parlamento_mandato FIELDS chamber, legislatura, gruppo_attuale;

  -- =====================================================================
  -- References extracted from intervento testo (laws, decrees,
  -- Costituzione articles, atto Camera, atto Senato). One row per
  -- detected reference. Rows use a deterministic id of the form
  -- parlamento_riferimenti:[<intervento_id>, <parser_version>, <start>]
  -- so re-running the parser is a true UPSERT instead of
  -- delete-then-insert: there is no window where a reader request
  -- sees zero refs while the ingest rewrites them.
  --
  -- The seduta link is denormalised (also reachable via intervento ->
  -- seduta_id) so "all refs in seduta X" is a single indexed query.
  --
  -- url is null for AS (atto Senato) bills until the SPARQL resolver
  -- has mapped numero -> idDdl; resolve_status tracks that lifecycle.
  -- =====================================================================
  DEFINE TABLE IF NOT EXISTS parlamento_riferimenti SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS intervento     ON parlamento_riferimenti TYPE record<parlamento_interventi>;
  DEFINE FIELD IF NOT EXISTS seduta         ON parlamento_riferimenti TYPE record<parlamento_sedute>;
  -- chamber + legislatura are denormalised from seduta because the AS
  -- resolver and admin queries need to filter by (legislatura, numero)
  -- without traversing the seduta record link. Per the
  -- parlamento_perf memory: WHERE seduta.legislatura = $leg in a
  -- multi-million-row table forces a full scan even with the seduta
  -- index, so we pay 6 bytes per row to keep the filter indexable.
  DEFINE FIELD IF NOT EXISTS chamber        ON parlamento_riferimenti TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS legislatura    ON parlamento_riferimenti TYPE option<number>;
  -- organo denormalised from the seduta for the same reason chamber and
  -- legislatura are: /search?cita and the most-cited-laws leaderboard filter
  -- on it, and resolving it through the seduta record link puts a per-row
  -- link dereference inside the predicate.
  DEFINE FIELD IF NOT EXISTS organo         ON parlamento_riferimenti TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS tipo           ON parlamento_riferimenti TYPE string;
  DEFINE FIELD IF NOT EXISTS anno           ON parlamento_riferimenti TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS numero         ON parlamento_riferimenti TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS articolo       ON parlamento_riferimenti TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS urn            ON parlamento_riferimenti TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS url            ON parlamento_riferimenti TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS resolve_status ON parlamento_riferimenti TYPE string;
  -- Char offsets into the intervento's testo. start is inclusive,
  -- end_offset is exclusive (so end_offset - start === raw.length).
  -- end is avoided as a field name because it collides with SurrealQL's
  -- block keyword in some contexts; end_offset is also more explicit
  -- about the units (chars, not bytes).
  DEFINE FIELD IF NOT EXISTS start          ON parlamento_riferimenti TYPE number;
  DEFINE FIELD IF NOT EXISTS end_offset     ON parlamento_riferimenti TYPE number;
  DEFINE FIELD IF NOT EXISTS raw            ON parlamento_riferimenti TYPE string;
  DEFINE FIELD IF NOT EXISTS parser_version ON parlamento_riferimenti TYPE number;
  DEFINE FIELD IF NOT EXISTS created_at     ON parlamento_riferimenti TYPE datetime DEFAULT time::now();
  DEFINE INDEX IF NOT EXISTS idx_ref_intervento ON parlamento_riferimenti FIELDS intervento;
  DEFINE INDEX IF NOT EXISTS idx_ref_seduta     ON parlamento_riferimenti FIELDS seduta;
  DEFINE INDEX IF NOT EXISTS idx_ref_lookup     ON parlamento_riferimenti FIELDS tipo, anno, numero;
  DEFINE INDEX IF NOT EXISTS idx_ref_organo     ON parlamento_riferimenti FIELDS organo;
  DEFINE INDEX IF NOT EXISTS idx_ref_resolve    ON parlamento_riferimenti FIELDS resolve_status;
  -- Composite index for the AS-resolver UPDATE: WHERE tipo=as AND
  -- legislatura=L AND numero=N. Without this, every per-bill resolve
  -- scans the entire ref table.
  DEFINE INDEX IF NOT EXISTS idx_ref_as_lookup  ON parlamento_riferimenti FIELDS tipo, legislatura, numero;
  -- Single-column legislatura index for the leg-filtered citation aggregates
  -- (legislature page top_laws, /refs/leggi-piu-citate?leg, /refs/legge?leg).
  -- idx_ref_as_lookup can't serve these: it leads with tipo, and those queries
  -- use tipo != costituzione (an inequality), so the planner can't seek it.
  -- This lets WHERE legislatura = $leg seek the leg's ~20-30k rows instead of a
  -- full 165k-row scan + GROUP BY (1.4s -> ~0.8s).
  DEFINE INDEX IF NOT EXISTS idx_ref_legislatura ON parlamento_riferimenti FIELDS legislatura;

  -- Cache of Senato (atto Senato / DDL) numero -> idDdl resolutions.
  -- The Senato URL pattern needs an internal idDdl that the public
  -- "S.NUM" ordinal does not expose; we fetch the mapping once via
  -- the dati.senato.it SPARQL endpoint and persist it here so the AS
  -- ref resolver becomes a cheap local lookup on subsequent ingests.
  DEFINE TABLE IF NOT EXISTS parlamento_senato_ddl_idmap SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS leg        ON parlamento_senato_ddl_idmap TYPE number;
  DEFINE FIELD IF NOT EXISTS numero     ON parlamento_senato_ddl_idmap TYPE number;
  DEFINE FIELD IF NOT EXISTS id_ddl     ON parlamento_senato_ddl_idmap TYPE string;
  DEFINE FIELD IF NOT EXISTS url        ON parlamento_senato_ddl_idmap TYPE string;
  DEFINE FIELD IF NOT EXISTS updated_at ON parlamento_senato_ddl_idmap TYPE datetime DEFAULT time::now();
  DEFINE INDEX IF NOT EXISTS idx_senddl_lookup ON parlamento_senato_ddl_idmap FIELDS leg, numero UNIQUE;

  -- Single-row checkpoint per chamber so the long crawl can resume.
  DEFINE TABLE IF NOT EXISTS parlamento_ingest_state SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS chamber          ON parlamento_ingest_state TYPE string;
  DEFINE FIELD IF NOT EXISTS legislatura      ON parlamento_ingest_state TYPE number;
  DEFINE FIELD IF NOT EXISTS last_seduta_done ON parlamento_ingest_state TYPE option<number>;
  DEFINE FIELD IF NOT EXISTS index_run_at     ON parlamento_ingest_state TYPE option<datetime>;
  DEFINE FIELD IF NOT EXISTS body_run_at      ON parlamento_ingest_state TYPE option<datetime>;
  DEFINE FIELD IF NOT EXISTS updated_at       ON parlamento_ingest_state TYPE datetime DEFAULT time::now();
  DEFINE INDEX IF NOT EXISTS idx_pis_chamber  ON parlamento_ingest_state FIELDS chamber, legislatura UNIQUE;

  -- =====================================================================
  -- One-shot migrations.
  --
  -- runSchema() executes on every boot, so a backfill written as a plain
  -- UPDATE ... WHERE field IS NONE is NOT free once it has run: the
  -- predicate still scans the table to find the nothing it now matches.
  -- Measured on the live corpus, that is 1.66s of every startup for
  -- parlamento_odg's 213k rows.
  --
  -- A sentinel record turns each backfill into an O(1) point lookup after the
  -- first run, while still converging automatically on a fresh clone or an
  -- existing deployment with no operator step.
  -- =====================================================================
  DEFINE TABLE IF NOT EXISTS parlamento_migrations SCHEMALESS;
  DEFINE FIELD IF NOT EXISTS applied_at ON parlamento_migrations TYPE datetime DEFAULT time::now();

  -- organo: label every pre-existing sitting and agenda item as plenary. Rows
  -- written by the committee ingest always set organo explicitly, so anything
  -- still missing it predates the field.
  IF (SELECT VALUE id FROM ONLY parlamento_migrations:organo_backfill) IS NONE {
    UPDATE parlamento_sedute SET organo = "assemblea", tipo_resoconto = "stenografico"
      WHERE organo IS NONE;
    UPDATE parlamento_odg SET organo = "assemblea" WHERE organo IS NONE;
    CREATE parlamento_migrations:organo_backfill SET applied_at = time::now();
  };

  IF (SELECT VALUE id FROM ONLY parlamento_migrations:organo_backfill_refs) IS NONE {
    UPDATE parlamento_riferimenti SET organo = "assemblea" WHERE organo IS NONE;
    CREATE parlamento_migrations:organo_backfill_refs SET applied_at = time::now();
  };
`

export async function runSchema(): Promise<void> {
  const db = await getDb()
  await db.query(SCHEMA_STATEMENTS)
  console.log('[schema] all tables and indexes applied')
}
