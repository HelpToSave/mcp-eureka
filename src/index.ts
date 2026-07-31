#!/usr/bin/env node
// MCP server - polskie interpretacje indywidualne (Krajowa Informacja Skarbowa)
// przez PUBLICZNE API systemu EUREKA Ministerstwa Finansow (eureka.mf.gov.pl).
//
// Zamyka luke, ktorej nie pokrywa ani SAOS, ani CBOSA: interpretacje indywidualne
// prawa podatkowego (ulga B+R, IP Box, VAT, CIT, PIT, WHT, etc.). To tu zyje
// stanowisko organu na konkretny stan faktyczny - codzienny material doradcy.
//
// Stack: Node 18+, stdio, @modelcontextprotocol/sdk, https + JSON (czyste API REST).
// Wzorzec architektoniczny: matematicsolutions/mcp-nsa (ten sam kontrakt
// structuredContent.citations). EUREKA ma WAZNY certyfikat SSL - bez insecure agenta.
//
// Tooly:
//   - search             - po slowach kluczowych (+ zakres dat, opcja pelnej tresci)
//   - get_interpretation - tresc interpretacji po ID, porcjami (sekcje + offset;
//                          uzasadnienie organu lezy na koncu dokumentu)
//   - search_by_signature- skrot: szukaj po sygnaturze (np. "0115-KDST2-2.4011.218.2026.2.KK")
//   - suggest            - podpowiedzi fraz (autocomplete)
//
// ZAKRES: tylko interpretacje indywidualne (KATEGORIA_INFORMACJI = [1]).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import https from "https";

// ---------------------------------------------------------------------------
// Konfiguracja API EUREKA (potwierdzona empirycznie, read-only, 2026-06)
// ---------------------------------------------------------------------------

const BASE_URL = "https://eureka.mf.gov.pl/api/public/v1";
const DOC_UI_URL = (id: string) =>
    `https://eureka.mf.gov.pl/informacje/podglad/${id}`;
const HTTP_TIMEOUT_MS = 30000;
const USER_AGENT =
    "Mozilla/5.0 (compatible; mcp-eureka/1.0; MCP connector for KIS individual tax rulings)";

// KATEGORIA_INFORMACJI w slowniku EUREKA: 1 = "Interpretacja indywidualna",
// 2 = "Zmiana interpretacji indywidualnej". Faseta przyjmuje TABLICE LICZB.
// Zakres ustalony z uzytkownikiem: tylko interpretacje indywidualne.
const CATEGORY_INDIVIDUAL: number[] = [1];

// Kolumny (projekcja) zwracane przez wyszukiwarke. Serwer rozwiazuje slownikowe
// ID do etykiet (AUTOR -> "Dyrektor KIS", KATEGORIA -> "Interpretacja indywidualna").
const SEARCH_COLUMNS = [
    "ID_INFORMACJI",
    "SYG",
    "TEZA",
    "AUTOR",
    "DT_WYD",
    "DATA_PUBLIKACJI",
];

// Sortowanie. POMINIECIE parametru `sort` = domyslne sortowanie Elasticsearcha
// po TRAFNOSCI (backend EUREKI to ES - odpowiedz zawiera elasticDocumentId).
//
// To NIE jest kosmetyka. Zmierzone 2026-07-31 na zapytaniu "50% koszty uzyskania
// przychodow aktor prawa autorskie" (2622 dopasowania):
//   sort=ID_INFORMACJI,DESC -> licencje na oprogramowanie, UPO polsko-belgijska,
//                              IP Box, WHT... zero trafien w temat
//   bez sort                -> "Czy wnioskodawca ma prawo zastosowac 50% koszty
//                              uzyskania przychodu?", honorarium autorskie,
//                              art. 22 ust. 9 pkt 3... same trafienia w temat
// Przy kilku tysiacach rozmytych dopasowan sortowanie po dacie zwracalo
// 10 NAJNOWSZYCH zamiast 10 NAJTRAFNIEJSZYCH.
const SORT_MODES = {
    trafnosc: undefined, // brak parametru sort -> ranking ES po _score
    data_desc: "ID_INFORMACJI,DESC",
    data_asc: "ID_INFORMACJI,ASC",
} as const;

export type SortMode = keyof typeof SORT_MODES;
export const SORT_KEYS = Object.keys(SORT_MODES) as SortMode[];

// ---------------------------------------------------------------------------
// Klient HTTP (JSON, GET/POST)
// ---------------------------------------------------------------------------

interface HttpOpts {
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string | number>;
    body?: unknown;
}

async function httpJson<T>(opts: HttpOpts): Promise<T> {
    const { method, path, query, body } = opts;
    const qs = query
        ? "?" +
          Object.entries(query)
              .map(
                  ([k, v]) =>
                      `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
              )
              .join("&")
        : "";
    const url = `${BASE_URL}${path}${qs}`;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;

    return new Promise<T>((resolve, reject) => {
        const headers: Record<string, string> = {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
            "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.5",
        };
        if (payload !== undefined) {
            headers["Content-Type"] = "application/json";
            headers["Content-Length"] = String(Buffer.byteLength(payload));
        }

        const req = https.request(
            url,
            { method, headers, timeout: HTTP_TIMEOUT_MS },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    const status = res.statusCode ?? 0;
                    if (status >= 400) {
                        reject(
                            new Error(
                                `HTTP ${status} ${res.statusMessage ?? ""} for ${url} :: ${text.slice(0, 300)}`,
                            ),
                        );
                        return;
                    }
                    try {
                        resolve(JSON.parse(text) as T);
                    } catch (e) {
                        reject(
                            new Error(
                                `JSON parse error for ${url}: ${(e as Error).message}`,
                            ),
                        );
                    }
                });
                res.on("error", reject);
            },
        );
        req.on("error", reject);
        req.on("timeout", () => {
            req.destroy(new Error(`HTTP timeout ${HTTP_TIMEOUT_MS}ms for ${url}`));
        });
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Throttle - grzecznie wobec MF (~3 req/s)
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MS = 350;
let lastRequestAt = 0;
async function throttled<T>(fn: () => Promise<T>): Promise<T> {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fn();
}

// ---------------------------------------------------------------------------
// Helpery tekstowe
// ---------------------------------------------------------------------------

function asText(v: unknown): string | undefined {
    if (v === undefined || v === null) return undefined;
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean).join("; ");
    return String(v);
}

function trimDate(v: string | undefined): string | undefined {
    if (!v) return undefined;
    const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : v;
}

function decodeEntities(s: string): string {
    const named: Record<string, string> = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&apos;": "'",
        "&sect;": "§",
        "&middot;": "·",
        "&bull;": "•",
        "&ndash;": "–",
        "&mdash;": "—",
        "&hellip;": "…",
        "&laquo;": "«",
        "&raquo;": "»",
        "&bdquo;": "„",
        "&ldquo;": "“",
        "&rdquo;": "”",
        "&sbquo;": "‚",
        "&lsquo;": "‘",
        "&rsquo;": "’",
        "&deg;": "°",
        "&times;": "×",
        "&divide;": "÷",
        "&euro;": "€",
        "&copy;": "©",
        "&reg;": "®",
    };
    return s
        .replace(/&[a-zA-Z]+;/g, (m) => named[m] ?? m)
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) =>
            String.fromCharCode(parseInt(n, 16)),
        )
        .replace(/\u00A0/g, " ");
}

// Usuwa HTML i zamienia bloki na sensowne lamania. Wynik bywa "porozrywany"
// (kazda wizualna linia zrodla to osobny <br>), dlatego nastepnie przepuszczamy
// go przez reflowText(), ktory sklei zawijane wiersze w plynne akapity.
export function stripHtml(s: string): string {
    const t = s
        .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "")
        .replace(/<\s*br\s*\/?\s*>/gi, "\n")
        .replace(/<\s*li[^>]*>/gi, "\n• ")
        .replace(
            /<\s*\/\s*(p|div|tr|li|ul|ol|h[1-6]|table|blockquote)\s*>/gi,
            "\n\n",
        )
        .replace(/<[^>]+>/g, " ");
    return decodeEntities(t)
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// Skleja "porozrywane" wiersze w plynne akapity. W obrebie bloku (tekst oddzielony
// pusta linia) laczy zawijane wiersze spacja, ale: zaczyna nowy wiersz przed
// wypunktowaniem (1) / a) / - / § / art. / ust. / pkt / lit.) oraz lamie po
// dwukropku (zwykle wprowadza liste). Akapity rozdzielone pusta linia.
export function reflowText(text: string): string {
    const norm = text.replace(/\r\n?/g, "\n");
    const blocks = norm.split(/\n{2,}/);
    const listRe =
        /^(\d+[.)]\s|[a-zA-Z]\)\s|[-–•*]\s|§\s?\d|art\.\s|ust\.\s|pkt\s|lit\.\s)/;
    const out: string[] = [];
    for (const block of blocks) {
        const lines = block
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length === 0) continue;
        const paras: string[] = [];
        let cur = "";
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (cur === "") cur = line;
            else if (listRe.test(line)) {
                paras.push(cur);
                cur = line;
            } else cur += " " + line;
            if (/:$/.test(line) && i < lines.length - 1) {
                paras.push(cur);
                cur = "";
            }
        }
        if (cur) paras.push(cur);
        out.push(paras.join("\n"));
    }
    return out
        .join("\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

// ---------------------------------------------------------------------------
// Bezpiecznik na dryf API (sugestia W. Mazura)
//
// API EUREKI jest nieoficjalne i moze sie zmienic bez zapowiedzi. Gdy znikna
// krytyczne pola (ID_INFORMACJI, SYG/TEZA, dokument.fields), lepiej zwrocic
// jasny blad `api_changed` niz cichy pusty wynik. Sprawdzamy tylko pola
// KRYTYCZNE - kosmetyczna zmiana kontraktu nie ma wywracac konektora.
// ---------------------------------------------------------------------------

const API_CHANGED_HINT =
    "Struktura odpowiedzi API EUREKI odbiega od znanego kontraktu (odtworzonego " +
    "2026-06) - prawdopodobnie MF przebudowalo system. Zglos to: " +
    "https://github.com/HelpToSave/mcp-eureka/issues";

// Zwraca opis niezgodnosci albo null, gdy ksztalt odpowiedzi wyszukiwarki OK.
export function searchDriftError(resp: unknown): string | null {
    if (typeof resp !== "object" || resp === null) {
        return "odpowiedz wyszukiwarki nie jest obiektem JSON";
    }
    const r = resp as SearchResponse;
    if (!Array.isArray(r.results)) {
        return "w odpowiedzi wyszukiwarki brak tablicy 'results'";
    }
    if (r.results.length === 0) return null; // pusty wynik to nie dryf
    if (!r.results.some((row) => row && row["ID_INFORMACJI"] !== undefined)) {
        return "wyniki wyszukiwarki nie zawieraja pola ID_INFORMACJI";
    }
    if (
        !r.results.some(
            (row) => row && (row["SYG"] !== undefined || row["TEZA"] !== undefined),
        )
    ) {
        return "wyniki wyszukiwarki nie zawieraja pol SYG/TEZA";
    }
    return null;
}

// Dryf pelnego dokumentu: 200 OK, pola sa, ale zaden ZNANY klucz nie wystepuje.
// Pusta lista fields to nie dryf (dokument moze nie istniec -> not_found).
export function detailDriftError(doc: unknown): string | null {
    if (typeof doc !== "object" || doc === null) {
        return "odpowiedz dokumentu nie jest obiektem JSON";
    }
    const fields = (doc as DocResponse).dokument?.fields;
    if (!Array.isArray(fields)) return "w dokumencie brak 'dokument.fields'";
    if (fields.length === 0) return null;
    const known = new Set([
        "SYG",
        "TEZA",
        "DT_WYD",
        "DATA_PUBLIKACJI",
        "TRESC_INTERESARIUSZ",
    ]);
    return fields.some((f) => known.has(f.key))
        ? null
        : "dokument.fields nie zawiera zadnego ze znanych pol (SYG/TEZA/DT_WYD/TRESC_INTERESARIUSZ)";
}

// Dryf sugestii: results istnieje, ale pozycje nie maja pola 'suggestion'.
export function suggestDriftError(resp: unknown): string | null {
    if (typeof resp !== "object" || resp === null) {
        return "odpowiedz sugestii nie jest obiektem JSON";
    }
    const r = resp as SuggestResponse;
    if (!Array.isArray(r.results)) {
        return "w odpowiedzi sugestii brak tablicy 'results'";
    }
    if (r.results.length === 0) return null;
    return r.results.some((x) => typeof x?.suggestion === "string")
        ? null
        : "pozycje sugestii nie zawieraja pola 'suggestion'";
}

// ---------------------------------------------------------------------------
// Wyszukiwanie
// ---------------------------------------------------------------------------

interface SearchParams {
    query?: string;
    signature?: string;
    dateFrom?: string;
    dateTo?: string;
    searchInContent?: boolean;
    fullPhrase?: boolean;
    sort?: SortMode;
    pageSize?: number;
    pageNumber?: number;
}

type EurekaRow = Record<string, string | string[]>;

interface SearchResponse {
    results?: EurekaRow[];
    totalHits?: number;
    elasticDocumentId?: string;
    sortMode?: SortMode; // dokladane lokalnie, nie pochodzi z API
}

async function eurekaSearch(p: SearchParams): Promise<SearchResponse> {
    const filter: Record<string, unknown> = {
        KATEGORIA_INFORMACJI: CATEGORY_INDIVIDUAL,
    };
    // Dokladne dopasowanie po sygnaturze: SYG jako STRING w filtrze (potwierdzone:
    // string -> exact match 1 trafienie; tablica/searchQuery tokenizuja i gubia exact).
    if (p.signature) filter["SYG"] = p.signature;
    // Zakres dat wydania (DT_WYD). Pola *_start / *_end sa formatowane do YYYY-MM-DD
    // przez front EUREKI; przekazujemy tylko gdy podane.
    if (p.dateFrom) filter["DT_WYD_start"] = p.dateFrom;
    if (p.dateTo) filter["DT_WYD_end"] = p.dateTo;

    const body = {
        filter,
        columns: SEARCH_COLUMNS,
        searchInFullPhrase: p.fullPhrase ?? false,
        searchInContent: p.searchInContent ?? false,
        searchInSynonyms: false,
        searchQuery: p.query ?? "",
        additionalParameters: {},
        warunkiDodatkowe: [],
    };
    const size = Math.min(50, Math.max(1, p.pageSize ?? 10));
    const page = Math.max(0, (p.pageNumber ?? 1) - 1);

    // Domyslnie trafnosc: `sort` jest POMIJANY, nie ustawiany na inna wartosc.
    const sortSpec = SORT_MODES[p.sort ?? "trafnosc"];
    const query: Record<string, string | number> = { size, page };
    if (sortSpec !== undefined) query.sort = sortSpec;

    return throttled(() =>
        httpJson<SearchResponse>({
            method: "POST",
            path: "/wyszukiwarka/informacje",
            query,
            body,
        }),
    );
}

// ---------------------------------------------------------------------------
// Pelna interpretacja
// ---------------------------------------------------------------------------

interface DocField {
    key: string;
    value: string | string[];
    dataType?: string;
}
interface DocResponse {
    id?: number;
    nazwa?: string;
    dokument?: { fields?: DocField[] };
}

interface Interpretation {
    id: string;
    sygnatura?: string;
    kategoria?: string;
    dataWydania?: string;
    dataPublikacji?: string;
    teza?: string;
    tresc?: string;
}

async function eurekaGetDoc(id: string): Promise<{ safe: string; doc: DocResponse }> {
    const safe = id.replace(/[^0-9]/g, "");
    if (!safe) throw new Error("invalid id");
    const doc = await throttled(() =>
        httpJson<DocResponse>({ method: "GET", path: `/informacje/${safe}` }),
    );
    return { safe, doc };
}

// Czysta funkcja parsujaca (bez HTTP) - testowalna offline na fixture'ach.
export function parseInterpretation(doc: DocResponse, id: string): Interpretation {
    const map = new Map<string, string | string[]>();
    for (const f of doc.dokument?.fields ?? []) map.set(f.key, f.value);

    const trescRaw = asText(map.get("TRESC_INTERESARIUSZ")) ?? "";
    return {
        id,
        sygnatura: asText(map.get("SYG")),
        kategoria: doc.nazwa,
        dataWydania: trimDate(asText(map.get("DT_WYD"))),
        dataPublikacji: trimDate(asText(map.get("DATA_PUBLIKACJI"))),
        teza: asText(map.get("TEZA")),
        tresc: trescRaw ? reflowText(stripHtml(trescRaw)) : undefined,
    };
}

// ---------------------------------------------------------------------------
// Podpowiedzi
// ---------------------------------------------------------------------------

interface SuggestResponse {
    results?: { suggestion: string }[];
}

async function eurekaSuggest(phrase: string): Promise<SuggestResponse> {
    const enc = encodeURIComponent(phrase);
    return throttled(() =>
        httpJson<SuggestResponse>({
            method: "GET",
            path: `/wyszukiwarka/sugestie/${enc}`,
        }),
    );
}

// Odsiej smieci (np. "," tokeny) - zostaw frazy z min. 3 literami.
export function parseSuggestions(r: SuggestResponse): string[] {
    return (r.results ?? [])
        .map((x) => x.suggestion)
        .filter((s) => typeof s === "string" && (s.match(/\p{L}/gu) ?? []).length >= 3);
}

// ---------------------------------------------------------------------------
// Cytowania (kontrakt structuredContent.citations - jak w stacku MateMatic)
// ---------------------------------------------------------------------------

interface Citation {
    title: string;
    url: string;
    snippet?: string;
    signature?: string;
    author?: string;
    date?: string;
    doc_id: string;
}

export function rowCitation(row: EurekaRow): Citation {
    const id = asText(row["ID_INFORMACJI"]) ?? "";
    const sig = asText(row["SYG"]);
    const teza = asText(row["TEZA"]);
    return {
        title: sig
            ? `Interpretacja indywidualna ${sig}`
            : `Interpretacja indywidualna #${id}`,
        url: DOC_UI_URL(id),
        ...(teza && { snippet: teza.slice(0, 240) }),
        ...(sig && { signature: sig }),
        ...(asText(row["AUTOR"]) && { author: asText(row["AUTOR"]) }),
        ...(trimDate(asText(row["DT_WYD"])) && {
            date: trimDate(asText(row["DT_WYD"])),
        }),
        doc_id: id,
    };
}

export function interpretationCitation(d: Interpretation): Citation {
    return {
        title: d.sygnatura
            ? `Interpretacja indywidualna ${d.sygnatura}`
            : `Interpretacja indywidualna #${d.id}`,
        url: DOC_UI_URL(d.id),
        ...(d.teza && { snippet: d.teza.slice(0, 240) }),
        ...(d.sygnatura && { signature: d.sygnatura }),
        ...(d.dataWydania && { date: d.dataWydania }),
        doc_id: d.id,
    };
}

// ---------------------------------------------------------------------------
// Formattery (czlowieko/LLM-czytelne)
// ---------------------------------------------------------------------------

// Zapytanie "wyglada na polskie, ale bez diakrytykow" - najczestsza cicha
// przyczyna zera trafien. EUREKA NIE normalizuje znakow: zmierzone 2026-07-31
// "podwyzszone koszty uzyskania" = 0 trafien, "podwyższone koszty uzyskania"
// = 293 077. Wykrywamy rdzenie, ktore po polsku prawie zawsze maja diakrytyk.
const ASCII_TRAP_RE =
    /\b(?:tworc\w*|dzialalnosc\w*|swiadcz\w*|uslug\w*|przychod\w*|koszt(?:ow|y)?\b|wynagrodzen\w*|podwyzszon\w*|zrodl\w*|rozwojow\w*|wlasnosc\w*|nieruchomosc\w*|dzialk\w*|sprzedaz\w*|obowiazk\w*|zwolnien\w*|badawczo)\b/i;

export function asciiTrapHint(query?: string): string | null {
    if (!query) return null;
    if (/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/.test(query)) return null; // diakrytyki obecne
    return ASCII_TRAP_RE.test(query)
        ? "UWAGA: zapytanie nie zawiera polskich znakow diakrytycznych, a EUREKA " +
              "ich NIE normalizuje - 'podwyzszone' daje 0 trafien, 'podwyższone' " +
              "ponad 290 tys. Powtorz zapytanie z poprawna pisownia (ą/ć/ę/ł/ń/ó/ś/ź/ż)."
        : null;
}

export function formatSearchResults(
    headline: string,
    resp: SearchResponse,
    query?: string,
): string {
    const rows = resp.results ?? [];
    if (rows.length === 0) {
        const hint = asciiTrapHint(query);
        return (
            headline +
            "\n\nBrak interpretacji indywidualnych dla podanych kryteriow." +
            (hint ? `\n\n${hint}` : "") +
            "\n\nPodpowiedzi: (1) uzyj 2-4 slow kluczowych zamiast calego zdania" +
            " - dluga frazy rozmywaja ranking; (2) sprawdz polskie znaki" +
            " diakrytyczne; (3) jesli uzyles fullPhrase=true, wylacz go;" +
            " (4) searchInContent=true ZAWEZA wyniki - sprobuj bez niego;" +
            " (5) sprobuj synonimu ('honorarium autorskie' vs '50% koszty uzyskania')."
        );
    }
    const total = resp.totalHits ?? rows.length;
    const lines = [headline];
    // totalHits jest MOCNO zawyzony: EUREKA dopasowuje rozmyto/po rdzeniach
    // (zmierzone: "aktor" = 14 322 trafien). Bez tego ostrzezenia model raportuje
    // te liczbe jako "tyle jest interpretacji w temacie", co jest nieprawda.
    lines.push(
        `Dopasowan wg EUREKI: ${total} (pokazano ${rows.length}, sortowanie: ${
            resp.sortMode ?? "trafnosc"
        }).`,
    );
    if (total > 1000) {
        lines.push(
            `[uwaga] ${total} to liczba ROZMYTYCH dopasowan wyszukiwarki, nie liczba` +
                " interpretacji na temat - EUREKA dopasowuje po rdzeniach slow." +
                " NIE podawaj jej uzytkownikowi jako liczby trafnych interpretacji." +
                " Oceniaj trafnosc po tezach ponizej.",
        );
    }
    lines.push("");
    for (const row of rows) {
        const id = asText(row["ID_INFORMACJI"]) ?? "?";
        const sig = asText(row["SYG"]) ?? "brak_sygnatury";
        const date = trimDate(asText(row["DT_WYD"])) ?? "?";
        const author = asText(row["AUTOR"]) ?? "";
        const teza = asText(row["TEZA"]) ?? "";
        lines.push(`[${id}] ${sig}`);
        lines.push(
            `  Data wyd.: ${date}${author ? ` | Organ: ${author}` : ""}`,
        );
        if (teza) lines.push(`  Teza: ${teza.slice(0, 280)}`);
        lines.push(`  Link: ${DOC_UI_URL(id)}`);
        lines.push(`  (pelna tresc: get_interpretation id="${id}")`);
        lines.push("");
    }
    if (total > rows.length) {
        lines.push(
            `[Dalsze dopasowania: ${total - rows.length}. Zwieksz pageNumber, zaweź` +
                " kryteria/daty albo zadaj kilka WEZSZYCH zapytan zamiast jednego" +
                " szerokiego - to skuteczniejsze niz przewijanie rankingu.]",
        );
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Nawigacja po tresci interpretacji
//
// Interpretacje KIS bywaja bardzo dlugie (90 tys. znakow to norma) i maja stala
// strukture: naglowek -> stan faktyczny -> pytanie -> stanowisko wnioskodawcy
// -> OCENA STANOWISKA + uzasadnienie organu -> pouczenie. Wartosc merytoryczna
// (dlaczego organ tak rozstrzygnal) siedzi w koncowce, wiec samo "pierwsze N
// znakow" jej NIGDY nie pokazuje. Stad: sekcje + offset, zeby model mogl
// skoczyc do uzasadnienia albo przewinac dokument dalej.
// ---------------------------------------------------------------------------

const TEXT_CHUNK_DEFAULT = 15000;
const TEXT_CHUNK_MAX = 50000;

export interface SectionHit {
    key: string;
    label: string;
    index: number;
}

// Kolejnosc = kolejnosc w dokumencie. Wzorce celowo waskie, zeby nie lapac
// tych samych slow uzytych w opisie wnioskodawcy (np. "uzasadnienie stanowiska
// Wnioskodawcy" nie jest uzasadnieniem ORGANU).
const SECTION_PATTERNS: { key: string; label: string; re: RegExp }[] = [
    {
        key: "stan_faktyczny",
        label: "Opis stanu faktycznego / zdarzenia przyszlego",
        re: /Opis\s+(?:stanu faktycznego|zdarzenia przysz|zdarzen|stan[uw])/i,
    },
    { key: "pytanie", label: "Pytanie(-a) wnioskodawcy", re: /\bPytani[ae]\b/ },
    {
        key: "stanowisko",
        label: "Stanowisko wnioskodawcy",
        re: /(?:Państwa stanowisko|Stanowisko Wnioskodawc\w+|Pana stanowisko|Pani stanowisko)/i,
    },
    {
        key: "uzasadnienie",
        label: "Ocena stanowiska + uzasadnienie organu",
        re: /(?:Ocena stanowiska|UZASADNIENIE interpretacji indywidualnej)/i,
    },
    {
        key: "rozstrzygniecie",
        label: "Informacja o zakresie rozstrzygniecia",
        re: /Informacja o zakresie rozstrzygni/i,
    },
    { key: "pouczenie", label: "Pouczenie", re: /\bPouczenie\b/ },
];

export const SECTION_KEYS = SECTION_PATTERNS.map((s) => s.key);

// Mapa dokumentu: gdzie zaczyna sie ktora sekcja. Model dostaje ja przy kazdym
// wywolaniu, wiec wie, o jaki fragment poprosic dalej.
//
// Skanujemy SEKWENCYJNIE (kazda sekcja szukana dopiero od konca poprzedniej),
// bo naglowek interpretacji powtarza slownictwo pozniejszych sekcji: formula
// otwierajaca "Pani stanowisko ... jest prawidlowe" stoi na ~80. znaku i bez
// wymuszenia kolejnosci przechwytywala kotwice sekcji 'stanowisko'.
// Sekcja nieznaleziona nie przesuwa kursora - brak jednej nie rozjezdza reszty.
export function findSections(text: string): SectionHit[] {
    const out: SectionHit[] = [];
    let cursor = 0;
    for (const s of SECTION_PATTERNS) {
        const m = s.re.exec(text.slice(cursor));
        if (m && m.index >= 0) {
            const index = cursor + m.index;
            out.push({ key: s.key, label: s.label, index });
            cursor = index + m[0].length;
        }
    }
    return out;
}

export interface TextView {
    section?: string;
    offset?: number;
    maxChars?: number;
}

export interface ContentSlice {
    text: string;
    start: number;
    end: number;
    total: number;
    limit: number;
    sections: SectionHit[];
    sectionUsed?: SectionHit;
    sectionMissing?: string;
    hasMore: boolean;
}

export function sliceContent(tresc: string, view: TextView = {}): ContentSlice {
    const total = tresc.length;
    const sections = findSections(tresc);
    const limit = Math.min(
        TEXT_CHUNK_MAX,
        Math.max(500, view.maxChars ?? TEXT_CHUNK_DEFAULT),
    );

    let base = 0;
    let sectionUsed: SectionHit | undefined;
    let sectionMissing: string | undefined;
    if (view.section) {
        const hit = sections.find((s) => s.key === view.section);
        if (hit) {
            base = hit.index;
            sectionUsed = hit;
        } else {
            sectionMissing = view.section; // brak sekcji -> od poczatku + ostrzezenie
        }
    }

    const start = Math.min(total, Math.max(0, base + (view.offset ?? 0)));
    const end = Math.min(total, start + limit);
    return {
        text: tresc.slice(start, end),
        start,
        end,
        total,
        limit,
        sections,
        sectionUsed,
        sectionMissing,
        hasMore: end < total,
    };
}

export function formatInterpretation(d: Interpretation, view: TextView = {}): string {
    const lines = [
        "=== INTERPRETACJA INDYWIDUALNA (KIS / EUREKA) ===",
        "",
        `Sygnatura : ${d.sygnatura ?? "?"}`,
        `ID        : ${d.id}`,
        `Rodzaj    : ${d.kategoria ?? "Interpretacja indywidualna"}`,
        `Data wyd. : ${d.dataWydania ?? "?"}`,
        `Data publ.: ${d.dataPublikacji ?? "?"}`,
    ];
    if (d.teza) lines.push("", `Teza: ${d.teza}`);
    lines.push("", `URL: ${DOC_UI_URL(d.id)}`);

    if (!d.tresc) return lines.join("\n");

    const s = sliceContent(d.tresc, view);

    if (s.sections.length > 0) {
        lines.push("", "--- Mapa dokumentu (znak poczatkowy sekcji) ---");
        for (const sec of s.sections) {
            lines.push(`  ${String(sec.index).padStart(7)}  [${sec.key}] ${sec.label}`);
        }
    }
    if (s.sectionMissing) {
        lines.push(
            "",
            `[uwaga] Nie znaleziono sekcji '${s.sectionMissing}' w tym dokumencie - ` +
                `pokazuje od poczatku. Dostepne sekcje: mapa powyzej.`,
        );
    }

    const where = s.sectionUsed
        ? ` | sekcja: [${s.sectionUsed.key}] ${s.sectionUsed.label}`
        : "";
    lines.push(
        "",
        `--- Tresc: znaki ${s.start}-${s.end} z ${s.total} lacznie${where} ---`,
        s.text,
    );

    if (s.hasMore) {
        lines.push(
            "",
            `[...] To FRAGMENT (${s.end - s.start} z ${s.total} znakow). Dalszy ciag: ` +
                `get_interpretation id="${d.id}" offset=${s.end}. ` +
                `Uzasadnienie organu: get_interpretation id="${d.id}" section="uzasadnienie". ` +
                `Calosc w przegladarce: ${DOC_UI_URL(d.id)}`,
        );
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `Ten serwer MCP udostepnia polskie INTERPRETACJE INDYWIDUALNE prawa podatkowego wydawane przez Dyrektora Krajowej Informacji Skarbowej (KIS), przez publiczne API systemu EUREKA Ministerstwa Finansow (eureka.mf.gov.pl). To codzienny material doradcy podatkowego: ulga B+R, IP Box, VAT, CIT, PIT, podatek u zrodla, etc.

## Kolejnosc wywolan

### Szukanie po sygnaturze
1. \`search_by_signature\` - po sygnaturze KIS (np. "0115-KDST2-2.4011.218.2026.2.KK"). Najszybciej.

### Szerokie szukanie
2. \`search\` - po słowach kluczowych (query), z opcjonalnym zakresem dat (dateFrom/dateTo, YYYY-MM-DD), flagami searchInContent i fullPhrase (obie ZAWĘŻAJĄ) oraz sort (domyślnie trafność). Zwraca listę z sygnaturą, organem, datą i tezą.
3. \`suggest\` - podpowiedzi fraz, gdy zapytanie jest niejednoznaczne.

## Jak pytać, żeby trafiać (recall i precyzja)

Wyszukiwarka EUREKI to Elasticsearch z rozmytym dopasowaniem po rdzeniach słów. Zmierzone zachowania, których musisz być świadomy:

- **PISZ Z POLSKIMI ZNAKAMI.** EUREKA NIE normalizuje diakrytyków. "podwyzszone koszty uzyskania" = **0 trafień**, "podwyższone koszty uzyskania" = **293 077**. To najczęstsza cicha przyczyna pustego wyniku. Zawsze: ą, ć, ę, ł, ń, ó, ś, ź, ż.
- **2-4 słowa kluczowe, nie całe zdanie.** Długie frazy rozmywają ranking ("aktor" 14 322 → "50% koszty uzyskania przychodu twórca aktor" 2 342, ale z gorszym dopasowaniem czołówki).
- **Kilka wąskich zapytań bije jedno szerokie.** Pytanie o 50% KUP dla aktorów: osobno "honorarium autorskie aktor", "prawa pokrewne artysty wykonawcy", "50% koszty uzyskania przychodów twórca". Terminologia KIS bywa inna niż potoczna - sprawdź warianty, zanim uznasz, że interpretacji nie ma.
- **Liczba dopasowań jest zawyżona.** "aktor" daje 14 322 dopasowań, co NIE znaczy 14 322 interpretacji o aktorach. Nigdy nie podawaj tej liczby użytkownikowi jako liczby trafnych interpretacji - oceniaj trafność po tezach.
- **Sortowanie: zostaw domyślną trafność.** \`sort="data_desc"\` przy tysiącach dopasowań zwraca najnowsze, a nie trafne - używaj go wyłącznie, gdy pytanie wprost dotyczy aktualności.
- **searchInContent i fullPhrase zawężają**, nie poszerzają. Gdy masz za mało wyników - wyłącz je. Gdy za dużo szumu - włącz.
- **Zero wyników to zwykle wada zapytania, nie brak interpretacji.** Zanim odpowiesz "nie ma", spróbuj: diakrytyki, krótsze zapytanie, synonim, \`suggest\`.

### Tresc interpretacji
4. \`get_interpretation\` - po ID (z wynikow search) zwraca metadane, teze i FRAGMENT tresci (domyslnie 15000 znakow od poczatku) + mape sekcji z pozycjami znakowymi.

**KLUCZOWE: jedno wywolanie to nie caly dokument.** Interpretacje KIS maja czesto 50-100 tys. znakow i stala strukture: naglowek -> stan faktyczny -> pytanie -> stanowisko wnioskodawcy -> **ocena stanowiska i uzasadnienie organu** -> pouczenie. Uzasadnienie organu (czyli DLACZEGO organ tak rozstrzygnal - zwykle jedyne, co ma wartosc dla doradcy) lezy ok. 60-70% dlugosci dokumentu, wiec domyslny fragment od poczatku go NIE zawiera.

- Pytanie o argumentacje/uzasadnienie/podstawe rozstrzygniecia -> \`get_interpretation(id, section="uzasadnienie")\`, NIE samo \`get_interpretation(id)\`.
- Dalszy ciag fragmentu -> \`offset\` z wartoscia podana w komunikacie \`[...]\` (albo \`next_offset\` w structuredContent).
- Sam werdykt (prawidlowe/nieprawidlowe) jest w formule otwierajacej, wiec widac go od razu - ale NIE myl werdyktu z uzasadnieniem.
- Jesli cytujesz uzasadnienie, upewnij sie, ze faktycznie pobrales sekcje \`uzasadnienie\` - nie zgaduj argumentacji organu ze stanu faktycznego.

## Twarde ograniczenia

- **Zakres: tylko interpretacje indywidualne.** Nie obejmuje interpretacji ogolnych, objasnien podatkowych ani WIS.
- **Interpretacja chroni TYLKO wnioskodawce** i tylko w jego stanie faktycznym. Cytujac, zaznaczaj, ze to interpretacja w indywidualnej sprawie - nie zrodlo prawa i nie linia "orzecznicza" sensu stricto.
- **Nieoficjalne API** - throttling wbudowany, nie wysylaj burstow.
- **\`structuredContent.citations\`** zawsze: title, url (informacje/podglad/{id}), signature, date, doc_id.
- **Bez modyfikacji tresci** - integralna kopia z EUREKI.

## Iteracja po bledach

Tool zwraca \`isError: true\` + tekst z prefiksem \`[code]\`:
- \`missing_arg\` - brak wymaganego argumentu (id / signature / query).
- \`not_found\` - brak dokumentu/wynikow. Sprobuj innego query lub searchInContent=true.
- \`upstream_error\` - blad EUREKI (HTTP/timeout). Retry raz przed surface do uzytkownika.
- \`api_changed\` - struktura odpowiedzi EUREKI odbiega od znanego kontraktu (MF przebudowalo nieoficjalne API). NIE ponawiaj - przekaz uzytkownikowi, ze konektor wymaga aktualizacji.

## Styl odpowiedzi

- Cytuj z sygnaturą i datą: "0115-KDST2-2.4011.218.2026.2.KK (interpretacja indywidualna, 2026-06-01)".
- NIE wymyślaj sygnatur - wszystko z \`structuredContent.citations\`.
- Cytuj wyłącznie fragmenty, które FAKTYCZNIE pobrałeś. Jeśli przywołujesz argumentację organu, najpierw pobierz \`section="uzasadnienie"\` - teza i werdykt nie wystarczą do zreferowania uzasadnienia.
- Rozróżniaj: teza (streszczenie redakcyjne), werdykt (prawidłowe/nieprawidłowe) i uzasadnienie (wywód organu). To trzy różne rzeczy.
- Powiedz użytkownikowi, na ilu interpretacjach opierasz wniosek i że przeszukanie nie jest wyczerpujące - EUREKA zwraca ranking, nie komplet.
- Dla zestawień sortuj chronologicznie i zaznaczaj rozbieżności w stanowisku organu.`;

// ---------------------------------------------------------------------------
// Definicje narzedzi
// ---------------------------------------------------------------------------

const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: true,
} as const;

const TOOLS = [
    {
        name: "search",
        annotations: READ_ONLY_ANNOTATIONS,
        description:
            "Przeszukuje polskie INTERPRETACJE INDYWIDUALNE (Dyrektor KIS) w systemie " +
            "EUREKA (eureka.mf.gov.pl). Material doradcy podatkowego: ulga B+R, IP Box, " +
            "VAT, CIT, PIT, WHT, etc. Domyslnie szuka w tezie i metadanych; ustaw " +
            "searchInContent=true, by szukac w pelnej tresci. Zwraca liste z sygnatura " +
            "(SYG), organem, data wydania i teza. Pelna tresc -> get_interpretation.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description:
                        "Slowa kluczowe, np. 'ulga badawczo-rozwojowa koszty kwalifikowane' albo 'IP Box autorskie prawo'.",
                },
                dateFrom: {
                    type: "string",
                    description: "Data wydania od (YYYY-MM-DD).",
                },
                dateTo: {
                    type: "string",
                    description: "Data wydania do (YYYY-MM-DD).",
                },
                searchInContent: {
                    type: "boolean",
                    description:
                        "true = wymagaj dopasowania w pelnej tresci. To ZAWEZA wyniki " +
                        "(zmierzone: 'Angola' 102 -> 37 trafien), wiec sluzy precyzji, " +
                        "NIE zwiekszaniu liczby wynikow. Domyslnie false.",
                },
                fullPhrase: {
                    type: "boolean",
                    description:
                        "true = cala fraza musi wystapic DOKLADNIE. Mocno zaweza " +
                        "('art. 22b': 120 tys. -> 4 tys.). Przydatne do przepisow " +
                        "i utartych zwrotow. Domyslnie false = slowa niezaleznie.",
                },
                sort: {
                    type: "string",
                    enum: ["trafnosc", "data_desc", "data_asc"],
                    description:
                        "Kolejnosc wynikow. 'trafnosc' (DOMYSLNE) = ranking dopasowania " +
                        "- prawie zawsze tego chcesz. 'data_desc' = najnowsze pierwsze; " +
                        "uzywaj TYLKO gdy pytanie dotyczy aktualnosci ('najnowsze " +
                        "interpretacje o...'), bo przy tysiacach dopasowan zwraca " +
                        "najswiezsze zamiast trafnych. 'data_asc' = najstarsze.",
                },
                pageSize: {
                    type: "number",
                    description: "Liczba wynikow (1-50). Domyslnie 10.",
                    minimum: 1,
                    maximum: 50,
                },
                pageNumber: {
                    type: "number",
                    description: "Numer strony (od 1). Do paginacji.",
                    minimum: 1,
                },
            },
            required: ["query"],
        },
    },
    {
        name: "get_interpretation",
        annotations: READ_ONLY_ANNOTATIONS,
        description:
            "Pobiera interpretacje indywidualna po ID (z wynikow 'search'): metadane " +
            "(sygnatura, daty, teza) + FRAGMENT tresci. Interpretacje KIS bywaja bardzo " +
            "dlugie (90 tys. znakow to norma), wiec tresc zwracana jest porcjami po " +
            "15000 znakow - jedno wywolanie to NIE caly dokument. " +
            "UWAGA: uzasadnienie organu jest na KONCU dokumentu, wiec domyslny fragment " +
            "od poczatku go NIE zawiera - uzyj section='uzasadnienie'. " +
            "Kazda zwrotka zawiera mape sekcji z pozycjami znakowymi; dalsze partie " +
            "pobierz przez offset. Bledy: `missing_arg`, `not_found`, `api_changed`.",
        inputSchema: {
            type: "object",
            properties: {
                id: {
                    type: "string",
                    description:
                        "ID interpretacji (ID_INFORMACJI) z wynikow search, np. '694514'.",
                },
                section: {
                    type: "string",
                    enum: [
                        "stan_faktyczny",
                        "pytanie",
                        "stanowisko",
                        "uzasadnienie",
                        "rozstrzygniecie",
                        "pouczenie",
                    ],
                    description:
                        "Skok do sekcji dokumentu. NAJWAZNIEJSZE: 'uzasadnienie' = " +
                        "ocena stanowiska i argumentacja organu (to zwykle jedyne, " +
                        "czego szuka doradca; lezy ok. 60-70% dlugosci dokumentu, " +
                        "wiec bez tego parametru pozostaje poza zasiegiem). " +
                        "Bez tego parametru: od poczatku dokumentu.",
                },
                offset: {
                    type: "number",
                    description:
                        "Przesuniecie w znakach. Bez 'section' - od poczatku dokumentu; " +
                        "z 'section' - wzgledem poczatku tej sekcji. Do przewijania " +
                        "dlugich fragmentow (uzyj wartosci podanej w komunikacie [...]).",
                    minimum: 0,
                },
                maxChars: {
                    type: "number",
                    description:
                        "Ile znakow tresci zwrocic (500-50000). Domyslnie 15000. " +
                        "Zwiekszaj ostroznie - 50000 znakow to ok. 15 tys. tokenow.",
                    minimum: 500,
                    maximum: 50000,
                },
            },
            required: ["id"],
        },
    },
    {
        name: "search_by_signature",
        annotations: READ_ONLY_ANNOTATIONS,
        description:
            "Skrot: szuka interpretacji po sygnaturze KIS, np. " +
            "'0115-KDST2-2.4011.218.2026.2.KK'. Odpowiednik search z fraza = sygnatura.",
        inputSchema: {
            type: "object",
            properties: {
                signature: {
                    type: "string",
                    description:
                        "Sygnatura interpretacji KIS, np. '0115-KDST2-2.4011.218.2026.2.KK'.",
                },
            },
            required: ["signature"],
        },
    },
    {
        name: "suggest",
        annotations: READ_ONLY_ANNOTATIONS,
        description:
            "Podpowiedzi fraz (autocomplete) z EUREKI dla czesciowego zapytania - " +
            "pomaga doprecyzowac slowa kluczowe przed wlasciwym search.",
        inputSchema: {
            type: "object",
            properties: {
                phrase: {
                    type: "string",
                    description: "Czesciowa fraza, np. 'ulga na'.",
                },
            },
            required: ["phrase"],
        },
    },
] as const;

// ---------------------------------------------------------------------------
// Setup serwera MCP
// ---------------------------------------------------------------------------

type ErrorCode = "missing_arg" | "not_found" | "upstream_error" | "api_changed";

function errorResult(text: string, code: ErrorCode) {
    return {
        content: [{ type: "text" as const, text: `[${code}] ${text}` }],
        structuredContent: { error_code: code },
        isError: true,
    };
}

const server = new Server(
    { name: "mcp-eureka", version: "1.3.0" }, // sync z package.json "version"
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
    })),
}));

async function handleSearch(headline: string, params: SearchParams) {
    const resp = await eurekaSearch(params);
    const drift = searchDriftError(resp);
    if (drift) return errorResult(`${drift}. ${API_CHANGED_HINT}`, "api_changed");
    resp.sortMode = params.sort ?? "trafnosc";
    return {
        content: [
            {
                type: "text",
                text: formatSearchResults(headline, resp, params.query),
            },
        ],
        structuredContent: {
            citations: (resp.results ?? []).map(rowCitation),
            total_hits: resp.totalHits ?? (resp.results ?? []).length,
            fuzzy_total: true, // totalHits = rozmyte dopasowania, nie trafne wyniki
            sort: resp.sortMode,
            ...(asciiTrapHint(params.query) && {
                query_warning: asciiTrapHint(params.query),
            }),
        },
    };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
        switch (name) {
            case "search": {
                if (!a.query || typeof a.query !== "string") {
                    return errorResult("parametr 'query' jest wymagany.", "missing_arg");
                }
                if (
                    a.sort !== undefined &&
                    (typeof a.sort !== "string" || !SORT_KEYS.includes(a.sort as SortMode))
                ) {
                    return errorResult(
                        `parametr 'sort' musi byc jedna z wartosci: ${SORT_KEYS.join(", ")}.`,
                        "missing_arg",
                    );
                }
                const headline = `Wynik search(query="${a.query}", daty=${a.dateFrom ?? "*"}..${a.dateTo ?? "*"}, wTresci=${a.searchInContent === true}, calaFraza=${a.fullPhrase === true}, sort=${a.sort ?? "trafnosc"}):`;
                return await handleSearch(headline, {
                    query: a.query,
                    dateFrom:
                        typeof a.dateFrom === "string" ? a.dateFrom : undefined,
                    dateTo: typeof a.dateTo === "string" ? a.dateTo : undefined,
                    searchInContent:
                        typeof a.searchInContent === "boolean"
                            ? a.searchInContent
                            : undefined,
                    fullPhrase:
                        typeof a.fullPhrase === "boolean"
                            ? a.fullPhrase
                            : undefined,
                    sort: typeof a.sort === "string" ? (a.sort as SortMode) : undefined,
                    pageSize:
                        typeof a.pageSize === "number" ? a.pageSize : undefined,
                    pageNumber:
                        typeof a.pageNumber === "number"
                            ? a.pageNumber
                            : undefined,
                });
            }

            case "search_by_signature": {
                if (!a.signature || typeof a.signature !== "string") {
                    return errorResult(
                        "parametr 'signature' jest wymagany.",
                        "missing_arg",
                    );
                }
                return await handleSearch(
                    `Wynik search_by_signature(signature="${a.signature}"):`,
                    { signature: a.signature, pageSize: 10 },
                );
            }

            case "get_interpretation": {
                if (!a.id || typeof a.id !== "string") {
                    return errorResult("parametr 'id' jest wymagany.", "missing_arg");
                }
                const { safe, doc } = await eurekaGetDoc(a.id);
                const drift = detailDriftError(doc);
                if (drift) {
                    return errorResult(`${drift}. ${API_CHANGED_HINT}`, "api_changed");
                }
                const d = parseInterpretation(doc, safe);
                if (!d.sygnatura && !d.teza && !d.tresc) {
                    return errorResult(
                        `Brak interpretacji o ID '${a.id}' w EUREKA (albo to nie interpretacja indywidualna).`,
                        "not_found",
                    );
                }
                if (
                    a.section !== undefined &&
                    (typeof a.section !== "string" || !SECTION_KEYS.includes(a.section))
                ) {
                    return errorResult(
                        `parametr 'section' musi byc jedna z wartosci: ${SECTION_KEYS.join(", ")}.`,
                        "missing_arg",
                    );
                }
                const view: TextView = {
                    section: typeof a.section === "string" ? a.section : undefined,
                    offset: typeof a.offset === "number" ? a.offset : undefined,
                    maxChars: typeof a.maxChars === "number" ? a.maxChars : undefined,
                };
                const slice = d.tresc ? sliceContent(d.tresc, view) : undefined;
                // Tresc TAKZE w structuredContent: niektorzy klienci (m.in.
                // konektory claude.ai) pokazuja modelowi wylacznie
                // structuredContent - bez tego tresc ginela, mimo ze byla w
                // content[0].text (zaobserwowane live 2026-07-28).
                return {
                    content: [
                        { type: "text", text: formatInterpretation(d, view) },
                    ],
                    structuredContent: {
                        citations: [interpretationCitation(d)],
                        interpretation: {
                            id: d.id,
                            signature: d.sygnatura,
                            category: d.kategoria,
                            issue_date: d.dataWydania,
                            publication_date: d.dataPublikacji,
                            thesis: d.teza,
                            content_chunk: slice?.text,
                            content_range: slice
                                ? { start: slice.start, end: slice.end, total: slice.total }
                                : undefined,
                            content_total_chars: d.tresc?.length ?? 0,
                            has_more: slice?.hasMore ?? false,
                            next_offset: slice?.hasMore ? slice.end : undefined,
                            sections: slice?.sections,
                            url: DOC_UI_URL(d.id),
                        },
                    },
                };
            }

            case "suggest": {
                if (!a.phrase || typeof a.phrase !== "string") {
                    return errorResult(
                        "parametr 'phrase' jest wymagany.",
                        "missing_arg",
                    );
                }
                const raw = await eurekaSuggest(a.phrase);
                const sdrift = suggestDriftError(raw);
                if (sdrift) {
                    return errorResult(`${sdrift}. ${API_CHANGED_HINT}`, "api_changed");
                }
                const sugg = parseSuggestions(raw);
                const text =
                    sugg.length > 0
                        ? `Podpowiedzi dla "${a.phrase}":\n- ` + sugg.join("\n- ")
                        : `Brak podpowiedzi dla "${a.phrase}".`;
                return {
                    content: [{ type: "text", text }],
                    structuredContent: { suggestions: sugg },
                };
            }

            default:
                return errorResult(`Nieznane narzedzie: ${name}`, "missing_arg");
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/HTTP 404|not found/i.test(msg)) {
            return errorResult(`Nie znaleziono w EUREKA: ${msg}.`, "not_found");
        }
        return errorResult(
            `Blad komunikacji z EUREKA (eureka.mf.gov.pl): ${msg}. Sprobuj ponownie za chwile.`,
            "upstream_error",
        );
    }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("mcp-eureka server started (stdio transport)\n");
}

// Start tylko przy bezposrednim uruchomieniu - testy importuja funkcje
// z tego modulu (parseInterpretation, *DriftError, formattery) bez stdio.
if (require.main === module) {
    main().catch((err) => {
        process.stderr.write(`Fatal error: ${err}\n`);
        process.exit(1);
    });
}
