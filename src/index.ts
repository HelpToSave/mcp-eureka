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
//   - get_interpretation - pelna tresc interpretacji po ID
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

// Sort: ID rosnie chronologicznie -> DESC = najnowsze pierwsze (pewny, dziala).
const SORT_SPEC = "ID_INFORMACJI,DESC";

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
    return s
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) =>
            String.fromCharCode(parseInt(n, 16)),
        );
}

function stripHtml(s: string): string {
    return decodeEntities(
        s
            .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*>/gi, "\n")
            .replace(/<[^>]+>/g, " "),
    )
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .trim();
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
    pageSize?: number;
    pageNumber?: number;
}

type EurekaRow = Record<string, string | string[]>;

interface SearchResponse {
    results?: EurekaRow[];
    totalHits?: number;
    elasticDocumentId?: string;
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
        searchInFullPhrase: false,
        searchInContent: p.searchInContent ?? false,
        searchInSynonyms: false,
        searchQuery: p.query ?? "",
        additionalParameters: {},
        warunkiDodatkowe: [],
    };
    const size = Math.min(50, Math.max(1, p.pageSize ?? 10));
    const page = Math.max(0, (p.pageNumber ?? 1) - 1);

    return throttled(() =>
        httpJson<SearchResponse>({
            method: "POST",
            path: "/wyszukiwarka/informacje",
            query: { size, page, sort: SORT_SPEC },
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

async function eurekaGetInterpretation(id: string): Promise<Interpretation> {
    const safe = id.replace(/[^0-9]/g, "");
    if (!safe) throw new Error("invalid id");
    const doc = await throttled(() =>
        httpJson<DocResponse>({ method: "GET", path: `/informacje/${safe}` }),
    );
    const map = new Map<string, string | string[]>();
    for (const f of doc.dokument?.fields ?? []) map.set(f.key, f.value);

    const trescRaw = asText(map.get("TRESC_INTERESARIUSZ")) ?? "";
    return {
        id: safe,
        sygnatura: asText(map.get("SYG")),
        kategoria: doc.nazwa,
        dataWydania: trimDate(asText(map.get("DT_WYD"))),
        dataPublikacji: trimDate(asText(map.get("DATA_PUBLIKACJI"))),
        teza: asText(map.get("TEZA")),
        tresc: trescRaw ? stripHtml(trescRaw) : undefined,
    };
}

// ---------------------------------------------------------------------------
// Podpowiedzi
// ---------------------------------------------------------------------------

interface SuggestResponse {
    results?: { suggestion: string }[];
}

async function eurekaSuggest(phrase: string): Promise<string[]> {
    const enc = encodeURIComponent(phrase);
    const r = await throttled(() =>
        httpJson<SuggestResponse>({
            method: "GET",
            path: `/wyszukiwarka/sugestie/${enc}`,
        }),
    );
    // Odsiej smieci (np. "," tokeny) - zostaw frazy z min. 3 literami.
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

function rowCitation(row: EurekaRow): Citation {
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

function interpretationCitation(d: Interpretation): Citation {
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

function formatSearchResults(
    headline: string,
    resp: SearchResponse,
): string {
    const rows = resp.results ?? [];
    if (rows.length === 0) {
        return (
            headline +
            "\n\nBrak interpretacji indywidualnych dla podanych kryteriow." +
            "\n\nPodpowiedz: sprobuj innych slow kluczowych, ustaw searchInContent=true" +
            " (szukanie w pelnej tresci, nie tylko w tezie), albo poszerz zakres dat."
        );
    }
    const lines = [
        headline,
        `Znaleziono: ${resp.totalHits ?? rows.length} interpretacji (pokazano ${rows.length}).`,
        "",
    ];
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
    const total = resp.totalHits ?? rows.length;
    if (total > rows.length) {
        lines.push(
            `[Wiecej wynikow: ${total - rows.length}. Zwieksz pageNumber lub zaweż kryteria / daty.]`,
        );
    }
    return lines.join("\n");
}

function formatInterpretation(d: Interpretation): string {
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
    if (d.tresc) {
        const preview = d.tresc.slice(0, 4000);
        lines.push(
            "",
            `--- Tresc (pierwsze 4000 znakow z ${d.tresc.length} lacznie) ---`,
            preview,
        );
        if (d.tresc.length > 4000) {
            lines.push(`[...] Skrocono. Pelna tresc: ${DOC_UI_URL(d.id)}`);
        }
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
2. \`search\` - po slowach kluczowych (query), z opcjonalnym zakresem dat (dateFrom/dateTo, YYYY-MM-DD) i flaga searchInContent (true = szukaj w pelnej tresci, nie tylko w tezie). Zwraca liste z sygnatura, organem, data i teza.
3. \`suggest\` - podpowiedzi fraz, gdy zapytanie jest niejednoznaczne.

### Pelna tresc
4. \`get_interpretation\` - po ID (z wynikow search) zwraca metadane + pelna tresc (pytanie wnioskodawcy, jego stanowisko, ocena organu, uzasadnienie) - pierwsze 4000 znakow.

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

## Styl odpowiedzi

- Cytuj z sygnatura i data: "0115-KDST2-2.4011.218.2026.2.KK (interpretacja indywidualna, 2026-06-01)".
- NIE wymyslaj sygnatur - wszystko z \`structuredContent.citations\`.
- Dla zestawien sortuj chronologicznie i zaznaczaj rozbieznosci w stanowisku organu.`;

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
                        "true = szukaj w pelnej tresci interpretacji (nie tylko w tezie). Domyslnie false.",
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
            "Pobiera pelna interpretacje indywidualna po ID (z wynikow 'search'). " +
            "Zwraca metadane (sygnatura, data wydania/publikacji, teza) oraz pelna " +
            "tresc (stan faktyczny, stanowisko wnioskodawcy, ocena organu, uzasadnienie) " +
            "- pierwsze 4000 znakow.",
        inputSchema: {
            type: "object",
            properties: {
                id: {
                    type: "string",
                    description:
                        "ID interpretacji (ID_INFORMACJI) z wynikow search, np. '694514'.",
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

type ErrorCode = "missing_arg" | "not_found" | "upstream_error";

function errorResult(text: string, code: ErrorCode) {
    return {
        content: [{ type: "text" as const, text: `[${code}] ${text}` }],
        structuredContent: { error_code: code },
        isError: true,
    };
}

const server = new Server(
    { name: "mcp-eureka", version: "1.0.0" },
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
    return {
        content: [
            { type: "text", text: formatSearchResults(headline, resp) },
        ],
        structuredContent: {
            citations: (resp.results ?? []).map(rowCitation),
            total_hits: resp.totalHits ?? (resp.results ?? []).length,
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
                const headline = `Wynik search(query="${a.query}", daty=${a.dateFrom ?? "*"}..${a.dateTo ?? "*"}, wTresci=${a.searchInContent === true}):`;
                return await handleSearch(headline, {
                    query: a.query,
                    dateFrom:
                        typeof a.dateFrom === "string" ? a.dateFrom : undefined,
                    dateTo: typeof a.dateTo === "string" ? a.dateTo : undefined,
                    searchInContent:
                        typeof a.searchInContent === "boolean"
                            ? a.searchInContent
                            : undefined,
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
                const d = await eurekaGetInterpretation(a.id);
                if (!d.sygnatura && !d.teza && !d.tresc) {
                    return errorResult(
                        `Brak interpretacji o ID '${a.id}' w EUREKA (albo to nie interpretacja indywidualna).`,
                        "not_found",
                    );
                }
                return {
                    content: [
                        { type: "text", text: formatInterpretation(d) },
                    ],
                    structuredContent: {
                        citations: [interpretationCitation(d)],
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
                const sugg = await eurekaSuggest(a.phrase);
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

main().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
});
