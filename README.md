# mcp-eureka

MCP server dla polskich **interpretacji indywidualnych** (Dyrektor Krajowej
Informacji Skarbowej) przez **publiczne API systemu EUREKA** Ministerstwa
Finansów (`eureka.mf.gov.pl`).

## Po co

`mcp-eureka` daje Claude'owi dostęp do realnych interpretacji indywidualnych
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

- **`search(query, dateFrom?, dateTo?, searchInContent?, fullPhrase?, sort?, pageSize?, pageNumber?)`**
  — wyszukiwanie po słowach kluczowych, **domyślnie sortowane po trafności**.
  `searchInContent=true` i `fullPhrase=true` **zawężają** wynik (precyzja),
  `sort="data_desc"` przełącza na najnowsze. Zwraca top-N z sygnaturą (SYG),
  organem, datą wydania i tezą. Zob. [Recall i precyzja](#recall-i-precyzja-jak-pytać-eurekę).
- **`get_interpretation(id, section?, offset?, maxChars?)`** — treść
  interpretacji po `ID_INFORMACJI`. Zwraca metadane, pełną tezę i **fragment**
  treści (domyślnie 15 000 znaków) wraz z **mapą sekcji**. Treść jest
  oczyszczana z HTML i **sklejana w płynne akapity** (`reflowText`) — bez
  „porozrywanych" pojedynczych wierszy. Zob. [Długie dokumenty](#długie-dokumenty-sekcje-i-offset).
- **`search_by_signature(signature)`** — skrót: szukaj po sygnaturze KIS
  (np. `0115-KDST2-2.4011.218.2026.2.KK`).
- **`suggest(phrase)`** — podpowiedzi fraz (autocomplete).

Każda zwrotka zawiera `structuredContent.citations`:
`title`, `url` (`eureka.mf.gov.pl/informacje/podglad/{id}`), `signature`, `date`,
`author`, `snippet`, `doc_id`.

`get_interpretation` dodatkowo zwraca `structuredContent.interpretation`
(sygnatura, daty, teza, `content_chunk`, `content_range`, `has_more`,
`next_offset`, `sections`, url) — bo część klientów MCP (m.in. konektory
claude.ai) pokazuje modelowi **wyłącznie** `structuredContent`; bez tego treść
ginęła mimo obecności w `content`.

## Długie dokumenty: sekcje i offset

Interpretacje KIS bywają bardzo długie — **90 tys. znaków to norma** — i mają
stałą strukturę:

```
nagłówek → stan faktyczny → pytanie → stanowisko wnioskodawcy
        → OCENA STANOWISKA + uzasadnienie organu → pouczenie
```

**Uzasadnienie organu leży ok. 60–70% długości dokumentu.** Oznacza to, że
fragment liczony od początku pokazuje wyłącznie stan faktyczny — czyli to, co
napisał wnioskodawca, a nie to, jak organ uzasadnił rozstrzygnięcie. Dlatego
`get_interpretation` przyjmuje:

| Parametr | Działanie |
|---|---|
| `section="uzasadnienie"` | skok do oceny stanowiska i argumentacji organu |
| `offset=N` | przewinięcie o N znaków (wartość podpowiadana w odpowiedzi) |
| `maxChars=N` | rozmiar fragmentu, 500–50 000, domyślnie 15 000 |

Dostępne sekcje: `stan_faktyczny`, `pytanie`, `stanowisko`, `uzasadnienie`,
`rozstrzygniecie`, `pouczenie`. Każda odpowiedź zawiera mapę wykrytych sekcji z
pozycjami znakowymi oraz — gdy dokument się nie zmieścił — jawne `[...] To
FRAGMENT` z gotowym `offset` do dalszego ciągu. Model dostaje więc informację,
że widzi część dokumentu, i wie, jak sięgnąć po resztę.

> Limit istnieje z powodu budżetu tokenów: 90 tys. znaków to ok. 30 tys.
> tokenów na jeden dokument. Stronicowanie jest świadomym kompromisem — całość
> pozostaje dostępna, ale model pobiera ją porcjami.

## Recall i precyzja: jak pytać EUREKĘ

Sam dostęp do bazy nie wystarcza — liczy się, czy agent dostaje **wszystkie**
istotne interpretacje (recall) i czy **nie dostaje nieistotnych** (precyzja).
Wyszukiwarka EUREKI to Elasticsearch z rozmytym dopasowaniem po rdzeniach słów,
co daje kilka pułapek. Wszystkie poniższe liczby zmierzone na żywym API
2026-07-31 (skrypty w historii commitów):

**1. Sortowanie po trafności, nie po dacie.** To była najpoważniejsza wada
wcześniejszych wersji. Zapytanie *„50% koszty uzyskania przychodów aktor prawa
autorskie"* (2 622 dopasowania):

| Sortowanie | Czołówka wyników |
|---|---|
| po dacie (`data_desc`) | licencje na oprogramowanie, UPO polsko-belgijska, IP Box, WHT — **zero w temat** |
| po trafności (**domyślne**) | *„Czy wnioskodawca ma prawo zastosować 50% koszty uzyskania przychodu?"*, honorarium autorskie, art. 22 ust. 9 pkt 3 — **wszystkie w temat** |

Przy tysiącach rozmytych dopasowań sortowanie po dacie zwracało 10
najnowszych zamiast 10 najtrafniejszych.

**2. Polskie znaki są obowiązkowe.** EUREKA **nie normalizuje** diakrytyków:

| Zapytanie | Trafienia |
|---|---|
| `podwyzszone koszty uzyskania` | **0** |
| `podwyższone koszty uzyskania` | **293 077** |
| `dzialalnosc badawczo-rozwojowa` | 99 |
| `działalność badawczo-rozwojowa` | 31 729 |

To najczęstsza cicha przyczyna pustego wyniku. Konektor **wykrywa** zapytania
wyglądające na polskie bez diakrytyków i zwraca ostrzeżenie zamiast milczącego
zera. Z tego samego powodu instrukcje dla modelu są pisane poprawną
polszczyzną — model naśladuje język promptu, a wersja bez ogonków uczyła go
formułować zapytania, które nie trafiają.

**3. Liczba dopasowań jest zawyżona.** `aktor` daje 14 322 dopasowania, co nie
znaczy 14 322 interpretacji o aktorach. Przy wyniku > 1000 konektor dopisuje
modelowi ostrzeżenie, żeby nie raportował tej liczby jako liczby trafnych
interpretacji.

**4. Krótkie zapytania i kilka podejść.** 2–4 słowa kluczowe biją całe zdanie,
a kilka wąskich zapytań bije jedno szerokie — terminologia KIS bywa inna niż
potoczna (`honorarium autorskie` vs `50% koszty uzyskania` vs `prawa pokrewne
artysty wykonawcy`). Zero wyników to zwykle wada zapytania, nie brak
interpretacji.

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
konektorów MateMatic do polskiego orzecznictwa.

## Licencja

MIT © 2026 Mateusz Bednarski. Zobacz [LICENSE](LICENSE).
