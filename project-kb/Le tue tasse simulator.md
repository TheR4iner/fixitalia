# Le tue tasse simulator

## Overview

The `/le-tue-tasse` page turns a gross income into a full withholding breakdown and then
projects the income-tax share across the missioni del Bilancio dello Stato (reusing the
existing `spesa/by-missione` endpoint, no backend work).

The tax engine lives in two pure modules:

- `src/lib/tax-calc.ts` -- national rules: IRPEF scaglioni, contributi, detrazioni, bonus,
  and the three supported regimes (dipendente, pensionato, forfettario).
- `src/lib/tax-regions.ts` -- the per-region addizionale regionale tables.

Both are side-effect free and heavily unit-tested (`tax-calc.test.ts`, `tax-regions.test.ts`,
70 tests between them). The page is the only consumer.

## Current solution

### Tax year

The engine implements **anno d'imposta 2026**. `TAX_YEAR` is exported so the UI can label it.
Italian tax law changes every December, so treat every constant in these files as perishable
and re-verify against primary sources each January.

### Accuracy fixes applied (2026-08-16)

The original implementation encoded 2024 law and was materially wrong. What was fixed:

| Problem | Effect |
|---|---|
| Second IRPEF bracket still 35% | Legge di bilancio 2026 cut it to **33%**. Overstated tax by up to 440 EUR |
| Bonus cuneo fiscale entirely missing | Non-taxable sum for redditi <= 20.000. At 18.000 that is 864 EUR |
| Ulteriore detrazione 20k-40k missing | 1.000 EUR flat to 32.000, tapering to zero at 40.000 |
| Trattamento integrativo missing | 1.200 EUR up to 15.000, capienza-capped to 28.000 |
| +65 EUR detrazione (art. 13 c. 1.1) missing | Applies between 25.000 and 35.000 |
| INPS lacked the 1% aliquota aggiuntiva | Applies above the prima fascia (56.224 EUR in 2026) |
| Detrazioni clawback above 200.000 missing | 440 EUR reduction |

Net effect: the page **overstated withholdings for essentially every income below 40.000**.
Worked example at 15.000 lordo: old netto 12.126 EUR, correct netto 14.048 EUR -- a 1.922 EUR
(15,9%) understatement of take-home pay.

### Two rules that are easy to get wrong

1. **The bonus cuneo percentage is FLAT, not progressive.** 7,1% / 5,3% / 4,8% is applied to
   the *whole* reddito di lavoro dipendente, not band by band. At 18.000 that is
   `18.000 x 4,8% = 864`, not the ~1.092 a progressive reading gives. Confirmed by Agenzia
   delle Entrate circolare 4/E del 16 maggio 2025. Several commercial calculators and at
   least one widely-cited blog get this wrong; there is a regression test pinning it.

2. **Some regions apply their addizionale as a CLIFF, not marginally.** Most regions tax
   slice by slice like national IRPEF, but **Lazio, Friuli-Venezia Giulia and Valle d'Aosta**
   apply a single rate to the *entire* imponibile once a threshold is crossed. Lazio's
   L.R. 20/2025 says "l'aliquota e determinata in misura pari al ..."; FVG's says
   "sull'intero importo". Treating them as marginal understates the tax by hundreds of euro
   (at 40.000 lordo, Lazio owes 1.210 EUR where a marginal reading would say ~600).

### Regional data

All 20 regions plus the two autonomous provinces are encoded with full bracket ladders.
The authoritative source is the MEF Dipartimento delle Finanze rate database, which holds the
figures the regions themselves file:

```
https://www1.finanze.gov.it/finanze2/dipartimentopolitichefiscali/fiscalitalocale/addregirpef/addregirpef.php?reg=<NN>&anno=2026
```

Note `reg=NN` there is the MEF's own alphabetical code, **not** the ISTAT region code. Our
`Regione.code` is the ISTAT code (with `04-TN` / `04-BZ` splitting Trentino-Alto Adige);
`Regione.fonte` stores the URL each figure came from and is rendered in the UI.

**Do not trust commercial aggregators for these.** During research, calcolaral, centrofiscale
and calcolatorifiscali gave three mutually contradictory tables for Lombardia alone (1,73%
flat / 1,23% flat / a 4-bracket ladder). Several also attributed Lazio's 2026 provisions to
Marche. Only MEF and the regions' own sites were used.

The regional structures beyond plain brackets that are modelled:

- `esenzioneFinoA` -- Valle d'Aosta (15.000), Trento (30.000, via a deduction that exactly
  cancels the base and is lost entirely above the threshold).
- `bracketsAgevolate` -- Umbria waives its maggiorazioni up to 28.000, falling back to the
  1,23% national base rate.
- `detrazione` -- Bolzano 430,50 (up to 90.000), Lazio 60 (28.001-30.000), Umbria 150
  (28.001-50.000). Floored at zero: these never generate a credito d'imposta.

### Deliberately NOT modelled

**Regional per-child detrazioni.** Six regions offer one (Piemonte 100, Trento 246,
Bolzano 340, Campania 30, Puglia 20, Sardegna 200) but each defines the qualifying child
differently: *figli minorenni* in Sardegna, *figli a carico* in Trento, *oltre il terzo* in
Puglia, *oltre il secondo* in Piemonte. Our `figliACarico` input means "aged 21-30" (the
national art. 12 definition), so applying these off that single number would be confidently
wrong. Each affected region instead carries a `nota` string that the UI displays.

### Regime notes

- **Dipendente**: contributi 9,19% (+1% above 56.224). Gets bonus cuneo, ulteriore detrazione
  and trattamento integrativo.
- **Pensionato**: no contributi at all, and a *different* detrazione (art. 13 c. 3, which
  starts tapering at 8.500 rather than 15.000). Gets none of the employee credits.
- **Forfettario**: imposta sostitutiva 5% (first five years) or 15% on
  `ricavi x coefficiente - contributi`. It **replaces IRPEF and both addizionali**, and grants
  no detrazioni whatsoever -- so the region/comune/mensilita/familiari controls are hidden
  for it rather than shown and ignored. `nettoMensile` is always a plain twelfth: a partita
  IVA has no thirteenth instalment, and the mensilita selector must not leak in.

### Donut invariant

`buildSlices()` in the page splits the lordo into four non-negative slices that always sum
back to it. Bonus credits are netted against IRPEF first, then the addizionali. When credits
exceed all tax due (low incomes), the surplus sits *outside* the ring, because it is money
paid on top of the gross rather than a share of it -- so the donut's netto slice reads lower
than the netto KPI. Both the donut and the detail card carry an Italian note explaining this;
do not "fix" the discrepancy by inflating the slice, it would break the sum-to-lordo invariant.

## Open questions

- **Basilicata** may have raised its rate mid-2026 to cover a sanita deficit (a proposal was
  sent to MEF in April 2026). The MEF database still shows a flat 1,23%, which is what we
  encode, but the lookup tool can lag recent regional legislation. Re-check.
- **Addizionale comunale** is a single user-entered rate defaulting to the 0,6% national
  average. Real comuni often have brackets and exemption thresholds (Milano exempts up to
  21.000, Roma uses progressive bands). A comune-level table keyed by ISTAT codice comune
  would be the natural next step and fits the project's ISTAT-key convention.
- The UI has no shadcn `select` primitive: the workspace firewall blocks `ui.shadcn.com`, so
  `src/components/OptionField.tsx` wraps native `<select>`/`<input>` styled from the design
  tokens. If the registry ever becomes reachable, revisit whether it is worth swapping.
- `formatEUR` renders 4-digit values without a thousands separator ("1799 €") while 5-digit
  ones get one ("23.387 €"). This is correct CLDR behaviour for it-IT
  (`minimumGroupingDigits: 2`), not a bug, but it looks inconsistent in the stat strip.
  Passing `useGrouping: 'always'` would change it site-wide; not done unilaterally.

## History

### 2026-08-16 -- bonus cuneo fiscale was computed on the wrong income

`computeIrpefRegime` called `bonusCuneoFiscale(redditoComplessivo)` while the
function's own parameter was named `redditoLavoroDipendente` -- exactly the
conflation the module header (lines 9-13) warns must never happen.

L. 207/2024 art. 1 c. 4-5 uses TWO different incomes:

- **eligibility** is gated on reddito complessivo (<= 20.000 EUR)
- **the percentage band and the base it applies to** are the reddito di lavoro
  dipendente, i.e. the gross

The old single-argument form used reddito complessivo for both. Since the two
differ by the INPS contribution, a gross just over the ceiling slipped under it
once contributions were deducted. Concretely at RAL 21.500: contributi ~1.976,
complessivo ~19.524, so the code paid 19.524 x 4,8% = ~937 EUR where the
correct answer is 0.

The unit tests exercised `bonusCuneoFiscale` in isolation and never pinned the
wiring, so nothing caught it. Now a two-argument function
`(redditoComplessivo, redditoLavoroDipendente)` with a regression test that
asserts both the gate and the base.

**Needs a domain check before shipping**: this changes the computed net for a
band of employee incomes. The reading above is from the statute + AdE circolare
4/E del 16 maggio 2025; if the intended interpretation differs, revert to the
one-argument form.


### 2026-08-16 -- accuracy audit + tailoring options

Audited the calculator against current law, found it encoded 2024 rules with several missing
terms (table above), and rewrote it for 2026. Added regime / regione / comune / mensilita /
familiari a carico options, a line-by-line "dettaglio del calcolo" card, and per-region source
links. Regional bracket tables researched across five parallel subagents against MEF and the
regions' own legislative portals; the cliff-vs-marginal distinction was the key finding and
turned out to be real for three regions.

Verified in-browser at 30.000 / 40.000 / 15.000 across dipendente and forfettario; every line
reconciles with hand computation. 90 frontend tests pass, tsc and eslint clean, build clean.
