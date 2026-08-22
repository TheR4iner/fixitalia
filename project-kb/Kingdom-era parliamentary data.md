# Kingdom-era parliamentary data (pre-1948)

## Overview

The pre-Republic stenographic record -- Regno di Sardegna (from 1848)
and Regno d'Italia (1861-1943) -- is **digitized and available on
storia.camera.it**, contrary to the earlier assumption that it was
non-existent or palaeography-only. This note tracks it as a planned
**Phase 6** of the historical ingest, to begin after the Republic PDF
era (legs 1-12) ships. See [[Historical data sources probe]] for the
full source map and the Republic-era pipeline this builds on.

## Key facts

- **Coverage claim (from storia.camera.it's own `/lavori` page):**
  "i resoconti stenografici delle sedute ... dalla I legislatura del
  Regno di Sardegna alla XVII legislatura della Repubblica." So the
  stenographic record is digitized back to **1848**.
- **Navigation:** every Kingdom legislature has a live leg overview page
  (`/lavori/regno-di-sardegna/{1-7}/{ROMAN}`,
  `/lavori/regno-d-italia/{1-16+}/{ROMAN}`, HTTP 200). The per-session
  drill is the faceted endpoint
  `/lavori/{era}/leg-{era}-{ROMAN}/faccette/organo:Assemblea`.
- **Access gate:** the `/faccette/` listing endpoints are
  **reCAPTCHA-gated** (same wall as the deputati listings -- see
  [[Camera deputati historical URLs]]). Discovery needs Playwright +
  CAPTCHA handling, the same tooling as the rest of the Camera
  historical work. Not a new obstacle.
- **Senato:** Kingdom-era Senato (Senato del Regno, appointed not
  elected) is a separate question, not yet probed. The Republic Senato
  WAF + listing situation is documented in [[Parlamento section]].

## Open questions

- **Document format -- UNCONFIRMED and decisive.** 19th-century
  resoconti are almost certainly **scanned-image PDFs**, possibly with
  no text layer or poor OCR. This must be confirmed by pulling one real
  document in a browser session (blocked so far by the CAPTCHA wall).
  - If text-layer PDFs: the Republic cleaning + local-Ollama pipeline
    applies directly.
  - If scanned images: prepend an **OCR stage** (Tesseract with the
    Italian model, or a local vision model) before cleaning. OCR quality
    on 1848-1900 typography is the real risk -- the genuine
    "palaeography" concern, but about extraction quality, not
    availability.
- **Identity resolution:** pre-Republic deputies have storia.camera.it
  directory entries but no numeric `id_persona` in the modern OCD
  ontology coverage (which thins out before ~leg 10 even for the
  Republic). Name-resolution against the historical directory will be
  needed, with ambiguity for common surnames -- same shape as the
  Republic problem in [[Historical speaker mandato linking]] but harder.

## Plan (Phase 6, post-Republic)

- **6a -- 20th-century Kingdom (1900-1943):** cleaner scans, same
  storia.camera.it + Playwright path, OCR stage if needed.
- **6b -- 19th-century (1848-1900):** oldest/worst scans, smallest
  per-session volume, typographically hardest. A research sub-project,
  but tractable -- no longer "out of scope entirely."

## History

- **2026-06-12** -- Reclassified from "out of scope entirely" to a
  planned Phase 6 after a storia.camera.it probe showed the portal
  explicitly carries resoconti stenografici back to 1848. The earlier
  "non-existent / palaeography / not tractable" claim in
  [[Historical data sources probe]] was corrected. Document format
  (text vs scanned image) still needs confirmation in a browser session.
