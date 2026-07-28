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

## Instalacja jednym poleceniem (Claude Code)

```bash
claude mcp add eureka -- npx -y github:HelpToSave/mcp-eureka
```

> **Windows:** jeśli `npx` nie odpala się bezpośrednio, użyj
> `claude mcp add eureka -- cmd /c "npx -y github:HelpToSave/mcp-eureka"`.
> Wymagany Node 18+ i git w PATH; pierwsze uruchomienie buduje serwer
> (skrypt `prepare`).

## Tooly

- **`search(query, dateFrom?, dateTo?, searchInContent?, fullPhrase?, pageSize?, pageNumber?)`**
  — wyszukiwanie po słowach kluczowych. Domyślnie w tezie/metadanych;
  `searchInContent=true` szuka w pełnej treści; `fullPhrase=true` wymaga
  wystąpienia **całej frazy dokładnie** (przydatne do przepisów, np.
  `"art. 22b ustawy"` — domyślne dopasowanie traktuje słowa niezależnie).
  Zwraca top-N z sygnaturą (SYG), organem, datą wydania i tezą.
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

`get_interpretation` dodatkowo zwraca `structuredContent.interpretation`
(sygnatura, daty, teza, `content_preview`, `content_total_chars`, url) — bo
część klientów MCP (m.in. konektory claude.ai) pokazuje modelowi **wyłącznie**
`structuredContent`; bez tego pełna treść ginęła mimo obecności w `content`.

## Bezpiecznik na dryf API (`api_changed`)

API EUREKI jest nieoficjalne i może się zmienić bez zapowiedzi. Konektor
waliduje strukturę każdej odpowiedzi: gdy znikną krytyczne pola
(`ID_INFORMACJI`, `SYG`/`TEZA`, `dokument.fields`, `suggestion`), zwraca
jawny błąd **`[api_changed]`** z prośbą o zgłoszenie issue — zamiast cichego
pustego wyniku, który kosztuje godziny zgadywania. Kosmetyczne zmiany
kontraktu (nowe pola, przestawiona kolejność) nie wywracają konektora.

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

## Testy

```bash
npm run test:parse   # offline - parsowanie/formattery/drift guard na realnych
                     # fixture'ach API (nie wymaga sieci)
npm run smoke        # LIVE - pelny przebieg 4 tooli po stdio przeciwko
                     # eureka.mf.gov.pl (throttled; EUREKA miewa przerwy)
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

## Konfiguracja ręczna (alternatywa)

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
