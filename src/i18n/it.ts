// Italian string dictionary. All user-facing copy lives here so that
// components stay free of inline text and there is a single place to review
// tone and wording. This project is Italian-first; there is no English
// fallback on purpose.
//
// "as const" lets TypeScript infer literal types, so typos in lookups fail
// at compile time instead of rendering "undefined" at runtime.

export const t = {
  brand: {
    name: 'fixitalia',
    tagline: 'I dati pubblici italiani, finalmente leggibili.',
    footerNote:
      'fixitalia aggrega dati pubblici ufficiali. Ogni numero riporta alla sua fonte originaria.',
    metaDescription:
      'Piattaforma di civic tech che aggrega i dati della pubblica amministrazione italiana in visualizzazioni chiare, con un linguaggio semplice, per raccontare inefficienza, cattiva gestione e sprechi di denaro pubblico.',
  },

  footer: {
    nav: 'Link di servizio',
    credit: 'Un progetto di Rolando Reiner. Codice open source con licenza MIT.',
    codeLabel: 'Codice su GitHub',
    codeUrl: 'https://github.com/TheR4iner/fixitalia',
  },

  nav: {
    openMenu: 'Apri il menu',
    closeMenu: 'Chiudi il menu',
    primary: 'Navigazione principale',
    theme: {
      toggleLabel: 'Cambia tema',
      toLight: 'Passa al tema chiaro',
      toDark: 'Passa al tema scuro',
    },
  },

  home: {
    heroHeadline: 'I soldi pubblici sono pubblici. Adesso anche leggibili.',
    heroSubheadline:
      'fixitalia raccoglie appalti, opere incompiute, fondi europei, spesa e attività parlamentare dai portali ufficiali e li racconta in modo comprensibile, con la fonte sempre a un clic di distanza.',
    exploreTitle: 'Le sezioni',
    exploreSubtitle:
      'Ogni sezione è autonoma: una si legge senza aver letto le altre.',
    readMore: 'Leggi',
    sectionLedes: {
      appalti:
        'Il registro ANAC conta decine di migliaia di stazioni appaltanti: una ogni poco più di mille cittadini. Fotografa quanto è frammentato il sistema degli acquisti pubblici italiani.',
      // These ledes are static copy on a page that loads no data, so they must
      // not assert a count. "Oltre quattrocento opere" sat here while the
      // registry held 266, and "In arrivo" sat on a section that had been
      // live for months.
      opereIncompiute:
        'Le opere pubbliche iniziate con soldi pubblici e mai portate a termine, regione per regione, dal registro del Ministero delle Infrastrutture.',
      fondiEuropei:
        'Impegni e pagamenti della politica di coesione europea dal 2000, per regione, per tema e nella loro progressione nel tempo. Il divario tra "promesso" e "erogato" si vede a colpo d\'occhio.',
      spesaPubblica:
        'I pagamenti del Bilancio dello Stato ripartiti nelle missioni funzionali della spesa pubblica italiana. Chi costa di più e chi di meno.',
      parlamento:
        'Le sedute di Camera e Senato dal 1996 a oggi: trascrizioni integrali, ordini del giorno e interventi, ricercabili a parola libera.',
      leTueTasse:
        'Inserisci il tuo stipendio lordo e scopri, euro su euro, dove finiscono le tue tasse fra le missioni del Bilancio dello Stato.',
    },
    healthLabel: 'Stato del servizio',
    healthChecking: 'Verifica in corso...',
    healthOk: 'Servizio operativo',
    healthError: 'Servizio non raggiungibile',
  },

  // Only `title` and `route` are consumed (Layout nav, page headers, and the
  // home grid). The `short` and `description` fields that used to sit here were
  // rendered NOWHERE, and unrendered copy drifts: by the time they were audited
  // three of the six promised features that do not exist.
  //
  //   spesaPubblica  described regional/municipal spending from SoldiPubblici
  //                  against ISTAT per-capita indicators -- a section never
  //                  built, on a source abandoned at design time.
  //   fondiEuropei   promised a countdown to the 2026 PNRR deadline; the
  //                  OpenCoesione feed carries no PNRR data and there is no
  //                  countdown on the page.
  //   parlamento     promised "presenze, voti, proposte presentate contro
  //                  approvate": there is no voting or attendance data at all,
  //                  no table and no route for it.
  //   opereIncompiute promised a geographic map and a spend history; the page
  //                  has a regional bar chart and a single reference year.
  //   appalti        promised single-bidder auctions, repeated direct awards and
  //                  base-vs-award gaps; the ingest deliberately covers only the
  //                  stazioni appaltanti registry, none of the CIG or
  //                  aggiudicazioni datasets those claims would need.
  //
  // They are deleted rather than corrected. Copy that nothing renders cannot be
  // kept honest, and any of these would have become visible and wrong the moment
  // someone wired the field up. Section blurbs that ARE rendered live in
  // `home.sectionLedes`.
  sections: {
    appalti: {
      title: 'Appalti',
      route: '/appalti',
    },
    opereIncompiute: {
      title: 'Opere Incompiute',
      route: '/opere-incompiute',
    },
    fondiEuropei: {
      title: 'Fondi Europei',
      route: '/fondi-europei',
    },
    spesaPubblica: {
      title: 'Spesa Pubblica',
      route: '/spesa-pubblica',
    },
    parlamento: {
      title: 'Parlamento',
      route: '/parlamento',
    },
    leTueTasse: {
      title: 'Le tue tasse',
      route: '/le-tue-tasse',
    },
  },

  // Not part of `sections`: the home page renders that map as the grid of
  // data sections, and Contatti is an about page, not a dataset.
  contatti: {
    title: 'Contatti',
    route: '/contatti',
    pageSubtitle:
      'fixitalia è un progetto personale, non un prodotto commerciale né una testata giornalistica.',
    authorName: 'Rolando Reiner',
    authorRole: 'Autore e manutentore del progetto',
    aboutTitle: 'Che cos’è fixitalia',
    aboutBody:
      'fixitalia nasce come progetto personale, sviluppato e mantenuto nel tempo libero. Non c’è dietro un’azienda, una redazione o un finanziamento pubblico: è un sito senza scopo di lucro, costruito per rendere leggibili dati che sono già pubblici ma quasi sempre illeggibili.',
    dataCaveat:
      'I dati vengono importati automaticamente dai portali ufficiali della pubblica amministrazione e possono contenere errori, lacune o ritardi di aggiornamento. Ogni numero riporta alla sua fonte originaria: prima di citarlo, verificalo sempre lì.',
    getInTouchTitle: 'Scrivimi',
    getInTouchBody:
      'Se noti un dato sbagliato, hai una fonte da segnalare o vuoi proporre una nuova sezione, il canale più diretto è LinkedIn.',
    linkedinLabel: 'Rolando Reiner su LinkedIn',
    linkedinUrl: 'https://www.linkedin.com/in/rolando-reiner/',
  },

  fonti: {
    title: 'Fonti e licenze',
    route: '/fonti',
    pageSubtitle:
      'Tutti i dati di fixitalia arrivano da portali pubblici ufficiali. Questa pagina dice quali, con quale licenza e a quali condizioni puoi riutilizzarli.',

    attributionTitle: 'Perché questa pagina esiste',
    attributionBody:
      'I dati della pubblica amministrazione italiana sono aperti, ma aperti non vuol dire senza condizioni. Quasi tutte le licenze in uso (CC BY 4.0 e IODL 2.0) chiedono una cosa sola in cambio: citare chi ha prodotto il dato. fixitalia lo fa due volte, sotto ogni grafico e in questo elenco.',
    attributionCaveat:
      'La licenza che vale è sempre quella pubblicata dal portale di origine: se una delle indicazioni qui sotto dovesse divergere dalla fonte, fa fede la fonte. Ogni riga rimanda al catalogo ufficiale corrispondente.',

    sourcesTitle: 'Da dove arrivano i dati',
    sourceLicenceLabel: 'Licenza',
    sources: [
      {
        name: 'ANAC -- Autorità Nazionale Anticorruzione',
        usedFor: 'Stazioni appaltanti e dati sugli appalti pubblici.',
        licence: 'CC BY 4.0',
        url: 'https://dati.anticorruzione.it/opendata/dataset/stazioni-appaltanti',
      },
      {
        name: 'Ministero delle Infrastrutture e dei Trasporti',
        usedFor: 'Anagrafe delle opere pubbliche incompiute.',
        licence: 'IODL 2.0',
        url: 'https://dati.mit.gov.it/catalog/dataset/opere-incompiute',
      },
      {
        name: 'OpenCoesione -- Dipartimento per le politiche di coesione',
        usedFor: 'Progetti finanziati dai fondi europei e loro stato di avanzamento.',
        licence: 'CC BY 4.0',
        url: 'https://opencoesione.gov.it/it/opendata/',
      },
      {
        name: 'BDAP -- Ragioneria Generale dello Stato',
        usedFor: 'Bilancio dello Stato e pagamenti per missione.',
        licence: 'CC BY 4.0',
        url: 'https://bdap-opendata.rgs.mef.gov.it/',
      },
      {
        name: 'Camera dei Deputati',
        usedFor: 'Sedute, resoconti stenografici, deputati e votazioni.',
        licence: 'CC BY 4.0',
        url: 'https://dati.camera.it/',
      },
      {
        name: 'Senato della Repubblica',
        usedFor: 'Sedute, senatori e attività d\'aula.',
        licence: 'CC BY 4.0',
        url: 'https://dati.senato.it/',
      },
      {
        name: 'MEF -- Dipartimento delle Finanze',
        usedFor: 'Aliquote delle addizionali regionali e comunali IRPEF.',
        licence: 'CC BY 4.0',
        url: 'https://www.finanze.gov.it/it/fiscalita-regionale-e-locale/',
      },
    ],

    codeTitle: 'Il codice',
    codeBody:
      'Il software che importa, elabora e mostra questi dati è pubblicato con licenza MIT: puoi leggerlo, copiarlo, modificarlo e riusarlo, anche in progetti commerciali, mantenendo la nota di copyright. La licenza MIT copre il codice, non i dati: quelli restano dei rispettivi enti, alle condizioni indicate sopra.',
    codeLinkLabel: 'Il progetto su GitHub',
    codeUrl: 'https://github.com/TheR4iner/fixitalia',

    reuseTitle: 'Se riusi questi numeri',
    reuseBody:
      'Cita l\'ente che ha prodotto il dato, non fixitalia. Questo sito è un livello di lettura, non la fonte: se un numero ti serve per un articolo, una tesi o un atto, prendilo dal portale ufficiale linkato accanto al grafico. Le rielaborazioni, gli indicatori derivati e i testi di commento sono invece opera di fixitalia e seguono la licenza del codice.',
  },

  privacy: {
    title: 'Privacy',
    route: '/privacy',
    pageSubtitle:
      'Che cosa fa fixitalia con i dati personali: poco, e questa pagina spiega esattamente quanto poco.',
    updatedLabel: 'Ultimo aggiornamento',
    updatedDate: '21 agosto 2026',

    sections: [
      {
        title: 'Titolare del trattamento',
        body:
          'Il titolare è Rolando Reiner, che gestisce fixitalia come progetto personale senza scopo di lucro. Per qualsiasi richiesta relativa ai dati personali il canale di contatto è quello indicato nella pagina Contatti.',
      },
      {
        title: 'Cosa non facciamo',
        body:
          'fixitalia non usa cookie, non usa sistemi di analytics o di tracciamento, non profila i visitatori, non ha registrazione né account, non invia newsletter e non condivide dati con terze parti a fini pubblicitari o commerciali.',
      },
      {
        title: 'Cosa resta sul tuo dispositivo',
        body:
          'Una sola preferenza, la scelta fra tema chiaro e scuro, viene salvata nella memoria locale del browser. Non lascia mai il tuo dispositivo, non viene inviata al server e non identifica nessuno. Puoi cancellarla svuotando i dati del sito dalle impostazioni del browser.',
      },
      {
        title: 'Log tecnici',
        body:
          'Come qualsiasi sito raggiungibile da internet, l\'infrastruttura che serve le pagine registra le richieste ricevute, comprese indirizzo IP, data e ora, pagina richiesta e user agent. Servono solo a far funzionare il sito e a difenderlo da abusi e attacchi. La base giuridica è il legittimo interesse (art. 6, par. 1, lett. f del GDPR). Non vengono usati per profilare né incrociati con altri dati.',
      },
      {
        title: 'Dati di parlamentari e amministratori pubblici',
        body:
          'fixitalia pubblica dati che riguardano persone: nomi di parlamentari, gruppo di appartenenza, presenze, voti e interventi in aula. Sono dati già pubblici, prodotti e diffusi dalle istituzioni stesse nell\'esercizio di una funzione pubblica, e vengono qui riorganizzati per finalità di informazione e trasparenza. La base giuridica è il legittimo interesse all\'informazione su chi esercita un mandato elettivo; l\'appartenenza politica è un dato particolare ai sensi dell\'art. 9 del GDPR, trattato in quanto reso manifestamente pubblico dall\'interessato nell\'esercizio del mandato.',
      },
      {
        title: 'Nessuna accusa, solo numeri',
        body:
          'Gli indicatori pubblicati descrivono schemi statistici nei dati ufficiali. Non sono accertamenti di responsabilità, non attribuiscono illeciti e non vanno letti come tali. Se un dato che ti riguarda è sbagliato o non aggiornato, segnalalo: viene verificato sulla fonte e corretto o rimosso.',
      },
      {
        title: 'I tuoi diritti',
        body:
          'Puoi chiedere in qualsiasi momento l\'accesso ai dati che ti riguardano, la loro rettifica o cancellazione, la limitazione del trattamento, e puoi opporti al trattamento fondato sul legittimo interesse. Hai inoltre diritto di proporre reclamo al Garante per la protezione dei dati personali.',
      },
    ],

    contactTitle: 'Come esercitare i tuoi diritti',
    contactBody:
      'Scrivi tramite il canale indicato nella pagina Contatti, specificando la richiesta. Le segnalazioni su dati errati sono benvenute anche da chi non è l\'interessato.',
    contactLinkLabel: 'Vai ai contatti',
  },

  common: {
    // Chart tooltip row labels, shared by every section's charts.
    chartAmount: 'Importo',
    chartShare: 'Quota',
    comingSoon: 'Prossimamente',
    comingSoonBody:
      'Questa sezione è in lavorazione. Stiamo preparando la prima versione con dati reali e fonti ufficiali.',
    source: 'Fonte',
    viewSource: 'Vedi la fonte',
    viewAll: 'Vedi tutto',
    loading: 'Caricamento...',
    noData: 'Nessun dato disponibile.',
    beta: {
      badge: 'Beta',
      title: 'Questa sezione è in fase di test',
      body: "I dati sono importati automaticamente dai portali ufficiali e possono essere incompleti, non aggiornati o contenere errori di estrazione. Prima di citare o utilizzare un'informazione, verificala sempre sulla fonte ufficiale.",
      sourcesLabel: 'Fonti ufficiali:',
    },
    errorBoundary: {
      title: 'Qualcosa è andato storto',
      body: 'Non siamo riusciti a mostrare questa pagina. Riprova o torna alla home.',
      retry: 'Riprova',
      home: 'Torna alla home',
    },
  },

  opereIncompiute: {
    pageSubtitle:
      // NOT "l'ultima graduatoria pubblicata". That was false: as of 2026-08-17
      // MIT had published the 2024 reference year while this section served
      // 2023, because dati.mit.gov.it has been returning 503 and the ingest
      // could not fetch it. The reference year is on the badge next to the
      // title, derived from the file itself, so the honest claim is "the most
      // recent one we were able to import", which the copy no longer contradicts.
      "Lavori pubblici iniziati con fondi pubblici e mai portati a termine, dal registro del Ministero delle Infrastrutture e dei Trasporti. L'anno di riferimento della graduatoria che stiamo mostrando è indicato qui accanto.",
    dataYearBadgePrefix: 'Anno di riferimento',
    dataYearBadgeFallback: 'Ultima graduatoria MIT',
    kpis: {
      totalCountTitle: 'Opere incompiute censite',
      totalCountFinding:
        'Lavori pubblici iniziati e mai portati a termine presenti nel registro nazionale.',
      totalInterventoTitle: 'Valore complessivo degli interventi',
      totalInterventoFinding:
        'Importo totale degli interventi censiti, aggiornato agli ultimi quadri economici.',
      totalOneriTitle: 'Costo stimato per il completamento',
      totalOneriFinding:
        'Somma degli oneri ancora necessari per ultimare i lavori, secondo le stime delle stazioni appaltanti.',
      avgAvanzamentoTitle: 'Avanzamento medio dei lavori',
      avgAvanzamentoFinding:
        "Percentuale media di completamento sul totale dei lavori, al momento dell'ultima rilevazione.",
    },
    regionalChart: {
      title: 'Opere incompiute per regione',
      subtitle:
        'Numero di opere incompiute registrate per ogni regione. Clicca una barra per filtrare la tabella qui sotto per quella regione.',
      // Same disclosure as the appalti regional chart: rows the source file
      // leaves without a region are absent from the bars, so without this the
      // bars quietly sum to less than the "opere censite" KPI.
      excludedNote: (n: number) =>
        n === 1
          ? "Un'opera non riporta una regione nel file di origine e non compare nel grafico."
          : `${n.toLocaleString('it-IT')} opere non riportano una regione nel file di origine e non compaiono nel grafico.`,
    },
    table: {
      title: "Opere incompiute ordinate per valore dell'intervento",
      subtitle:
        'Le singole opere, dalle più costose alle meno costose. Filtra per regione tramite il grafico sopra oppure con il pulsante "Tutte le regioni".',
      columns: {
        titolo: 'Opera',
        stazioneAppaltante: 'Stazione appaltante',
        provincia: 'Provincia',
        regione: 'Regione',
        importoIntervento: 'Valore intervento',
        importoOneri: 'Per finire',
        percAvanzamento: 'Avanzamento',
      },
      previous: 'Precedente',
      next: 'Successiva',
      pageLabel: 'Pagina',
      of: 'di',
      clearFilter: 'Tutte le regioni',
      filteredBy: 'Filtro attivo:',
      regionFilterLabel: 'Filtra per regione',
      allRegions: 'Tutte le regioni',
    },
    source: 'Fonte: Ministero delle Infrastrutture e dei Trasporti -- Open Data',
    sourceUrl: 'https://dati.mit.gov.it/catalog/dataset/opere-incompiute',
    errorTitle: 'Non riusciamo a caricare questa sezione',
    errorBody:
      'Il servizio dati non risponde. Può succedere se il backend sta ancora caricando il primo set di dati oppure se la rete è momentaneamente instabile.',
    retry: 'Riprova',
  },

  spesaPubblica: {
    // Every claim about the data's coverage (year, month, number of missions)
    // is a function of the resolved snapshot, never a literal. Production once
    // showed a January-February 2026 cumulative under the fixed caption
    // "nel 2025 ... tutte le 34 missioni"; the copy has to follow the data.
    pageSubtitle:
      'Dove vanno i soldi dello Stato. Pagamenti del Bilancio dello Stato ripartiti per le missioni funzionali in cui è organizzata la spesa pubblica italiana. Dati ufficiali della Ragioneria Generale dello Stato.',
    dataYearBadgeFallback: 'Ultimo aggiornamento BDAP',
    ytdBadge: (anno: number, mese: string) => `${anno}: dati fino a ${mese}`,
    kpis: {
      totalePagatoTitle: 'Pagamenti totali dello Stato',
      totalePagatoFinding: (anno: number | null, missioni: number) =>
        anno == null
          ? 'Somma complessiva dei pagamenti del Bilancio dello Stato nell’ultimo anno disponibile.'
          : `Somma complessiva dei pagamenti del Bilancio dello Stato nell’intero ${anno}, per tutte le ${missioni} missioni funzionali.`,
      progressivoTitle: 'Pagamenti dell’anno in corso',
      progressivoFinding: (anno: number | null, mese: string | null) =>
        anno == null || mese == null
          ? 'Cumulato dell’anno in corso non ancora pubblicato da BDAP.'
          : `Cumulato da gennaio a ${mese} ${anno}. Non confrontabile con un anno intero: l’anno non è concluso.`,
      topMissioneTitle: 'La missione che costa di più',
      topMissioneFinding:
        'La voce di spesa più pesante del Bilancio dello Stato, con la sua quota sul totale.',
      totalCountTitle: 'Missioni di spesa',
      totalCountFinding:
        'Le grandi categorie funzionali in cui il Bilancio dello Stato suddivide la spesa pubblica.',
      averageTitle: 'Spesa media per missione',
      averageFinding: 'Pagamento medio per ciascuna delle missioni del Bilancio dello Stato.',
    },
    missioniChart: {
      title: (anno: number | null) =>
        anno == null
          ? 'Pagamenti del Bilancio dello Stato per missione'
          : `Pagamenti del Bilancio dello Stato per missione, ${anno}`,
      subtitle: (missioni: number) =>
        `Le ${missioni} missioni funzionali ordinate dalla più costosa alla meno costosa. La lunghezza della barra rappresenta la quota sul totale dei pagamenti.`,
    },
    table: {
      title: 'Tutte le missioni di spesa',
      subtitle: (anno: number | null) =>
        anno == null
          ? 'Il dettaglio completo dei pagamenti per ciascuna missione del Bilancio dello Stato.'
          : `Il dettaglio completo dei pagamenti per ciascuna missione del Bilancio dello Stato, cumulativo a fine ${anno}.`,
      columns: {
        codice: 'Codice',
        missione: 'Missione',
        totalePagato: 'Totale pagato',
        quota: 'Quota',
      },
      previous: 'Precedente',
      next: 'Successiva',
      pageLabel: 'Pagina',
      of: 'di',
    },
    source: 'Fonte: BDAP -- Ragioneria Generale dello Stato, Bilancio dello Stato',
    sourceUrl:
      'https://bdap-opendata.rgs.mef.gov.it/catalog?q=Pagamenti+Bilancio+dello+Stato+per+Missione',
    errorTitle: 'Non riusciamo a caricare questa sezione',
    errorBody:
      'Il servizio dati non risponde. Può succedere se il backend sta ancora caricando il primo set di dati oppure se la rete è momentaneamente instabile.',
    retry: 'Riprova',
  },

  fondiEuropei: {
    pageSubtitle:
      "Fondi di coesione europei e nazionali ripartiti per regione, tema e anno. Dati ufficiali di OpenCoesione, cumulativi su tutti i cicli di programmazione dal 2000 a oggi. Comprende Fondi Strutturali, Fondo di Sviluppo e Coesione (FSC) e Piano di Azione per la Coesione (PAC).",
    dataBadgePrefix: 'Aggiornato al',
    dataBadgeFallback: 'Dati OpenCoesione',
    kpis: {
      costoPubblicoTitle: 'Valore complessivo monitorato',
      costoPubblicoFinding:
        "Costo pubblico complessivo di tutti i progetti di coesione monitorati dalla politica di coesione europea e nazionale, cumulativo dal 2000.",
      pagamentiTitle: 'Risorse già erogate',
      pagamentiFinding:
        'Pagamenti effettivamente erogati ai beneficiari fino alla data di aggiornamento.',
      quotaTitle: 'Quota effettivamente spesa',
      quotaFinding:
        'Rapporto tra pagamenti e costo complessivo monitorato. Il resto è ancora da erogare o è stato impegnato ma non ancora liquidato.',
      progettiTitle: 'Progetti censiti',
      progettiFinding:
        'Numero totale di progetti monitorati dal sistema OpenCoesione su tutti i cicli di programmazione.',
    },
    temiChart: {
      title: 'Fondi coesione per tema',
      subtitle:
        'Gli undici grandi temi strategici della politica di coesione europea, ordinati dal valore monitorato più alto al più basso.',
    },
    regioniChart: {
      title: 'Fondi coesione per regione',
      subtitle:
        "Le venti regioni italiane ordinate per valore complessivo dei progetti di coesione. Nota: i progetti multi-regionali sono contabilizzati in ciascuna regione coinvolta, quindi la somma di queste barre può essere superiore al totale nazionale.",
    },
    // The OpenCoesione series is CUMULATIVE: every value is the total reached
    // by the end of that year, not that year's flow. It is strictly monotone
    // increasing, and summing the 37 points gives 1.822 miliardi against a
    // real total of 199. The old copy ("anno per anno", "per ciascun anno")
    // invited exactly the wrong reading -- that 185 miliardi were paid out in
    // 2026 alone, when the 2026 increment is about 0,7 miliardi.
    yearlyChart: {
      title: 'Impegni e pagamenti, totale cumulato',
      subtitle:
        'Quanto si è accumulato anno dopo anno: ogni punto è il totale raggiunto a quella data, non la somma di quel singolo anno. La distanza fra le due curve è la quota impegnata ma non ancora erogata.',
      impegniLabel: 'Impegni cumulati',
      pagamentiLabel: 'Pagamenti cumulati',
    },
    statiChart: {
      title: "Stato di avanzamento dei progetti",
      subtitle:
        "Quanti dei progetti censiti sono stati effettivamente completati, quanti sono ancora in corso e quanti non sono mai stati avviati.",
    },
    regioniTable: {
      title: 'Tutte le regioni',
      columns: {
        nome: 'Regione',
        costoPubblico: 'Valore monitorato',
        pagamenti: 'Già erogato',
        quota: 'Quota erogata',
        progetti: 'Progetti',
      },
    },
    source: 'Fonte: OpenCoesione -- Dipartimento per le politiche di coesione',
    sourceUrl: 'https://opencoesione.gov.it/it/opendata/',
    errorTitle: 'Non riusciamo a caricare questa sezione',
    errorBody:
      'Il servizio dati non risponde. Può succedere se il backend sta ancora caricando il primo set di dati oppure se la rete è momentaneamente instabile.',
    retry: 'Riprova',
  },

  leTueTasse: {
    pageSubtitle:
      'Inserisci quanto guadagni e vedi come si scompone fra contributi, imposte e netto che ti resta. Puoi adattare la stima al tuo regime, alla tua regione e alla tua situazione familiare. La parte di imposte che finisce nelle casse dello Stato viene poi ripartita secondo le quote reali del Bilancio dello Stato, per mostrarti dove vanno davvero i tuoi soldi.',
    // Derived from TAX_YEAR, not restated. The constant existed and was
    // exported but nothing used it, so the tax year lived as a literal in two
    // separate strings -- the same "a fact about the data written by hand in
    // the copy" defect that put a February figure under a full-year caption on
    // the spesa page.
    dataBadge: (anno: number) => `Stima orientativa ${anno}`,
    input: {
      label: 'Stipendio lordo annuo (in euro)',
      labelPensione: 'Pensione lorda annua (in euro)',
      labelForfettario: 'Ricavi o compensi annui (in euro)',
      hint: 'Prova con diversi valori per vedere come cambia la suddivisione.',
      hintForfettario:
        'Il fatturato annuo, non il guadagno: il regime forfettario tassa solo la quota di ricavi stabilita dal coefficiente di redditività.',
      oltreLimiteForfettario: (limite: number) =>
        `Sopra ${limite.toLocaleString('it-IT')} euro di ricavi il regime forfettario non è applicabile: oltre quella soglia si esce dal regime e si torna alla tassazione ordinaria IRPEF. Il calcolo qui sotto non è valido per questo importo.`,
    },
    opzioni: {
      title: 'Personalizza la stima',
      subtitle:
        'Più dettagli inserisci, più il risultato si avvicina alla tua busta paga reale. Ogni valore ha un default nazionale, quindi puoi anche lasciare tutto com’è.',
      regime: 'Regime fiscale',
      regimi: {
        dipendente: 'Lavoratore dipendente',
        pensionato: 'Pensionato',
        forfettario: 'Partita IVA in regime forfettario',
      },
      regione: 'Regione di residenza',
      regioneHint: 'Determina l’addizionale regionale, che varia molto da regione a regione.',
      mediaNazionale: 'Media nazionale',
      comunale: 'Addizionale comunale (%)',
      comunaleHint:
        // 0,8% is the general ceiling (art. 1 c. 3 D.Lgs. 360/1998); the 0,9%
        // is specific to Roma Capitale, not to capoluoghi in general.
        'Se non la conosci lascia la media nazionale dello 0,6%. Il massimo di legge è 0,8%, tranne Roma Capitale che può arrivare allo 0,9%.',
      mensilita: 'Mensilità',
      mensilitaHint: 'Serve solo a dividere il netto annuo nelle rate che ricevi.',
      coniuge: 'Coniuge a carico',
      coniugeHint: 'Coniuge non separato con reddito proprio fino a 2.840,51 euro.',
      figli: 'Figli a carico (21-30 anni)',
      figliHint:
        'Sotto i 21 anni il sostegno passa dall’Assegno Unico e non dall’IRPEF, quindi non produce detrazione.',
      coefficiente: 'Coefficiente di redditività',
      coefficienti: {
        '0.4': 'Commercio, alimentari, alloggio e ristorazione (40%)',
        '0.54': 'Commercio ambulante di prodotti non alimentari (54%)',
        '0.62': 'Intermediari del commercio (62%)',
        '0.67': 'Altre attività economiche (67%)',
        '0.78': 'Attività professionali, scientifiche, sanitarie, istruzione (78%)',
        '0.86': 'Costruzioni e attività immobiliari (86%)',
      },
      cassa: 'Cassa previdenziale',
      casse: {
        'gestione-separata': 'Gestione Separata INPS (26,07%)',
        artigiani: 'Artigiani',
        commercianti: 'Commercianti',
      },
      startup: 'Nuova attività (imposta al 5%)',
      startupHint: 'Aliquota ridotta per i primi cinque anni di attività.',
      riduzione: 'Riduzione contributiva del 35%',
      riduzioneHint: 'Opzione riservata ad artigiani e commercianti in regime forfettario.',
    },
    kpis: {
      nettoTitle: 'Netto annuo',
      nettoFinding: 'Quanto ti resta effettivamente dopo contributi e imposte.',
      nettoMensileTitle: 'Netto al mese',
      nettoMensileFinding: 'Il netto annuo diviso per le mensilità che ricevi.',
      nettoMensileTitleForfettario: 'Media mensile',
      nettoMensileFindingForfettario:
        'Il netto annuo diviso per dodici. Il reddito da partita IVA non arriva in mensilità fisse.',
      trattenuteTitle: 'Totale trattenute',
      trattenuteFinding: 'Somma di contributi previdenziali e imposte, al netto dei bonus.',
      aliquotaTitle: 'Aliquota effettiva',
      aliquotaFinding: 'Percentuale del lordo che non entra nel tuo conto.',
    },
    donut: {
      title: 'Come si scompone il tuo lordo',
      subtitle:
        'Le parti in cui viene ripartito il lordo annuo: il netto che ricevi e le trattenute che finanziano previdenza, imposte sui redditi, sanità e servizi locali.',
      slices: {
        inps: 'Contributi',
        irpef: 'Imposte sul reddito',
        addizionali: 'Addizionali',
        netto: 'Netto',
      },
      notaCredito:
        'Il grafico ripartisce il lordo, mentre i bonus arrivano in aggiunta ad esso: per questo il netto che ricevi davvero è più alto della fetta indicata qui.',
    },
    dettaglio: {
      title: 'Il dettaglio del calcolo',
      subtitle:
        'Le voci che compongono il risultato. Le detrazioni e i bonus riducono l’imposta dovuta: senza di essi pagheresti molto di più.',
      impostaLorda: 'Imposta lorda sugli scaglioni',
      detrazioneRegime: 'Detrazione da lavoro dipendente',
      detrazioneRegimePensione: 'Detrazione da pensione',
      ulterioreDetrazione: 'Ulteriore detrazione (20.000-40.000 euro)',
      detrazioneConiuge: 'Detrazione per coniuge a carico',
      detrazioneFigli: 'Detrazione per figli a carico',
      impostaNetta: 'Imposta netta dovuta',
      addizionaleRegionale: 'Addizionale regionale',
      addizionaleComunale: 'Addizionale comunale',
      bonusCuneo: 'Bonus taglio del cuneo fiscale',
      trattamentoIntegrativo: 'Trattamento integrativo',
      impostaSostitutiva: 'Imposta sostitutiva',
      contributi: 'Contributi previdenziali',
      totale: 'Totale imposte sul reddito',
      creditoNetto:
        'A questo livello di reddito i bonus superano l’imposta dovuta: dallo Stato ricevi più di quanto versi in imposte sui redditi.',
      fonteRegione: 'Fonte aliquota regionale',
    },
    missioni: {
      shareOfBudget: 'del totale del Bilancio dello Stato',
      title: 'Dove finisce la tua quota di imposte',
      // The reference year comes from the resolved BDAP snapshot, not from a
      // literal: this caption said "pagamenti 2025" while the shares behind it
      // were computed on a January-February 2026 snapshot.
      subtitle: (anno: number | null) =>
        anno == null
          ? 'Queste sono le dieci missioni del Bilancio dello Stato che assorbono la quota maggiore di spesa pubblica. La barra rappresenta quanti euro della tua IRPEF e delle addizionali finanziano notionalmente ciascuna missione, calcolato sulle quote reali dei pagamenti della Ragioneria Generale dello Stato.'
          : `Queste sono le dieci missioni del Bilancio dello Stato che assorbono la quota maggiore di spesa pubblica. La barra rappresenta quanti euro della tua IRPEF e delle addizionali finanziano notionalmente ciascuna missione, calcolato sulle quote reali dei pagamenti ${anno} della Ragioneria Generale dello Stato.`,
      topMissioniPreamble: 'La tua quota di imposte sui redditi quest\'anno:',
      columns: {
        missione: 'Missione',
        quota: 'Quota',
        euro: 'Euro sulle tue tasse',
      },
    },
    assunzioni: {
      title: 'Assunzioni e limitazioni',
      // `anno` interpolates the tax year the calculator implements. Note that
      // "legge di bilancio 2026" stays literal on purpose: it names the law
      // that introduced the 33% bracket, which stays true in later tax years.
      items: (anno: number) => [
        `Il calcolo applica le regole in vigore per l’anno d’imposta ${anno}, inclusa la riduzione al 33% dell’aliquota del secondo scaglione IRPEF introdotta dalla legge di bilancio 2026.`,
        'Per il lavoratore dipendente si assume un contratto a tempo indeterminato per l’intero anno, con aliquota contributiva INPS standard del 9,19%. Non sono considerati premi di produttività, fringe benefit, TFR in busta e altri elementi variabili.',
        'Le aliquote dell’addizionale regionale sono quelle depositate dalle Regioni presso il Dipartimento delle Finanze del MEF. Ogni regione riporta la fonte da cui è tratta.',
        'Alcune regioni prevedono detrazioni per figli a carico con requisiti diversi fra loro (figli minorenni, figli oltre il secondo, limiti di reddito): non vengono applicate, ma sono segnalate quando esistono.',
        'L’addizionale comunale è impostata sulla media nazionale dello 0,6%: se conosci l’aliquota del tuo comune, inseriscila per una stima più precisa.',
        'Le detrazioni per familiari a carico coprono coniuge e figli fra i 21 e i 30 anni. Per i figli sotto i 21 anni il sostegno passa dall’Assegno Unico Universale, che non è una detrazione IRPEF.',
        'La ripartizione delle tue imposte sui redditi fra le missioni del Bilancio è notionale: nella realtà il Bilancio dello Stato è finanziato da più fonti (IRPEF, IVA, IRES, accise, debito pubblico), non solo dalle imposte sui redditi.',
        'Nella ripartizione sono incluse anche le addizionali regionale e comunale, che in realtà finanziano Regioni e Comuni e non il Bilancio dello Stato: sono conteggiate per mostrare l’intero prelievo sul reddito, non perché alimentino quelle missioni.',
        'Per il regime forfettario non sono considerate le riduzioni contributive per i nuovi iscritti alle gestioni artigiani e commercianti, né i massimali di reddito differenziati per chi risulta iscritto prima del 1996.',
        'I contributi previdenziali alimentano il sistema pensionistico e non sono inclusi nella ripartizione fra le missioni.',
        'Non si sostituisce al calcolo ufficiale del tuo datore di lavoro, del tuo commercialista o del 730.',
      ],
    },
    sourceMissione: 'Fonte ripartizione: BDAP -- Pagamenti Bilancio dello Stato per Missione',
    sourceMissioneUrl:
      'https://bdap-opendata.rgs.mef.gov.it/catalog?q=Pagamenti+Bilancio+dello+Stato+per+Missione',
    errorTitle: 'Non riusciamo a caricare la ripartizione della spesa',
    errorBody: 'Puoi comunque vedere la suddivisione del tuo stipendio qui sopra.',
  },

  appalti: {
    chartSeriesLabel: 'Stazioni',
    abitantiUnit: 'cittadini',
    pageSubtitle:
      "Chi compra con i soldi pubblici in Italia. Il registro ANAC delle stazioni appaltanti conta decine di migliaia di enti che gestiscono autonomamente gli acquisti della pubblica amministrazione. Questa pagina mostra quanto il sistema degli appalti pubblici italiani sia frammentato e come si distribuisce sul territorio.",
    dataBadge: 'Registro ANAC aggiornato',
    kpis: {
      attiveTitle: 'Stazioni appaltanti attive',
      attiveFinding:
        'Enti e amministrazioni attualmente iscritte al registro ANAC come stazioni appaltanti, abilitate a bandire gare e stipulare contratti pubblici.',
      abitantiTitle: 'Una stazione ogni',
      abitantiFinding:
        "Numero medio di abitanti per ciascuna stazione appaltante italiana. Un valore basso indica un sistema di procurement particolarmente frammentato.",
      categorieTitle: 'Categorie giuridiche diverse',
      categorieFinding:
        'Forme giuridiche distinte tra gli enti che fanno acquisti pubblici: scuole, comuni, società partecipate, consorzi, ASL, università e molte altre.',
      regioniTitle: 'Regioni coperte',
      regioniFinding: 'Tutte le regioni italiane hanno almeno una stazione appaltante attiva.',
    },
    naturaChart: {
      title: 'Stazioni appaltanti per natura giuridica',
      // Nine, not ten: the route keeps TOP_K = 9 and adds the tail bucket as a
      // tenth bar. Claiming ten categories plus a tail counted one twice.
      subtitle:
        "Le nove categorie giuridiche più numerose tra gli enti che gestiscono gli appalti pubblici. La voce 'Altre categorie' raccoglie la lunga coda di classificazioni meno frequenti.",
      // ANAC leaves the legal form empty on some active stations. They are not
      // in any bar and not in the tail bucket either, so without this note the
      // bars quietly sum to less than the "stazioni attive" KPI.
      excludedNote: (n: number) =>
        `${n.toLocaleString('it-IT')} stazioni attive non riportano alcuna natura giuridica e non compaiono nel grafico.`,
    },
    regionalChart: {
      title: 'Stazioni appaltanti per regione',
      subtitle:
        'Distribuzione territoriale delle stazioni appaltanti attive, per regione di appartenenza della sede legale.',
      // Roughly 4% of active stations carry a province code ANAC does not map
      // to a region; they are absent from the bars, so the total here is lower
      // than the "stazioni attive" KPI. Saying so is cheaper than letting the
      // reader discover the two numbers disagree.
      excludedNote: (n: number) =>
        `${n.toLocaleString('it-IT')} stazioni attive non riportano una provincia riconducibile a una regione e non compaiono nel grafico.`,
    },
    cittaTable: {
      title: 'Top città italiane per numero di stazioni appaltanti',
      subtitle:
        "Le prime venti città italiane ordinate per numero di stazioni appaltanti con sede legale nel comune. Roma, Milano e i capoluoghi concentrano naturalmente la quota più grande.",
      columns: {
        rank: '#',
        citta: 'Città',
        provincia: 'Provincia',
        regione: 'Regione',
        count: 'Stazioni',
      },
    },
    source: 'Fonte: ANAC -- Autorità Nazionale Anticorruzione',
    sourceUrl: 'https://dati.anticorruzione.it/opendata/dataset/stazioni-appaltanti',
    errorTitle: 'Non riusciamo a caricare questa sezione',
    errorBody:
      'Il servizio dati non risponde. Può succedere se il backend sta ancora caricando il primo set di dati oppure se la rete è momentaneamente instabile.',
    retry: 'Riprova',
  },

  parlamento: {
    pageSubtitle:
      // "quasi trent'anni" undersold it: the archive runs 1996-05-09 to
      // 2026-08-07, i.e. thirty years and change.
      'Le sedute di Camera e Senato dalla XIII legislatura a oggi, giorno per giorno: oltre trent’anni di lavori parlamentari. Le trascrizioni ufficiali con i loro ordini del giorno e gli interventi dei parlamentari, ricercabili a parola libera. I dati arrivano dai portali ufficiali dei due rami del Parlamento italiano.',
    cameraLabel: 'Camera dei Deputati',
    senatoLabel: 'Senato della Repubblica',
    chamberAll: 'Entrambe le camere',
    searchPlaceholder: 'Cerca un argomento, una parola, un nome (almeno 2 caratteri)',
    searchSubmit: 'Cerca',
    searchEmpty: 'Nessun intervento trovato per questa ricerca.',
    searchHint:
      'Cerca per parola libera nelle trascrizioni di tutte le sedute. I risultati sono ordinati per rilevanza.',
    searchOpenSeduta: 'Apri questo intervento nella seduta',
    searchResultCount: 'risultati',
    // Single source for the paginator labels, consumed by
    // components/Pagination.tsx. The per-page blocks below still carry their
    // own copies for the non-paginator copy around them.
    pagination: {
      page: 'Pagina',
      of: 'di',
      results: 'risultati',
      previous: 'Precedente',
      next: 'Successiva',
      first: 'Prima',
      last: 'Ultima',
    },
    // Landing-page quick-nav cards and the legislature context banner.
    quickNav: {
      legislatureTitle: 'Legislature in archivio',
      exploreTitle: "Esplora l'archivio",
      leggiCitate: 'Leggi più citate nei dibattiti →',
      transfughi: 'Cambi di gruppo parlamentare →',
      odgSearch: 'Cerca negli ordini del giorno →',
      commissioni: 'Lavori delle commissioni →',
      legislatureOverview: 'Vedi panoramica legislatura →',
      removeLegFilter: '× Rimuovi filtro legislatura',
      legShort: (n: number) => `${n}ª leg.`,
    },
    invalidPage: 'Pagina non valida',
    sourcePrefix: 'Fonte',
    recentTitle: 'Ultime sedute',
    recentSubtitle:
      'Le sedute più recenti di Camera e Senato. Apri una seduta per leggere la trascrizione integrale con i suoi ordini del giorno e i parlamentari intervenuti.',
    calendarTitle: 'Sedute mese per mese',
    calendarSubtitle:
      'Distribuzione delle sedute nel tempo, per ciascuna delle due camere.',
    seduteList: {
      backLabel: '← Parlamento',
      empty:
        // Operator hint, shown only on an empty archive. The container it named
        // (fixitalia-dev) stopped existing when the project moved to the
        // collapsed-workspace topology.
        "Nessuna seduta importata ancora. Per popolare l'archivio: dev exec backend npx tsx scripts/ingest.ts parlamento",
      open: 'Apri',
      seduta: 'Seduta',
      odgCount: 'OdG',
      interventiCount: 'interventi',
      previous: 'Precedente',
      next: 'Successiva',
      first: 'Prima',
      last: 'Ultima',
      pageLabel: 'Pagina',
      of: 'di',
    },
    filters: {
      title: 'Filtri',
      chamberLegend: 'Filtra per ramo del Parlamento',
      sortLabel: 'Ordina le sedute',
      sortNewest: 'Più recenti',
      sortOldest: 'Cronologico',
      yearLegend: 'Filtra per anno',
      yearAll: 'Tutti gli anni',
      reset: 'Azzera filtri',
      activeFilters: 'Filtri attivi',
    },
    seduta: {
      back: 'Tutte le sedute',
      legislaturaLink: (n: number) => `${n}ª Legislatura`,
      indexTitle: 'Indice della seduta',
      tabOdg: 'Ordini del giorno',
      tabOratori: 'Parlamentari intervenuti',
      copyLink: 'Copia link',
      linkCopied: 'Link copiato',
      readerSettings: 'Impostazioni di lettura',
      videoEmbedTitle: 'Video integrale della seduta',
      videoOpen: 'Guarda la diretta ufficiale',
      sourceOfficial: 'Resoconto ufficiale di questa seduta',
      videoNotAvailable: 'Video non disponibile per questa seduta.',
      empty:
        'Nessuna trascrizione disponibile per questa seduta. La sessione potrebbe non essere ancora stata pubblicata o presentare problemi di parsing.',
    },
    commissioni: {
      navTitle: 'Commissioni',
      title: 'Commissioni parlamentari',
      subtitle:
        'I lavori delle commissioni: audizioni, indagini conoscitive e sedute in sede referente. È qui che passano le persone convocate dal Parlamento -- dirigenti pubblici, imprese, sindacati, tecnici -- e le loro parole valgono quanto quelle dette in Aula.',
      // No leading arrow: the link renders an ArrowLeft icon beside it.
      backLabel: 'Parlamento',
      backToCommissioni: 'Tutte le commissioni',
      backToSedute: 'Tutte le sedute della commissione',
      empty: 'Nessuna commissione importata ancora.',
      emptySedute: 'Nessuna seduta importata per questa commissione.',
      seduteCount: 'sedute',
      interventiCount: 'interventi',
      periodLabel: 'Periodo',
      open: 'Apri',
      // Committee sittings are numbered per-committee, so the number alone
      // does not identify a sitting the way it does for the Aula.
      sedutaLabel: 'Resoconto',
      tipologia: {
        indag: 'Indagine conoscitiva',
        audiz2: 'Audizione',
        audizione: 'Audizione',
        altro: 'Seduta',
      },
      // The single most important label in this section. A Senato committee
      // "resoconto sommario" paraphrases speakers in the third person; showing
      // it without saying so would present the secretariat's words as quotes.
      sommarioBadge: 'Resoconto sommario',
      sommarioNotice:
        'Questo è un resoconto sommario: il testo riassume gli interventi in terza persona, redatto dagli uffici del Senato. Non è una trascrizione parola per parola e non va citato come tale.',
      stenograficoBadge: 'Resoconto stenografico',
      chamberFilterLegend: 'Filtra per ramo del Parlamento',
      searchScopeLegend: 'Dove cercare',
      searchScopeAula: 'Aula',
      searchScopeCommissioni: 'Commissioni',
      searchScopeAll: 'Aula e commissioni',
      filterPlaceholder: 'Filtra le commissioni per nome',
      filterNoMatch: 'Nessuna commissione corrisponde al filtro.',
      showing: (shown: number, total: number) =>
        shown === total ? `${total} commissioni` : `${shown} di ${total} commissioni`,
      legAll: 'Tutte le legislature',
      legLabel: (n: number) => `${n}ª legislatura`,
      searchInside: 'Cerca in questa commissione',
      searchInsidePlaceholder: 'Cerca nelle trascrizioni di questa commissione',
      sedutaFilterPlaceholder: 'Filtra le sedute per titolo',
      sedutaNoMatch: 'Nessuna seduta corrisponde al filtro.',
      openInSearch: 'Vedi tutti i risultati',
      backToCommissione: 'Torna alla commissione',
      notIngested: 'non ancora importate',
      categoryOther: 'Altri organi',
    },
    reader: {
      fontLabel: 'Carattere',
      sizeLabel: 'Dimensione',
      lineLabel: 'Interlinea',
      fontSerif: 'Con grazie',
      fontSans: 'Lineare',
      fontMono: 'Monospaziato',
      prefsHint:
        'Le tue scelte vengono ricordate localmente per le prossime sedute.',
    },
    persona: {
      back: 'Indietro',
      recentTitle: 'Interventi in archivio',
      noInterventi: 'Nessun intervento trovato per questo parlamentare.',
      noInterventiFiltered:
        'Nessun intervento corrisponde ai filtri impostati. Prova a rimuoverli o a cambiare la ricerca.',
      searchUnavailable:
        'La ricerca a parola libera non è al momento disponibile (indice BM25 in ricostruzione). Puoi comunque filtrare per data.',
      officialSite: 'Scheda ufficiale',
      interventoIn: 'Seduta',
      openInSeduta: 'Apri nella seduta',
      filterByGroup: 'Filtra per gruppo',
      allGroups: 'Tutti i gruppi',
      interventiInArchive: 'interventi indicizzati',
      notFoundTitle: 'Parlamentare non trovato',
      notFoundBody:
        'Non risulta nessun parlamentare con questo identificativo nel nostro archivio. Potrebbe essere un errore di link o un dato non ancora ingerito.',
      loadErrorTitle: 'Errore di caricamento',
      loadErrorBody:
        'Non siamo riusciti a contattare il server. La connessione potrebbe essere temporaneamente interrotta o il backend potrebbe essersi appena riavviato. Riprova fra qualche secondo.',
      retry: 'Riprova',
      // Career / mandati section
      careerTitle: 'Carriera parlamentare',
      legislatureLabel: 'Legislatura',
      mandatoCount: (n: number) =>
        n === 1 ? 'Un mandato' : `${n.toLocaleString('it-IT')} mandati`,
      birthDate: 'Data di nascita',
      birthPlace: 'Luogo di nascita',
      district: 'Circoscrizione',
      collegio: 'Collegio',
      electionList: 'Lista di elezione',
      proclamation: 'Proclamazione',
      formation: 'Formazione',
      currentGroup: 'Gruppo parlamentare',
      groupHistory: 'Storia gruppi',
      offices: 'Uffici parlamentari',
      organs: 'Componente di',
      from: 'dal',
      until: 'al',
      // Interventi search/filter
      searchPlaceholder: 'Cerca negli interventi (almeno 2 caratteri)',
      searchSubmit: 'Cerca',
      clearFilters: 'Azzera',
      dateFrom: 'Dal',
      dateTo: 'Al',
      legFilterLabel: 'Legislatura:',
      legFilterAll: 'Tutte',
      resultsCount: 'risultati',
      page: 'Pagina',
      of: 'di',
      previous: 'Precedente',
      next: 'Successiva',
    },
    careerTimeline: {
      label: 'Legislature in archivio',
      legLabel: (n: number) => `${n}ª leg.`,
      clickToFilter: 'Filtra gli interventi per questa legislatura',
      clearLegFilter: 'Mostra tutte le legislature',
    },
    transfughi: {
      pageTitle: 'Cambi di gruppo nella legislatura',
      pageSubtitle:
        'Parlamentari che hanno cambiato gruppo parlamentare nel corso della legislatura. La storia dei gruppi viene registrata per la Camera a partire dalla XIX legislatura.',
      filterLeg: 'Legislatura',
      filterChamber: 'Ramo',
      colNome: 'Parlamentare',
      colDa: 'Da',
      colA: 'A',
      colData: 'Data',
      colInterventi: 'Interventi',
      noData: 'Nessun cambio di gruppo registrato per questa legislatura e questo ramo.',
      noDataHint: 'La storia dei gruppi è disponibile principalmente per la Camera nella XIX legislatura.',
      nSwitches: (n: number) =>
        n === 1 ? '1 cambio di gruppo' : `${n.toLocaleString('it-IT')} cambi di gruppo`,
      groupFrom: 'Dal gruppo',
      groupTo: 'Al gruppo',
      on: 'il',
    },
    odgSearch: {
      pageTitle: 'Cerca negli ordini del giorno',
      pageSubtitle:
        'Ricerca nei titoli degli ordini del giorno delle sedute di Camera e Senato. Ogni risultato è collegato alla seduta corrispondente.',
      placeholder: 'Es. riforma pensioni, immigrazione, bilancio…',
      submit: 'Cerca',
      filterLeg: 'Legislatura',
      filterLegAll: 'Tutte',
      filterChamber: 'Ramo',
      filterChamberAll: 'Entrambi',
      colTitolo: 'Ordine del giorno',
      colSeduta: 'Seduta',
      empty: 'Nessun ordine del giorno trovato per questa ricerca.',
      openInSeduta: 'Apri',
      previous: 'Precedente',
      next: 'Successiva',
      page: 'Pagina',
      of: 'di',
      total: (n: number) => `${n.toLocaleString('it-IT')} risultati`,
    },
    speakerSearch: {
      label: 'Cerca un parlamentare per nome',
      placeholder: 'Es. Moro, Berlinguer, Almirante…',
      noResults: 'Nessun parlamentare trovato.',
      legLabel: (legs: number[]) =>
        legs.length === 0
          ? ''
          : legs.length === 1
            ? `Leg. ${legs[0]}`
            : `Leg. ${legs[legs.length - 1]}–${legs[0]}`,
      interventiLabel: (n: number) => `${n.toLocaleString('it-IT')} interventi`,
    },
    leggiCitate: {
      pageTitle: 'Leggi più citate nei dibattiti',
      pageSubtitle:
        'Le leggi, i decreti e gli atti parlamentari citati più spesso nelle trascrizioni stenografiche di Camera e Senato. Clicca su una riga per vedere tutti gli interventi che citano quella norma.',
      filterLeg: 'Legislatura',
      filterLegAll: 'Tutte',
      filterChamber: 'Camera',
      filterChamberAll: 'Entrambe',
      colNorma: 'Norma',
      colCitazioni: 'Citazioni nei dibattiti',
      empty: 'Nessuna citazione trovata. Le citazioni vengono estratte automaticamente durante l\'importazione dei resoconti stenografici.',
      viewCitations: 'Vedi tutti gli interventi',
    },
    legge: {
      interventoSingular: 'intervento',
      interventoPlural: 'interventi',
      backToLeaderboard: '← Leggi più citate',
      citedBy: (n: number) =>
        n === 1 ? '1 intervento cita questa norma' : `${n.toLocaleString('it-IT')} interventi citano questa norma`,
      filterChamber: 'Filtra per ramo',
      filterLeg: 'Legislatura',
      filterAll: 'Tutti',
      colData: 'Data seduta',
      colOrator: 'Oratore',
      colGruppo: 'Gruppo',
      colSeduta: 'Seduta',
      openInSeduta: 'Apri',
      empty: 'Nessun intervento trovato per questa norma con i filtri selezionati.',
      notFound: 'Norma non trovata nell\'archivio.',
      previous: 'Precedente',
      next: 'Successiva',
      page: 'Pagina',
      of: 'di',
    },
    legislatura: {
      title: (n: number) => `${n}ª Legislatura`,
      backToSedute: '← Tutte le sedute',
      cameraLabel: 'Camera dei Deputati',
      senatoLabel: 'Senato della Repubblica',
      seduteStat: (n: number) => `${n.toLocaleString('it-IT')} sedute`,
      dateRange: (from: string, to: string) => `${from} – ${to}`,
      topSpeakersTitle: 'Più attivi nei dibattiti',
      topSpeakersSubtitle: 'Parlamentari con il maggior numero di interventi indicizzati in questa legislatura.',
      topLawsTitle: 'Leggi più citate',
      topLawsSubtitle: 'Le norme citate più spesso nei resoconti stenografici di questa legislatura.',
      interventiLabel: (n: number) => `${n.toLocaleString('it-IT')} interventi`,
      citazioniLabel: (n: number) => `${n.toLocaleString('it-IT')} cit.`,
      noSpeakers: 'Nessun dato disponibile.',
      noLaws: 'Nessuna citazione disponibile per questa legislatura.',
      notFound: 'Legislatura non trovata nell\'archivio.',
    },
    senatoUnavailable: {
      title: 'Trascrizione non disponibile in fixitalia',
      body:
        'Il sito ufficiale del Senato protegge le trascrizioni stenografiche con un challenge AWS WAF che richiede un browser reale per essere risolto. Non riusciamo a importarle in modo programmatico, e quindi non possiamo offrire qui la lettura integrale, la ricerca o l\'indice degli interventi.',
      bodyDetail:
        'I dati di metadata della seduta (data, numero, ordine del giorno minimo) restano disponibili. Per leggere la trascrizione completa, apri il visualizzatore ufficiale qui sotto.',
      openOfficial: 'Apri la trascrizione sul sito ufficiale del Senato',
      learnMore: 'Maggiori dettagli',
    },
    source: 'Fonti: Camera dei Deputati, Senato della Repubblica -- Open Data',
    sourceUrlCamera: 'https://www.camera.it/leg19/207',
    sourceUrlSenato: 'https://www.senato.it/lavori/assemblea/resoconti-elenco-cronologico',
    errorTitle: 'Non riusciamo a caricare questa sezione',
    errorBody:
      "Il servizio dati non risponde. Se non hai ancora avviato l'importazione, puoi farlo dal terminale dello sviluppatore.",
    retry: 'Riprova',
  },
} as const
