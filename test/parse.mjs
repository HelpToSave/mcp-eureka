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
    check(/Tresc \(pierwsze \d+ znakow/.test(text), "format: naglowek tresci");
    check(
        text.includes("eureka.mf.gov.pl/informacje/podglad/698723"),
        "format: URL portalu",
    );

    const cit = interpretationCitation(d);
    check(cit.doc_id === "698723", `citation doc_id: ${cit.doc_id}`);
    check(cit.signature === "0112-KDIL3.4012.367.2026.2.AK", "citation signature");
}

// --- search: formatter + citations -----------------------------------------
{
    const raw = fx("search-angola.json");
    const text = formatSearchResults("Wynik search:", raw);
    check(text.includes("Znaleziono: 37"), "search: totalHits");
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
