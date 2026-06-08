# mcp-eureka

MCP server dla polskich **interpretacji indywidualnych** (Dyrektor Krajowej
Informacji Skarbowej) przez **publiczne API systemu EUREKA** Ministerstwa
Finansów (`eureka.mf.gov.pl`).

## Po co

Ani SAOS, ani CBOSA nie udostępniają interpretacji indywidualnych prawa
podatkowego. A to codzienny materiał doradcy: **ulga B+R, IP Box, VAT, CIT, PIT,
podatek u źródła**. `mcp-eureka` daje Claude'owi dostęp do realnych interpretacji
— z sygnaturą, tezą, treścią i linkiem — zamiast zgadywania z pamięci.

**Zakres:** tylko interpretacje indywidualne (`KATEGORIA_INFORMACJI = 1`).

## Tooly

- **`search(query, dateFrom?, dateTo?, searchInContent?, pageSize?, pageNumber?)`**
  — wyszukiwanie po słowach kluczowych. Domyślnie w tezie/metadanych;
  `searchInContent=true` szuka w pełnej treści. Zwraca top-N z sygnaturą (SYG),
  organem, datą wydania i tezą.
- **`get_interpretation(id)`** — pełna interpretacja po `ID_INFORMACJI`
  (stan faktyczny, stanowisko wnioskodawcy, ocena organu, uzasadnienie),
  pierwsze 4000 znaków. Treść jest oczyszczana z HTML i **sklejana w płynne
  akapity** (`reflowText`) — bez „porozrywanych" pojedynczych wierszy.
- **`search_by_signature(signature)`** — skrót: szukaj po sygnaturze KIS
  (np. `0115-KDST2-2.4011.218.2026.2.KK`).
- **`suggest(phrase)`** — podpowiedzi fraz (autocomplete).

Każda zwrotka zawiera `structuredContent.citations`:
`title`, `url` (`eureka.mf.gov.pl/informacje/podglad/{id}`), `signature`, `date`,
`author`, `snippet`, `doc_id`.

## Stack

- Node 18+, stdio, `@modelcontextprotocol/sdk`
- `https` + czyste **JSON API REST** (bez scrapowania HTML)
- Bez klucza API, bez logowania. Throttle ~350 ms (≈3 req/s).
- Ważny certyfikat SSL (brak `rejectUnauthorized:false`).

## Kontrakt API (nieoficjalny, odtworzony 2026-06)

Baza: `https://eureka.mf.gov.pl/api/public/v1`

- `POST /wyszukiwarka/informacje?size=&page=&sort=ID_INFORMACJI,DESC`
  body: `{ filter:{KATEGORIA_INFORMACJI:[1]}, columns:[...], searchQuery, searchInContent, ... }`
- `GET /informacje/{id}` → pełny dokument (`dokument.fields[]`: SYG, TEZA, DT_WYD, TRESC_INTERESARIUSZ, …)
- `GET /wyszukiwarka/sugestie/{fraza}` → podpowiedzi
- `GET /parametry-wyszukiwarki/all` → słowniki filtrów (fasety)

To **nieoficjalne** API SPA — może się zmienić bez zapowiedzi.

## Build + uruchomienie

```bash
npm install
npm run build
node dist/index.js   # serwer na stdio
```

## Smoke test

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"s","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"ulga badawczo-rozwojowa koszty kwalifikowane","pageSize":5}}}' \
  | node dist/index.js
```

## Skrypt pomocniczy: porządkowanie plików `.md`

`scripts/format-md.mjs` skleja „porozrywany" tekst interpretacji zapisany do pliku
Markdown (każda wizualna linia źródła bywa osobnym łamaniem) w płynne akapity,
zachowując wypunktowania. Działa **wyłącznie** na sekcji pod nagłówkiem
`## Pełna treść`; nagłówek z metadanymi pozostaje nietknięty. Bez zależności,
czysty Node (UTF-8 natywnie).

```bash
node scripts/format-md.mjs sciezka/do/pliku.md      # jeden plik
node scripts/format-md.mjs sciezka/do/folderu        # wszystkie .md w folderze
```

## Konfiguracja w Claude Code

W `.mcp.json` projektu (obok innych serwerów). Podaj ścieżkę do `dist/index.js`:

```json
{
  "mcpServers": {
    "eureka": {
      "command": "node",
      "args": ["/sciezka/do/mcp-eureka/dist/index.js"]
    }
  }
}
```

> **Windows:** jeśli `node` nie jest w PATH, podaj pełną ścieżkę do `node.exe`, np.
> `"command": "C:\\Program Files\\nodejs\\node.exe"` oraz
> `"args": ["C:\\Users\\TwojUser\\mcp-servers\\mcp-eureka\\dist\\index.js"]`.

## Uwaga prawna

Interpretacja indywidualna chroni **tylko wnioskodawcę** i tylko w jego stanie
faktycznym. To nie źródło prawa ani linia orzecznicza sensu stricto. Cytuj z tą
świadomością.

## Podziękowania

Architektura (transport stdio, kontrakt `structuredContent.citations`, układ tooli
i obsługa błędów) wzorowana na **`mcp-nsa`** autorstwa **Wiesława Mazura** — zestawie
konektorów MateMatic do polskiego orzecznictwa. `mcp-eureka` domyka warstwę krajową
o interpretacje indywidualne KIS, których ten zestaw nie obejmował.

## Licencja

MIT © 2026 Mateusz Bednarski. Zobacz [LICENSE](LICENSE).
