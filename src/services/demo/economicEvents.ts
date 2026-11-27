import type { EconomicCalendarEvent } from "../queries.ts";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function buildEconomicCalendar(): EconomicCalendarEvent[] {
  const events: EconomicCalendarEvent[] = [];

  // Bitcoin historic landmark milestones (2009 - 2026)
  const bitcoinLandmarkEvents: EconomicCalendarEvent[] = [
    {
      id: "btc-2009-genesis",
      time: "2009-01-03T18:15:05.000Z",
      currency: "BTC",
      impact: "high",
      event: "Bloque Génesis minado por Satoshi Nakamoto (Bloque 0)",
      actual: "50 BTC",
      forecast: "—",
      previous: "—",
      country: "Global",
    },
    {
      id: "btc-2010-pizza",
      time: "2010-05-22T18:00:00.000Z",
      currency: "BTC",
      impact: "low",
      event: "Bitcoin Pizza Day: Laszlo compra 2 pizzas por 10.000 BTC",
      actual: "$0.0041 / BTC",
      forecast: "—",
      previous: "—",
      country: "EE. UU.",
    },
    {
      id: "btc-2011-parity",
      time: "2011-02-09T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Bitcoin alcanza paridad 1:1 con el dólar estadounidense ($1,00)",
      actual: "$1.00",
      forecast: "—",
      previous: "$0.50",
      country: "EE. UU.",
    },
    {
      id: "btc-2011-bubble",
      time: "2011-06-08T14:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Primer gran pico de burbuja histórica de Bitcoin ($31,91 ATH)",
      actual: "$31.91",
      forecast: "—",
      previous: "$1.00",
      country: "Global",
    },
    {
      id: "btc-2012-halving-1",
      time: "2012-11-28T15:24:38.000Z",
      currency: "BTC",
      impact: "high",
      event: "1.er Halving de Bitcoin (Bloque 210.000: 50 -> 25 BTC)",
      actual: "25 BTC",
      forecast: "25 BTC",
      previous: "50 BTC",
      country: "Global",
    },
    {
      id: "btc-2013-100-milestone",
      time: "2013-04-01T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Bitcoin supera el hito de los $100",
      actual: "$100",
      forecast: "—",
      previous: "$13.50",
      country: "Global",
    },
    {
      id: "btc-2013-1k-milestone",
      time: "2013-11-29T18:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Bitcoin supera los $1.000 por primera vez ($1.156 ATH)",
      actual: "$1,156",
      forecast: "—",
      previous: "$100",
      country: "Global",
    },
    {
      id: "btc-2014-mtgox",
      time: "2014-02-24T09:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Hackeo y quiebra de Mt. Gox (850.000 BTC perdidos)",
      actual: "-850,000 BTC",
      forecast: "—",
      previous: "Solvente",
      country: "Japón",
    },
    {
      id: "btc-2015-bottom",
      time: "2015-01-14T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Suelo de capitulación del mercado bajista de 2015 ($170)",
      actual: "$170",
      forecast: "—",
      previous: "$1,156",
      country: "Global",
    },
    {
      id: "btc-2016-halving-2",
      time: "2016-07-09T16:46:13.000Z",
      currency: "BTC",
      impact: "high",
      event: "2.º Halving de Bitcoin (Bloque 420.000: 25 -> 12,5 BTC)",
      actual: "12.5 BTC",
      forecast: "12.5 BTC",
      previous: "25 BTC",
      country: "Global",
    },
    {
      id: "btc-2017-segwit-bch",
      time: "2017-08-01T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Hard Fork de Bitcoin Cash (BCH) y activación de SegWit",
      actual: "Fork ejecutado",
      forecast: "—",
      previous: "Unificada",
      country: "Global",
    },
    {
      id: "btc-2017-cboe-futures",
      time: "2017-12-10T23:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "CBOE lanza los primeros contratos de futuros regulados de Bitcoin",
      actual: "Cotizando",
      forecast: "—",
      previous: "No regulado",
      country: "EE. UU.",
    },
    {
      id: "btc-2017-ath",
      time: "2017-12-17T18:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Pico histórico del mercado alcista de 2017 ($19.783 ATH)",
      actual: "$19,783",
      forecast: "—",
      previous: "$1,000",
      country: "Global",
    },
    {
      id: "btc-2018-winter-bottom",
      time: "2018-12-15T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Suelo del ciclo criptoinvierno de 2018 ($3.122)",
      actual: "$3,122",
      forecast: "—",
      previous: "$19,783",
      country: "Global",
    },
    {
      id: "btc-2019-rally",
      time: "2019-06-26T21:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Pico del rally alcista de verano de 2019 ($13.880)",
      actual: "$13,880",
      forecast: "—",
      previous: "$3,122",
      country: "Global",
    },
    {
      id: "btc-2020-black-thursday",
      time: "2020-03-12T10:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Jueves Negro de Covid: Flash Crash de liquidez global ($3.850)",
      actual: "$3,850",
      forecast: "—",
      previous: "$8,000",
      country: "Global",
    },
    {
      id: "btc-2020-halving-3",
      time: "2020-05-11T19:23:43.000Z",
      currency: "BTC",
      impact: "high",
      event: "3.er Halving de Bitcoin (Bloque 630.000: 12,5 -> 6,25 BTC)",
      actual: "6.25 BTC",
      forecast: "6.25 BTC",
      previous: "12.5 BTC",
      country: "Global",
    },
    {
      id: "btc-2020-microstrategy",
      time: "2020-08-11T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "MicroStrategy adopta Bitcoin como reserva de tesorería ($250M inicial)",
      actual: "21,454 BTC",
      forecast: "—",
      previous: "Efectivo",
      country: "EE. UU.",
    },
    {
      id: "btc-2020-paypal",
      time: "2020-10-21T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "PayPal anuncia compra nativa de criptomonedas y pagos en comercios",
      actual: "Lanzado",
      forecast: "—",
      previous: "Ninguno",
      country: "EE. UU.",
    },
    {
      id: "btc-2020-20k-breakout",
      time: "2020-12-16T14:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Bitcoin supera el ATH de 2017 y rebasa los $20.000",
      actual: "$20,800",
      forecast: "—",
      previous: "$19,783",
      country: "Global",
    },
    {
      id: "btc-2021-tesla",
      time: "2021-02-08T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Tesla anuncia inversión de $1.500M en Bitcoin y cobro en BTC",
      actual: "$1.5B BTC",
      forecast: "—",
      previous: "0",
      country: "EE. UU.",
    },
    {
      id: "btc-2021-coinbase-ipo",
      time: "2021-04-14T14:30:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Salida a bolsa de Coinbase en Nasdaq ($COIN) y BTC a $64.800",
      actual: "$64,800",
      forecast: "—",
      previous: "$20,000",
      country: "EE. UU.",
    },
    {
      id: "btc-2021-china-ban",
      time: "2021-05-19T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "China prohíbe completamente la criptominería (desplome a $30.000)",
      actual: "-50% Hashrate",
      forecast: "—",
      previous: "65% Hashrate",
      country: "China",
    },
    {
      id: "btc-2021-el-salvador",
      time: "2021-09-07T06:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "El Salvador es el 1.er país en declarar Bitcoin moneda de curso legal",
      actual: "Moneda de curso legal",
      forecast: "—",
      previous: "Solo USD",
      country: "El Salvador",
    },
    {
      id: "btc-2021-bito-etf",
      time: "2021-10-19T13:30:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Lanzamiento de ProShares BITO: 1.er ETF de futuros de Bitcoin en EE. UU.",
      actual: "$1.000M Entradas",
      forecast: "—",
      previous: "0",
      country: "EE. UU.",
    },
    {
      id: "btc-2021-ath-69k",
      time: "2021-11-10T14:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Bitcoin alcanza máximo histórico del ciclo alcista ($68.789 ATH)",
      actual: "$68,789",
      forecast: "—",
      previous: "$64,800",
      country: "Global",
    },
    {
      id: "btc-2022-luna-crash",
      time: "2022-05-09T18:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Colapso de Terra/Luna y la stablecoin algorítmica UST ($40.000M borrados)",
      actual: "$0.00 UST",
      forecast: "—",
      previous: "Paridad $1,00",
      country: "Global",
    },
    {
      id: "btc-2022-ftx-collapse",
      time: "2022-11-11T14:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Quiebra y colapso de FTX y Alameda Research (BTC cae a $15.476)",
      actual: "$15,476",
      forecast: "—",
      previous: "$21,000",
      country: "EE. UU.",
    },
    {
      id: "btc-2023-svb-crisis",
      time: "2023-03-10T16:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Quiebra de Silicon Valley Bank (SVB) y contagio bancario",
      actual: "Rescate FDIC",
      forecast: "—",
      previous: "Solvente",
      country: "EE. UU.",
    },
    {
      id: "btc-2023-blackrock-etf",
      time: "2023-06-15T16:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "BlackRock solicita formalmente a la SEC el ETF iShares Bitcoin Trust",
      actual: "Presentada",
      forecast: "—",
      previous: "Ninguna",
      country: "EE. UU.",
    },
    {
      id: "btc-2023-exchange-settlement",
      time: "2023-11-21T18:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Exchange global y CZ pactan acuerdo de $4.300M con el Departamento de Justicia",
      actual: "Multa de $4.300M",
      forecast: "—",
      previous: "Investigado",
      country: "EE. UU.",
    },
    {
      id: "btc-2024-spot-etf",
      time: "2024-01-10T22:30:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "La SEC aprueba 11 ETFs de Bitcoin al contado (IBIT, FBTC, ARKB)",
      actual: "Aprobados (11/11)",
      forecast: "Aprobación",
      previous: "Rechazados",
      country: "EE. UU.",
    },
    {
      id: "btc-2024-pre-halving-ath",
      time: "2024-03-14T12:00:00.000Z",
      currency: "BTC",
      impact: "medium",
      event: "Bitcoin marca el 1.er máximo histórico previo a un Halving ($73.750 ATH)",
      actual: "$73,750",
      forecast: "—",
      previous: "$68,789",
      country: "Global",
    },
    {
      id: "btc-2024-halving-4",
      time: "2024-04-20T00:09:27.000Z",
      currency: "BTC",
      impact: "high",
      event: "4.º Halving de Bitcoin (Bloque 840.000: 6,25 -> 3,125 BTC)",
      actual: "3.125 BTC",
      forecast: "3.125 BTC",
      previous: "6.25 BTC",
      country: "Global",
    },
    {
      id: "btc-2024-election-breakout",
      time: "2024-11-06T04:00:00.000Z",
      currency: "BTC",
      impact: "high",
      event: "Resultado electoral pro-cripto en EE. UU.: Bitcoin rompe los $75.000",
      actual: "$75,358",
      forecast: "—",
      previous: "$69,000",
      country: "EE. UU.",
    },
  ];

  // Key curated landmark events (2024 - 2026)
  const landmarkEvents: EconomicCalendarEvent[] = [
    ...bitcoinLandmarkEvents,
    {
      id: "ev-2026-10-16-1",
      time: "2026-10-16T12:30:00.000Z",
      currency: "USD",
      impact: "medium",
      event: "Ventas minoristas subyacentes (MoM)",
      actual: "0.5%",
      forecast: "0.2%",
      previous: "0.1%",
      country: "EE. UU.",
    },
    {
      id: "ev-2026-10-16-2",
      time: "2026-10-16T14:00:00.000Z",
      currency: "USD",
      impact: "medium",
      event: "Confianza del consumidor (Univ. de Michigan)",
      actual: "70.5",
      forecast: "69.0",
      previous: "70.1",
      country: "EE. UU.",
    },
    {
      id: "ev-2026-10-14",
      time: "2026-10-14T12:30:00.000Z",
      currency: "USD",
      impact: "high",
      event: "Índice de Precios al Consumo (IPC interanual)",
      actual: "2.4%",
      forecast: "2.3%",
      previous: "2.5%",
      country: "EE. UU.",
    },
    {
      id: "ev-2026-10-09",
      time: "2026-10-09T18:00:00.000Z",
      currency: "USD",
      impact: "medium",
      event: "Actas de la reunión del FOMC",
      actual: "Acomodaticia (Dovish)",
      forecast: "Neutral",
      previous: "Neutral",
      country: "EE. UU.",
    },
    {
      id: "ev-2026-09-18",
      time: "2026-09-18T18:00:00.000Z",
      currency: "USD",
      impact: "high",
      event: "Decisión de tipos de interés de la Fed (recorte de 50 pb al 5,00%)",
      actual: "5.00%",
      forecast: "5.00%",
      previous: "5.50%",
      country: "EE. UU.",
    },
    {
      id: "ev-2026-09-18-press",
      time: "2026-09-18T18:30:00.000Z",
      currency: "USD",
      impact: "high",
      event: "Rueda de prensa del FOMC - Presidente Powell",
      actual: "Giro Dovish",
      forecast: "—",
      previous: "—",
      country: "EE. UU.",
    },
  ];

  const addedIds = new Set(landmarkEvents.map((e) => e.id));
  events.push(...landmarkEvents);

  // Generate full monthly macroeconomic releases from 2011 to late 2026 (matching full chart candle data)
  for (let y = 2011; y <= 2026; y++) {
    const maxM = y === 2026 ? 11 : 12;
    for (let m = 1; m <= maxM; m++) {
      const d1 = new Date(Date.UTC(y, m - 1, 1));
      const dayOfWeek = d1.getUTCDay();

      // 1st business day: ISM Manufacturing PMI (Medium Impact)
      let ismDay = 1;
      if (dayOfWeek === 0) ismDay = 2; // Sunday -> Monday
      else if (dayOfWeek === 6) ismDay = 3; // Saturday -> Monday

      const ismId = `ism-${y}-${pad(m)}`;
      if (!addedIds.has(ismId)) {
        const pmi = (48.5 + Math.sin(y + m) * 3.5).toFixed(1);
        events.push({
          id: ismId,
          time: `${y}-${pad(m)}-${pad(ismDay)}T14:00:00.000Z`,
          currency: "USD",
          impact: "medium",
          event: "PMI manufacturero del ISM",
          actual: pmi,
          forecast: "49.0",
          previous: "48.2",
          country: "EE. UU.",
        });
        addedIds.add(ismId);
      }

      // 1st Friday: Non-Farm Payrolls (High) & Unemployment Rate (Medium)
      let firstFri = 1 + ((5 - dayOfWeek + 7) % 7);
      if (firstFri === 1 && dayOfWeek !== 5) firstFri += 7;

      const nfpId = `nfp-${y}-${pad(m)}`;
      if (!addedIds.has(nfpId)) {
        const nfpActual = 140 + Math.floor(Math.sin(y * 12 + m) * 60 + 50);
        events.push({
          id: nfpId,
          time: `${y}-${pad(m)}-${pad(firstFri)}T12:30:00.000Z`,
          currency: "USD",
          impact: "high",
          event: "Nóminas no agrícolas (NFP)",
          actual: `${nfpActual}K`,
          forecast: `${160 + Math.floor(Math.cos(m) * 20)}K`,
          previous: `${155 + Math.floor(Math.sin(m) * 25)}K`,
          country: "EE. UU.",
        });
        addedIds.add(nfpId);
      }

      const unempId = `unemp-${y}-${pad(m)}`;
      if (!addedIds.has(unempId)) {
        const unempRate = (3.8 + (y - 2024) * 0.15 + Math.sin(m) * 0.1).toFixed(1);
        events.push({
          id: unempId,
          time: `${y}-${pad(m)}-${pad(firstFri)}T12:30:00.000Z`,
          currency: "USD",
          impact: "medium",
          event: "Tasa de desempleo",
          actual: `${unempRate}%`,
          forecast: `${(Number(unempRate) + 0.1).toFixed(1)}%`,
          previous: `${unempRate}%`,
          country: "EE. UU.",
        });
        addedIds.add(unempId);
      }

      // 2nd Wednesday: CPI Inflation Rate (YoY) (High Impact)
      const secondWed = 8 + ((3 - new Date(Date.UTC(y, m - 1, 8)).getUTCDay() + 7) % 7);
      const cpiId = `cpi-${y}-${pad(m)}`;
      if (!addedIds.has(cpiId)) {
        const cpiVal = Math.max(2.1, 3.5 - (y - 2024) * 0.5 - m / 24).toFixed(1);
        events.push({
          id: cpiId,
          time: `${y}-${pad(m)}-${pad(secondWed)}T12:30:00.000Z`,
          currency: "USD",
          impact: "high",
          event: "Índice de Precios al Consumo (IPC interanual)",
          actual: `${cpiVal}%`,
          forecast: `${(Number(cpiVal) + 0.1).toFixed(1)}%`,
          previous: `${(Number(cpiVal) + 0.2).toFixed(1)}%`,
          country: "EE. UU.",
        });
        addedIds.add(cpiId);
      }

      // Mid-month: Core Retail Sales (MoM) (Medium Impact)
      const retailId = `retail-${y}-${pad(m)}`;
      if (!addedIds.has(retailId)) {
        const retailVal = (0.1 + Math.sin(m + y) * 0.3).toFixed(1);
        events.push({
          id: retailId,
          time: `${y}-${pad(m)}-15T12:30:00.000Z`,
          currency: "USD",
          impact: "medium",
          event: "Ventas minoristas subyacentes (MoM)",
          actual: `${retailVal}%`,
          forecast: "0.2%",
          previous: "0.1%",
          country: "EE. UU.",
        });
        addedIds.add(retailId);
      }

      // FOMC Rate Decisions (Jan, Mar, May, Jun, Jul, Sep, Nov, Dec) (High Impact)
      if ([1, 3, 5, 6, 7, 9, 11, 12].includes(m)) {
        const fomcId = `fomc-${y}-${pad(m)}`;
        if (!addedIds.has(fomcId)) {
          const rate =
            y === 2024
              ? "5.50%"
              : y === 2025
                ? m > 6
                  ? "5.25%"
                  : "5.50%"
                : m >= 9
                  ? "5.00%"
                  : "5.25%";
          events.push({
            id: fomcId,
            time: `${y}-${pad(m)}-18T18:00:00.000Z`,
            currency: "USD",
            impact: "high",
            event: "Decisión de tipos de interés de la Fed",
            actual: rate,
            forecast: rate,
            previous: y === 2024 && m === 1 ? "5.50%" : rate,
            country: "EE. UU.",
          });
          addedIds.add(fomcId);

          const pressId = `fomc-press-${y}-${pad(m)}`;
          events.push({
            id: pressId,
            time: `${y}-${pad(m)}-18T18:30:00.000Z`,
            currency: "USD",
            impact: "high",
            event: "Rueda de prensa del FOMC - Presidente Powell",
            actual: m % 2 === 0 ? "Acomodaticia (Dovish)" : "Neutral",
            forecast: "—",
            previous: "—",
            country: "EE. UU.",
          });
          addedIds.add(pressId);
        }
      }

      // Last Friday: Core PCE Price Index (MoM) (Medium Impact)
      const dLast = new Date(Date.UTC(y, m, 0));
      const lastFri = dLast.getUTCDate() - ((dLast.getUTCDay() - 5 + 7) % 7);
      const pceId = `pce-${y}-${pad(m)}`;
      if (!addedIds.has(pceId)) {
        events.push({
          id: pceId,
          time: `${y}-${pad(m)}-${pad(lastFri)}T12:30:00.000Z`,
          currency: "USD",
          impact: "medium",
          event: "Índice de precios PCE subyacente (MoM)",
          actual: "0.2%",
          forecast: "0.2%",
          previous: "0.2%",
          country: "EE. UU.",
        });
        addedIds.add(pceId);
      }

      // Initial Jobless Claims (Medium Impact) - 2nd and 4th Thursdays
      const secondThu = 8 + ((4 - new Date(Date.UTC(y, m - 1, 8)).getUTCDay() + 7) % 7);
      const claimsId1 = `claims-${y}-${pad(m)}-1`;
      if (!addedIds.has(claimsId1)) {
        const claimsVal = 215 + Math.floor(Math.sin(y * 10 + m) * 20);
        events.push({
          id: claimsId1,
          time: `${y}-${pad(m)}-${pad(secondThu)}T12:30:00.000Z`,
          currency: "USD",
          impact: "low",
          event: "Peticiones iniciales de subsidio por desempleo",
          actual: `${claimsVal}K`,
          forecast: "220K",
          previous: `${claimsVal + 3}K`,
          country: "EE. UU.",
        });
        addedIds.add(claimsId1);
      }
      const fourthThu = secondThu + 14;
      if (fourthThu <= dLast.getUTCDate()) {
        const claimsId2 = `claims-${y}-${pad(m)}-2`;
        if (!addedIds.has(claimsId2)) {
          const claimsVal2 = 218 + Math.floor(Math.cos(y * 5 + m) * 18);
          events.push({
            id: claimsId2,
            time: `${y}-${pad(m)}-${pad(fourthThu)}T12:30:00.000Z`,
            currency: "USD",
            impact: "low",
            event: "Peticiones iniciales de subsidio por desempleo",
            actual: `${claimsVal2}K`,
            forecast: "222K",
            previous: `${claimsVal2 - 2}K`,
            country: "EE. UU.",
          });
          addedIds.add(claimsId2);
        }
      }

      // 2nd Friday: Michigan Consumer Sentiment (Medium Impact)
      const secondFri = firstFri + 7;
      if (secondFri <= dLast.getUTCDate()) {
        const michId = `mich-${y}-${pad(m)}`;
        if (!addedIds.has(michId)) {
          events.push({
            id: michId,
            time: `${y}-${pad(m)}-${pad(secondFri)}T14:00:00.000Z`,
            currency: "USD",
            impact: "medium",
            event: "Confianza del consumidor (Univ. de Michigan)",
            actual: (68.5 + Math.sin(y + m) * 4).toFixed(1),
            forecast: "68.0",
            previous: "67.5",
            country: "EE. UU.",
          });
          addedIds.add(michId);
        }
      }

      // EIA Crude Oil Inventories (Low Impact) - 3rd Wednesday
      const thirdWed = 15 + ((3 - new Date(Date.UTC(y, m - 1, 15)).getUTCDay() + 7) % 7);
      const eiaId = `eia-${y}-${pad(m)}`;
      if (!addedIds.has(eiaId)) {
        const eiaVal = (Math.sin(y + m * 2) * 2.5).toFixed(1);
        events.push({
          id: eiaId,
          time: `${y}-${pad(m)}-${pad(thirdWed)}T14:30:00.000Z`,
          currency: "USD",
          impact: "low",
          event: "Inventarios de petróleo crudo de la EIA",
          actual: `${Number(eiaVal) > 0 ? "+" : ""}${eiaVal}M`,
          forecast: "+0.5M",
          previous: "-1.2M",
          country: "EE. UU.",
        });
        addedIds.add(eiaId);
      }

      // Quarterly GDP (Mar, Jun, Sep, Dec)
      if ([3, 6, 9, 12].includes(m)) {
        const gdpId = `gdp-${y}-${pad(m)}`;
        if (!addedIds.has(gdpId)) {
          const gdpRate = (2.4 + Math.cos(m + y) * 0.6).toFixed(1);
          events.push({
            id: gdpId,
            time: `${y}-${pad(m)}-26T12:30:00.000Z`,
            currency: "USD",
            impact: "high",
            event: `Crecimiento del PIB anualizado de EE. UU. (T${Math.floor(m / 3)})`,
            actual: `${gdpRate}%`,
            forecast: "2.6%",
            previous: "2.8%",
            country: "EE. UU.",
          });
          addedIds.add(gdpId);
        }
      }

      // European Central Bank (EUR) every other month
      if (m % 2 === 1) {
        const ecbId = `ecb-${y}-${pad(m)}`;
        if (!addedIds.has(ecbId)) {
          const ecbRate = y === 2024 ? "4.00%" : y === 2025 ? "3.75%" : "3.40%";
          events.push({
            id: ecbId,
            time: `${y}-${pad(m)}-12T12:15:00.000Z`,
            currency: "EUR",
            impact: "high",
            event: "Decisión de tipos de interés del BCE",
            actual: ecbRate,
            forecast: ecbRate,
            previous: ecbRate,
            country: "Zona Euro",
          });
          addedIds.add(ecbId);
        }
      }

      // Bank of England (GBP)
      if ([2, 5, 8, 11].includes(m)) {
        const boeId = `boe-${y}-${pad(m)}`;
        if (!addedIds.has(boeId)) {
          const boeRate = y === 2024 ? "5.25%" : y === 2025 ? "5.00%" : "4.75%";
          events.push({
            id: boeId,
            time: `${y}-${pad(m)}-08T11:00:00.000Z`,
            currency: "GBP",
            impact: "high",
            event: "Tipo de interés oficial del Banco de Inglaterra",
            actual: boeRate,
            forecast: boeRate,
            previous: boeRate,
            country: "Reino Unido",
          });
          addedIds.add(boeId);
        }
      }
    }
  }

  // Enrich every single event with bullish/bearish/neutral sentiment and explanation
  for (const ev of events) {
    if (!ev.sentiment) {
      const evaluated = evaluateEconomicEventSentiment(ev);
      ev.sentiment = evaluated.sentiment;
      ev.sentimentReason = evaluated.reason;
    }
  }

  // Sort chronologically descending (newest first)
  return events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}

function parseNumericValue(raw?: string): number | null {
  if (!raw || raw === "—") return null;
  const cleaned = raw.replace(/,/g, "").match(/[+-]?\d+(\.\d+)?/);
  if (!cleaned) return null;
  const num = Number(cleaned[0]);
  return Number.isFinite(num) ? num : null;
}

export function evaluateEconomicEventSentiment(ev: EconomicCalendarEvent): {
  sentiment: "bullish" | "bearish" | "neutral";
  label: string;
  reason: string;
} {
  const title = ev.event.toLowerCase();
  const actualStr = (ev.actual || "").toLowerCase();

  // 1. Explicit Bitcoin landmark milestones
  const bearishBtcIds = new Set([
    "btc-2014-mtgox",
    "btc-2015-bottom",
    "btc-2018-winter-bottom",
    "btc-2020-black-thursday",
    "btc-2021-china-ban",
    "btc-2022-luna-crash",
    "btc-2022-ftx-collapse",
    "btc-2023-svb-crisis",
    "btc-2023-exchange-settlement",
  ]);
  if (bearishBtcIds.has(ev.id)) {
    return {
      sentiment: "bearish",
      label: "BAJISTA (MALO)",
      reason: "Evento negativo de mercado (shock de liquidez, prohibición o quiebra).",
    };
  }
  if (ev.id.startsWith("btc-")) {
    return {
      sentiment: "bullish",
      label: "ALCISTA (BUENO)",
      reason: "Hito positivo de adopción, reducción de emisión (Halving) o ruptura alcista.",
    };
  }

  // 2. Qualitative FOMC / Central Bank statements
  if (actualStr.includes("dovish") || actualStr.includes("acomodaticia") || title.includes("recorte")) {
    return {
      sentiment: "bullish",
      label: "ALCISTA (BUENO)",
      reason: "Política monetaria más laxa (Dovish / recorte de tipos): impulsa la liquidez y activos de riesgo.",
    };
  }
  if (actualStr.includes("hawkish") || actualStr.includes("restrictiva")) {
    return {
      sentiment: "bearish",
      label: "BAJISTA (MALO)",
      reason: "Política monetaria restrictiva (Hawkish): reduce liquidez y presiona los mercados.",
    };
  }

  const actualNum = parseNumericValue(ev.actual);
  const forecastNum = parseNumericValue(ev.forecast);
  const prevNum = parseNumericValue(ev.previous);
  const refNum = forecastNum ?? prevNum;

  // 3. Inflation indicators (IPC / CPI / PCE): Lower than expected = Bullish (Good for markets/crypto/rate cuts), Higher = Bearish (Bad)
  if (title.includes("ipc") || title.includes("pce") || title.includes("inflación")) {
    if (actualNum != null && refNum != null) {
      if (actualNum < refNum) {
        return {
          sentiment: "bullish",
          label: "ALCISTA (BUENO)",
          reason: `Inflación menor a lo esperado (${ev.actual} vs ${ev.forecast || ev.previous}): positivo para recortes de tipos y mercados.`,
        };
      }
      if (actualNum > refNum) {
        return {
          sentiment: "bearish",
          label: "BAJISTA (MALO)",
          reason: `Inflación mayor a lo esperado (${ev.actual} vs ${ev.forecast || ev.previous}): presión inflacionaria negativa para el mercado.`,
        };
      }
      return {
        sentiment: "neutral",
        label: "NEUTRAL (EN LÍNEA)",
        reason: `Inflación exactamente en línea con la previsión (${ev.actual}).`,
      };
    }
  }

  // 4. Unemployment / Jobless Claims: Lower than expected = Bullish (Strong labor), Higher = Bearish
  if (title.includes("desempleo") || title.includes("subsidio")) {
    if (actualNum != null && refNum != null) {
      if (actualNum < refNum) {
        return {
          sentiment: "bullish",
          label: "ALCISTA (BUENO)",
          reason: `Menor desempleo de lo previsto (${ev.actual} vs ${ev.forecast || ev.previous}): muestra solidez económica.`,
        };
      }
      if (actualNum > refNum) {
        return {
          sentiment: "bearish",
          label: "BAJISTA (MALO)",
          reason: `Mayor desempleo de lo previsto (${ev.actual} vs ${ev.forecast || ev.previous}): señal de debilidad económica.`,
        };
      }
      return {
        sentiment: "neutral",
        label: "NEUTRAL (EN LÍNEA)",
        reason: `Dato de empleo en línea con lo esperado (${ev.actual}).`,
      };
    }
  }

  // 5. Interest Rate Decisions (Fed, BCE, BoE): Lower than previous/forecast = Bullish, Higher = Bearish, Equal = Neutral/Bullish if cut cycle
  if (title.includes("tipos de interés") || title.includes("tipo de interés")) {
    if (actualNum != null && prevNum != null) {
      if (actualNum < prevNum) {
        return {
          sentiment: "bullish",
          label: "ALCISTA (BUENO)",
          reason: `Recorte de tipos de interés (${ev.previous} → ${ev.actual}): inyección de liquidez favorable.`,
        };
      }
      if (actualNum > prevNum) {
        return {
          sentiment: "bearish",
          label: "BAJISTA (MALO)",
          reason: `Subida de tipos de interés (${ev.previous} → ${ev.actual}): encarece el crédito y frena el mercado.`,
        };
      }
      return {
        sentiment: "neutral",
        label: "NEUTRAL (SIN CAMBIOS)",
        reason: `Tipos de interés mantenidos sin cambios en ${ev.actual} según lo previsto.`,
      };
    }
  }

  // 6. Oil Inventories (EIA): Drawdown (actual < forecast) = Bullish for energy/activity, large build = Bearish
  if (title.includes("petróleo") || title.includes("eia")) {
    if (actualNum != null && refNum != null) {
      if (actualNum < refNum) {
        return {
          sentiment: "bullish",
          label: "ALCISTA (BUENO)",
          reason: `Menor acumulación de inventarios (${ev.actual} vs ${ev.forecast}): mayor demanda energética.`,
        };
      }
      if (actualNum > refNum) {
        return {
          sentiment: "bearish",
          label: "BAJISTA (MALO)",
          reason: `Mayor acumulación de inventarios (${ev.actual} vs ${ev.forecast}): menor demanda esperada.`,
        };
      }
    }
  }

  // 7. Growth / Activity indicators (GDP / PIB, NFP, PMI, Retail Sales, Consumer Confidence): Higher than forecast = Bullish, Lower = Bearish
  if (actualNum != null && refNum != null) {
    if (actualNum > refNum) {
      return {
        sentiment: "bullish",
        label: "ALCISTA (BUENO)",
        reason: `Dato superior a la previsión (${ev.actual} vs ${ev.forecast || ev.previous}): impulsa el optimismo económico.`,
      };
    }
    if (actualNum < refNum) {
      return {
        sentiment: "bearish",
        label: "BAJISTA (MALO)",
        reason: `Dato inferior a la previsión (${ev.actual} vs ${ev.forecast || ev.previous}): por debajo de las expectativas.`,
      };
    }
  }

  return {
    sentiment: "neutral",
    label: "NEUTRAL (EN LÍNEA)",
    reason: "El informe se publicó en línea con el consenso del mercado.",
  };
}

export const DEMO_ECONOMIC_EVENTS: EconomicCalendarEvent[] = buildEconomicCalendar();
