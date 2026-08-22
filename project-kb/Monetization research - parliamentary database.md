## Overview

Research into the realistic monetization potential for a comprehensive, queryable database of all Italian parliament sessions (Camera + Senato, all sittings, speakers, votes, transcripts) since recorded history began. Researched June 2026.

---

## PATH A: Sell/license to Italian government bodies

### What Camera and Senato already offer (free)

Both chambers already publish open data under CC-BY 4.0:

- **dati.camera.it**: SPARQL endpoint, REST API (XML/JSON), downloadable ZIP datasets. Covers deputies, votes, bills, commissions. The historical portal (storia.camera.it) covers **1848 to 2022** across all legislatures. Dataset count: 104+. Updated daily.
- **dati.senato.it**: Same architecture -- SPARQL endpoint, CSV/JSON/XML bulk downloads, GitHub repo (`SenatoDellaRepubblica/OpenData`) with Akoma Ntoso XML. Covers senators, votes, bills, commissions.

**Key gap**: Both portals are technically comprehensive for recent legislatures but require SPARQL/RDF expertise that most journalists and researchers lack. The Il Sole 24 Ore InfoData review (Jan 2023) called them "not for everyone" and "equally difficult." There is **no cross-chamber unified query surface** and no queryable transcript corpus for the Senato.

### Has anyone sold data back to Italian government?

No precedents found. The market direction runs the opposite way: institutions publish open data outward, not inward. Camera and Senato would almost certainly argue they already have their data internally.

### AGID and procurement mechanics

- **Direct award (affidamento diretto)**: possible below EUR 143,000 for central PA bodies, no competitive tender required.
- **Negotiated procedure**: EUR 143k--221k, must invite 5+ operators.
- **Timeline**: Even "fast track" ICT procurement under PNRR takes 3--12 months from first contact to contract signature in practice. Standard procurement without PNRR urgency takes 12--24 months.
- **PNRR digital transformation angle**: Italy has ~EUR 47 billion in PNRR digital initiatives, with a "fast track" ICT whitelist being created. A data enrichment/analytics service could theoretically fit. But the primary buyers (Camera, Senato) are not PNRR targets and have their own IT offices.

**Verdict**: Dead end for Camera/Senato as direct buyers. Possible niche: regional assemblies (Consigli Regionali) or research bodies (ISAP, parliamentary research services) that want enriched historical data but lack resources to build it. Smaller ticket, more realistic, but still slow.

---

## PATH B: API subscription for journalists and researchers

### Comparable parliamentary API pricing

| Service | Coverage | Model | Price |
|---|---|---|---|
| TheyWorkForYou (mySociety, UK) | UK Parliament + devolved | Paid API | £20/month for 1,000 calls; free for charities |
| Parltrack (EU Parliament) | EP only | Free/open | No paid tier; grant/donation funded |
| openparliament.ca (Canada) | Canadian Parliament | Free/open | Volunteer project, no revenue |
| VoteView (US Congress) | US roll-call votes | Free/open | UCLA-funded, NSF grants |
| ItaParlCorpus | Camera 1948--2022, speeches only | Free (CC-BY 4.0) | Academic dataset, no commercial tier |

**Pattern**: every comparable service is either free/open (academic or civic) or charges very modestly (mySociety's £20/month). mySociety's total revenue in 2024/25 was £2.63 million -- but ~57% of that came from SocietyWorks (FixMyStreet Pro for local authorities), not TheyWorkForYou's API. The API is essentially a cost center subsidized by charity grants and the commercial arm.

### Italian journalism outlets and data tools

- **IRPI**: total annual budget ~EUR 140,000, 80% from foreign foundations. Cannot afford paid data subscriptions; they receive free data.
- **Il Sole 24 Ore InfoData / Lab24**: Has a data desk (lab24.ilsole24ore.com), no evidence of buying external parliamentary datasets. They use public open data.
- **La Repubblica / Corriere della Sera**: Flagship outlets but no data desk equivalent to NYT/Guardian scale. GEDI (Repubblica's parent) was pursuing an OpenAI content deal in late 2024 -- suggests monetizing their own archive outward, not buying new data inward.
- **Wired Italia**: Small editorial team, no evidence of data tool budgets.

**Realistic price point for Italian journalism**: EUR 100--300/month for a team subscription. Total Italian addressable market: perhaps 5--15 organizations willing to pay. Ceiling: EUR 15k--50k ARR from journalism alone.

### Italian universities and political science research

- PRIN (Ministry research grants) funds political science projects at EUR 200k--2M over 3 years. Datasets are typically expected to be free or open-licensed as a grant deliverable.
- The ItaParlCorpus (Camera speeches 1948--2022) was published free under CC-BY 4.0 by Joshua Cova (MPIfG Cologne) in March 2025. This directly competes with and partially overlaps any speech transcript offering.
- ParlaMint II (CLARIN): 29 European parliaments, free, open license. Italy included.

**Realistic price point for academic research**: EUR 500--2,000/year per university department. But researchers strongly expect free or CC-licensed data; charging would face significant resistance. Total market: 10--20 Italian political science departments, plus EU comparative politics researchers.

### GDPR considerations

Parliamentary speeches are public record -- no GDPR issue for the content. Speaker biographical data (birth dates, addresses) needs care but is already public. No blocker to selling access.

---

## PATH C: Partner with or sell to Openpolis

### What Openpolis is

- **Fondazione Openpolis ETS** -- Italian non-profit (Ente Terzo Settore), founded as association 2006, became foundation 2017. Rome-based.
- Runs **Openparlamento**: monitors 16th--19th legislatures (2008--present). Free, donation-funded.
- Funding model: <15% from individual donations/5x1000; majority from project grants (EU tenders, Italian PA, private foundations) and commercial data/editorial/analysis services.
- Partners include ActionAid, Assonime, Confcommercio. They sell data provision, editorial services, and analysis services commercially.

### Historical depth gap

Openparlamento covers only 2008 onwards (16th legislature). The pre-2008 historical record (1948--2007, legislatures I--XV) is a gap they have not filled. This is where a comprehensive historical database would be genuinely additive.

### Would they buy/license?

- They already have a partial commercial model (data services). They could be a licensing customer for the historical (pre-2008) structured data they lack.
- More likely path: **partnership** rather than pure sale. They have the audience (journalists, researchers, activists) and the civic credibility; fixitalia could provide the data layer.
- Budget: unknown but small. Likely EUR 5k--20k range for a one-time data license, if they wanted it at all.
- **Risk**: their existing model is to build everything themselves with grant money, then give it away free. They may simply apply for a PRIN or EU grant to build the historical layer themselves.

**Verdict**: Most realistic soft partnership in Italy, but not meaningful revenue.

---

## ADDITIONAL: Grants

### EU grants

- **Horizon Europe** (Pillar II/III, democracy/SSH calls): EUR 3.5--4M grants for parliamentary/civic tech, but these require a consortium of 3+ EU organizations, 18-month application process, and heavy reporting. Not a short-term path.
- **Civic Innovation Fund 2025/2026** (NECE/The Civics): EUR 10,000--12,000. Useful for early validation, not a business.
- **European Democracy Shield** (adopted Nov 2025): new EC priority, expected to generate related calls in 2026--2027 Horizon work programme.
- **NGI (Next Generation Internet)**: primarily internet architecture/software, less relevant for a data product.
- **CEF Digital**: infrastructure focus, not applicable.

### Foundations

- **Open Society Foundations**: USD 1.2B in 2024 globally, focused on authoritarian-risk contexts. Italy is a low priority for them relative to Eastern Europe/Global South. Grant amounts for Western European civic tech: typically USD 50k--200k, competitive.
- **NED**: 2024 global disbursement USD 286M, 1,905 projects. Italy not a named priority. Possible but weak fit.
- **Sigrid Rausing Trust** (funds IRPI): possible, but their model is funding journalism organizations, not data products.

### Italian grants

- **PRIN 2022/2025**: Can fund academic-led data projects. Requires university PI. EUR 200k--1M. Indirect path: partner with a university department as PI who then subcontracts data work.
- **PNRR Componente M1C1**: Some calls for digital civic infrastructure. Complex, designed for PA entities.

---

## Summary: Most Promising Paths

1. **Openpolis data partnership**: Low revenue (~EUR 5--20k one-time) but highest probability of any Italian deal. Could provide distribution/credibility. Worth a direct email.

2. **Academic dataset licensing + consulting**: Target Italian political science departments (Bologna, LUISS, Firenze, Cattolica) and comparative politics researchers in Germany/UK who work on Italy. Price: EUR 500--2,000/year. Realistic ARR: EUR 5k--20k. Low friction if openly licensed with a "research license free, commercial use paid" model.

3. **EU/foundation grant for open historical corpus**: Target OSF, Horizon Europe SSH calls, or a PRIN partnership. Realistic grant: EUR 50--500k. Timeline: 12--24 months. The historical gap (pre-2008, and Senato transcript corpus) is a credible research infrastructure argument.

4. **API subscription to journalists/researchers**: Modeled on TheyWorkForYou but at Italian scale. Realistic max: EUR 20--50k ARR. Not a standalone business -- only viable as supplementary income alongside a grant-funded core.

5. **Sell to government (dead end near-term)**: Camera and Senato already have the data. Regional assemblies possible but slow. Not worth pursuing in the first 2 years.

## History

- June 2026: Initial research conducted.
