// Single source of truth for the legislature number currently sitting in
// Italy. Update this constant when leg 20 begins; every importer auto-picks
// up the change. Historically the value was duplicated across ingest.ts,
// senatoListingScraper.ts, and the orchestrator, with no compile-time
// guarantee they stayed in sync.

export const CURRENT_LEGISLATURE = 19
