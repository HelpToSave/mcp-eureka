#!/usr/bin/env node
// Test offline (fixtures) - parsowanie, formattery i bezpiecznik na dryf API.
// Fixture'y to PRAWDZIWE odpowiedzi JSON API EUREKA:
//   detail-698723.json  - GET informacje/698723, zrzut live 2026-07-08
//                         (via matematicsolutions/mcp-eureka, MIT - dzieki W. Mazur)
//   search-angola.json  - ksztalt POST wyszukiwarka/informacje z realnych wierszy
//                         zwroconych live 2026-07-28 (kolumny tego konektora)
// Wymaga `npm run build` (importuje z dist/).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {
    parseInterpretation,
    parseSuggestions,
    formatInterpretation,
    formatSearchResults,
    rowCitation,
    interpretationCitation,
    searchDriftError,
    detailDriftError,
    suggestDriftError,
    findSections,
    sliceContent,
    asciiTrapHint,
    stripHtml,
    reflowText,
} = require(join(__dirname, "..", "dist", "index.js"));

const failures = [];
const check = (cond, msg) => {
    if (!cond) failures.push(msg);
};
const fx = (name) =>
    JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf-8"));

// --- parseInterpretation na realnym dokumencie -----------------------------
{
    const doc = fx("detail-698723.json");
    const d = parseInterpretation(doc, "698723");
    check(d.sygnatura === "0112-KDIL3.4012.367.2026.2.AK", `sygnatura: ${d.sygnatura}`);
    check(d.dataWydania === "2026-07-03", `dataWydania: ${d.dataWydania}`);
    check(typeof d.tresc === "string" && d.tresc.length > 5000, "tresc dluga");
    check(!/<p|<span|<div|style=/.test(d.tresc ?? ""), "tresc bez surowego HTML");
    check(!/\n{3,}/.test(d.tresc ?? ""), "tresc bez potrojnych laman (reflow)");

    const text = formatInterpretation(d);
    check(text.includes("0112-KDIL3.4012.367.2026.2.AK"), "format: sygnatura");
    check(/Tresc: znaki \d+-\d+ z \d+/.test(text), "format: naglowek zakresu znakow");
    check(text.includes("Mapa dokumentu"), "format: mapa sekcji");
    check(
        text.includes("eureka.mf.gov.pl/informacje/podglad/698723"),
        "format: URL portalu",
    );
    // Model MUSI dostac jawna informacje, ze to fragment + jak siegnac po reszte.
    check(text.includes("To FRAGMENT"), "format: jawne oznaczenie fragmentu");
    check(/offset=\d+/.test(text), "format: instrukcja offset");
    check(text.includes('section="uzasadnienie"'), "format: wskazowka o uzasadnieniu");

    const cit = interpretationCitation(d);
    check(cit.doc_id === "698723", `citation doc_id: ${cit.doc_id}`);
    check(cit.signature === "0112-KDIL3.4012.367.2026.2.AK", "citation signature");
}

// --- sekcje: regresja na wpadke "pierwsze 4000 znakow" ---------------------
// Uzasadnienie organu lezy ~73% dlugosci dokumentu. Bez skoku do sekcji model
// widzi wylacznie stan faktyczny i NIE MOZE cytowac argumentacji organu.
{
    const d = parseInterpretation(fx("detail-698723.json"), "698723");
    const t = d.tresc;
    const sec = findSections(t);
    const byKey = Object.fromEntries(sec.map((s) => [s.key, s.index]));

    check(sec.length >= 5, `wykryto sekcje: ${sec.map((s) => s.key).join(", ")}`);
    // Kolejnosc sekcji musi rosnac - inaczej naglowek przechwytuje kotwice.
    check(
        sec.every((s, i) => i === 0 || sec[i - 1].index < s.index),
        "sekcje w kolejnosci dokumentu",
    );
    check(
        byKey.stanowisko > byKey.stan_faktyczny,
        `'stanowisko' po stanie faktycznym (${byKey.stanowisko} > ${byKey.stan_faktyczny}) ` +
            "- regresja: formula otwierajaca przechwytywala kotwice",
    );
    check(byKey.uzasadnienie > 4000, "uzasadnienie poza starym limitem 4000");

    // section='uzasadnienie' musi trafic w ocene organu, nie w stan faktyczny.
    const u = sliceContent(t, { section: "uzasadnienie" });
    check(u.start === byKey.uzasadnienie, "slice startuje na sekcji uzasadnienia");
    check(
        /Ocena stanowiska|Uzasadnienie interpretacji/i.test(u.text.slice(0, 200)),
        "tresc uzasadnienia zaczyna sie od oceny organu",
    );
    check(
        /Zgodnie z (?:przepisem |art)/i.test(u.text),
        "uzasadnienie zawiera wywod prawny organu",
    );

    // offset domyka caly dokument, bez petli i bez gubienia znakow.
    let off = 0;
    let guard = 0;
    let joined = "";
    while (guard++ < 100) {
        const s = sliceContent(t, { offset: off });
        joined += s.text;
        if (!s.hasMore) break;
        off = s.end;
    }
    check(joined.length === t.length, `stronicowanie odtwarza calosc: ${joined.length}/${t.length}`);
    check(guard < 100, "stronicowanie bez petli");

    // limity i przypadki brzegowe
    check(sliceContent(t, { maxChars: 999999 }).limit === 50000, "maxChars przyciete do 50000");
    check(sliceContent(t, { maxChars: 10 }).limit === 500, "maxChars podniesione do 500");
    check(sliceContent(t, { offset: 999999 }).text === "", "offset poza koncem = pusty");
    check(
        sliceContent(t, { section: "nie_ma_takiej" }).sectionMissing === "nie_ma_takiej",
        "nieznana sekcja sygnalizowana, nie cicha",
    );
    check(sliceContent(t, { section: "nie_ma_takiej" }).start === 0, "nieznana sekcja -> od poczatku");
    check(findSections("tekst bez zadnych naglowkow").length === 0, "brak sekcji = pusta mapa");
}

// --- search: formatter + citations -----------------------------------------
{
    const raw = fx("search-angola.json");
    const text = formatSearchResults("Wynik search:", raw);
    check(text.includes("Dopasowan wg EUREKI: 37"), "search: totalHits");
    check(text.includes("0115-KDIT2.4011.607.2025.1.MM"), "search: sygnatura");
    check(
        text.includes("eureka.mf.gov.pl/informacje/podglad/673398"),
        "search: link",
    );
    check(text.includes('get_interpretation id="673398"'), "search: hint pelnej tresci");

    const cit = rowCitation(raw.results[0]);
    check(cit.doc_id === "673398", "row citation doc_id");
    check(cit.author === "Dyrektor Krajowej Informacji Skarbowej", "row citation author");
    check(cit.date === "2025-12-29", `row citation date: ${cit.date}`);
}

// --- bezpiecznik na dryf API ------------------------------------------------
{
    // ksztalt zgodny z kontraktem -> brak alarmu
    check(searchDriftError(fx("search-angola.json")) === null, "drift: dobry search OK");
    check(searchDriftError({ results: [], totalHits: 0 }) === null, "drift: pusty wynik to nie dryf");
    check(detailDriftError(fx("detail-698723.json")) === null, "drift: dobry detail OK");
    check(
        suggestDriftError({ results: [{ suggestion: "ulga b+r" }] }) === null,
        "drift: dobre sugestie OK",
    );

    // przebudowane API -> jasny komunikat zamiast cichego pustego wyniku
    check(searchDriftError(null) !== null, "drift: search null");
    check(searchDriftError({}) !== null, "drift: search bez results");
    check(
        searchDriftError({ results: [{ NOWE_ID: "1" }] }) !== null,
        "drift: search bez ID_INFORMACJI",
    );
    check(
        searchDriftError({ results: [{ ID_INFORMACJI: "1", NOWE_POLE: "x" }] }) !== null,
        "drift: search bez SYG/TEZA",
    );
    check(detailDriftError({}) !== null, "drift: detail bez dokument.fields");
    check(
        detailDriftError({
            dokument: { fields: [{ key: "NOWE_POLE", value: "x" }] },
        }) !== null,
        "drift: detail bez znanych pol",
    );
    check(
        detailDriftError({ dokument: { fields: [] } }) === null,
        "drift: pusty detail to not_found, nie dryf",
    );
    check(suggestDriftError({}) !== null, "drift: suggest bez results");
    check(
        suggestDriftError({ results: [{ foo: 1 }] }) !== null,
        "drift: suggest bez pola suggestion",
    );
}

// --- STARY format interpretacji (Izby Skarbowe, sprzed ~2021) --------------
// Baza siega 2003 r., a redakcja zmienila sie ok. 2021. Stary format nie ma
// "Ocena stanowiska" - organ zaczyna od "Na tle przedstawionego stanu
// faktycznego stwierdzam" albo "W świetle obowiązującego stanu prawnego".
{
    const stary =
        "INTERPRETACJA INDYWIDUALNA\n\nDyrektor Izby Skarbowej w Katowicach stwierdza, ze " +
        "stanowisko Wnioskodawcy jest nieprawidlowe.\n\nUZASADNIENIE\n\n" +
        "W przedmiotowym wniosku zostal przedstawiony nastepujacy stan faktyczny:\n\n" +
        "x".repeat(500) +
        "\n\nW związku z powyższym zadano następujące pytanie:\n\nCzy...?\n\n" +
        "Zdaniem Wnioskodawcy, koszty...\n\n" +
        "x".repeat(300) +
        "\n\nNa tle przedstawionego stanu faktycznego stwierdzam, co następuje:\n\n" +
        "Zgodnie z art. 22 ust. 9 pkt 3 ustawy...\n\n" +
        "Stronie przysługuje prawo do wniesienia skargi...";
    const sec = findSections(stary);
    const keys = sec.map((s) => s.key);
    check(keys.includes("uzasadnienie"), `stary format: wykryto uzasadnienie (${keys.join(",")})`);
    const u = sliceContent(stary, { section: "uzasadnienie" });
    check(
        u.text.startsWith("Na tle przedstawionego"),
        "stary format: skok trafia w wywod organu, nie w stan faktyczny",
    );
    // "UZASADNIENIE" na ~90. znaku otwiera STAN FAKTYCZNY - nie wolno go uzyc
    // jako kotwicy sekcji 'uzasadnienie', bo skok trafialby w opis wnioskodawcy.
    check(u.start > 800, `stary format: kotwica nie zlapala golego "UZASADNIENIE" (${u.start})`);

    // Regresja: formula organu zawiera slowa "stanowisko Wnioskodawcy", przez co
    // wzorzec sekcji 'stanowisko' zaczepial sie WEWNATRZ niej i przesuwal kursor
    // za kotwice uzasadnienia (0115-KDIT2-3.4010.388.2017.1.PS - uzasadnienie przepadalo).
    const pulapka =
        "INTERPRETACJA INDYWIDUALNA\n\n" +
        "W przedmiotowym wniosku przedstawiono następujący stan faktyczny:\n" +
        "y".repeat(400) +
        "\n\nW związku z powyższym zadano następujące pytanie:\nCzy...?\n\n" +
        "y".repeat(200) +
        "\n\nW świetle obowiązującego stanu prawnego stanowisko Wnioskodawcy " +
        "w sprawie oceny prawnej jest nieprawidłowe.\n\nZgodnie z art. 15...";
    const sp = findSections(pulapka);
    const up = sliceContent(pulapka, { section: "uzasadnienie" });
    check(
        sp.some((s) => s.key === "uzasadnienie"),
        "pulapka: 'stanowisko Wnioskodawcy' w formule organu nie gubi uzasadnienia",
    );
    check(
        up.text.startsWith("W świetle obowiązującego"),
        "pulapka: skok trafia w formule organu",
    );
    // Sekcje musza pozostac w kolejnosci dokumentu mimo zmiany algorytmu.
    check(
        sp.every((s, i) => i === 0 || sp[i - 1].index < s.index),
        "pulapka: sekcje nadal w kolejnosci rosnacej",
    );

    // Nowy format nie moze sie zepsuc przy okazji poprawki dla starego.
    const d = parseInterpretation(fx("detail-698723.json"), "698723");
    const nowy = sliceContent(d.tresc, { section: "uzasadnienie" });
    check(
        nowy.text.startsWith("Ocena stanowiska"),
        "nowy format nadal dziala po poprawce dla starego",
    );
}

// --- pulapka bez diakrytykow (zmierzone: 0 vs 293 tys. trafien) ------------
{
    check(
        asciiTrapHint("podwyzszone koszty uzyskania") !== null,
        "ascii trap: 'podwyzszone' ostrzega",
    );
    check(
        asciiTrapHint("podwyższone koszty uzyskania") === null,
        "ascii trap: poprawna pisownia bez ostrzezenia",
    );
    check(asciiTrapHint("tworca honorarium") !== null, "ascii trap: 'tworca'");
    // Terminy, ktore po polsku NIE maja diakrytykow - zero falszywych alarmow.
    check(asciiTrapHint("Angola") === null, "ascii trap: 'Angola' bez alarmu");
    check(asciiTrapHint("cash pooling") === null, "ascii trap: angielski bez alarmu");
    check(asciiTrapHint(undefined) === null, "ascii trap: brak query");

    // Komunikat o zerze wynikow niesie diagnostyke, nie samo "brak".
    const pusto = formatSearchResults("H:", { results: [], totalHits: 0 }, "tworca aktor");
    check(pusto.includes("diakrytyczn"), "zero wynikow: podpowiedz o diakrytykach");
    check(pusto.includes("2-4 slow"), "zero wynikow: podpowiedz o dlugosci zapytania");

    // Zawyzony totalHits musi byc oflagowany dla modelu.
    const duzo = formatSearchResults("H:", { results: [{ ID_INFORMACJI: "1", SYG: "X" }], totalHits: 14322 });
    check(duzo.includes("ROZMYTYCH"), "zawyzony totalHits: ostrzezenie");
    const malo = formatSearchResults("H:", { results: [{ ID_INFORMACJI: "1", SYG: "X" }], totalHits: 12 });
    check(!malo.includes("ROZMYTYCH"), "maly totalHits: bez ostrzezenia");
}

// --- suggest: parsowanie + odsiew smieci -----------------------------------
{
    const sugg = parseSuggestions({
        results: [{ suggestion: "ulga badawczo-rozwojowa" }, { suggestion: "," }],
    });
    check(sugg.length === 1 && sugg[0] === "ulga badawczo-rozwojowa", "suggest: odsiew");
}

// --- stripHtml + reflowText -------------------------------------------------
check(
    stripHtml("<p style='x'>a&nbsp;&amp;&nbsp;b</p>") === "a & b",
    "stripHtml: encje",
);
check(
    reflowText("linia pierwsza\nlinia druga") === "linia pierwsza linia druga",
    "reflowText: sklejanie zawijanych wierszy",
);

if (failures.length === 0) {
    console.log("OK parse - fixtures + drift guard + formattery.");
    process.exit(0);
}
console.error(`FAIL parse - ${failures.length} problemow:`);
for (const f of failures) console.error("  - " + f);
process.exit(1);
