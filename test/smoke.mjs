#!/usr/bin/env node
// Smoke test LIVE (eureka.mf.gov.pl) - odpala zbudowany serwer po stdio
// (MCP JSON-RPC) i sprawdza wszystkie 4 tooly na zywym API:
//   1. tools/list           -> 4 tooly
//   2. search_by_signature  -> dokladna sygnatura = dokladnie 1 trafienie
//   3. search               -> fraza zwraca wyniki; fullPhrase zaweza (<=)
//   4. get_interpretation   -> tresc obecna + structuredContent.interpretation
//   5. suggest              -> tablica stringow
// Wymaga `npm run build`. Uwaga: EUREKA miewa przerwy - FAIL upstream_error
// na wszystkich krokach oznacza zwykle awarie MF, nie regresje konektora.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(__dirname, "../dist/index.js");

// Interpretacja zweryfikowana live 2026-07-28 (istnieje, ma pelna tresc).
const SIG = "0115-KDIT2.4011.607.2025.1.MM";
const DOC_ID = "673398";

let idCounter = 1;

async function runSmoke() {
    console.log("--- mcp-eureka smoke test (LIVE eureka.mf.gov.pl) ---\n");

    const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

    const rl = createInterface({ input: child.stdout });
    const pending = new Map();
    rl.on("line", (line) => {
        if (!line.trim()) return;
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined && pending.has(msg.id)) {
                const { resolve, reject } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) reject(new Error(`RPC error: ${msg.error.message}`));
                else resolve(msg.result);
            }
        } catch {
            /* ignoruj linie nie-JSON */
        }
    });

    function rpc(method, params, timeoutMs = 90000) {
        return new Promise((resolveP, rejectP) => {
            const id = idCounter++;
            pending.set(id, { resolve: resolveP, reject: rejectP });
            child.stdin.write(
                JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
            );
            setTimeout(() => {
                if (pending.has(id)) {
                    pending.delete(id);
                    rejectP(new Error(`timeout ${method}`));
                }
            }, timeoutMs);
        });
    }

    const failures = [];
    const check = (cond, msg) => {
        console.log(`${cond ? "OK  " : "FAIL"} ${msg}`);
        if (!cond) failures.push(msg);
    };
    const totalOf = (r) => {
        const m = (r.content?.[0]?.text ?? "").match(/Znaleziono:\s+(\d+)/);
        return m ? parseInt(m[1], 10) : -1;
    };

    try {
        await rpc("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "smoke", version: "0.0.0" },
        });
        child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
                "\n",
        );

        // 1. tools/list
        const tools = await rpc("tools/list", {});
        check(tools.tools?.length === 4, `tools/list -> ${tools.tools?.length} tooly`);

        // 2. dokladna sygnatura -> 1 trafienie
        const bySig = await rpc("tools/call", {
            name: "search_by_signature",
            arguments: { signature: SIG },
        });
        check(!bySig.isError, "search_by_signature bez isError");
        check(totalOf(bySig) === 1, "sygnatura exact -> 1 trafienie");
        const cits = bySig.structuredContent?.citations ?? [];
        check(cits[0]?.signature === SIG, `citation signature: ${cits[0]?.signature}`);

        // 3. search: fraza luzno vs fullPhrase (zaweza lub rownowaznie)
        const loose = await rpc("tools/call", {
            name: "search",
            arguments: { query: "hipotetyczne odsetki", pageSize: 3 },
        });
        const strict = await rpc("tools/call", {
            name: "search",
            arguments: { query: "hipotetyczne odsetki", pageSize: 3, fullPhrase: true },
        });
        const tLoose = totalOf(loose);
        const tStrict = totalOf(strict);
        check(!loose.isError && tLoose > 0, `search luzny: ${tLoose} trafien`);
        check(
            !strict.isError && tStrict >= 0 && tStrict <= tLoose,
            `fullPhrase zaweza: ${tStrict} <= ${tLoose}`,
        );

        // 4. pelny dokument + structuredContent.interpretation
        const doc = await rpc("tools/call", {
            name: "get_interpretation",
            arguments: { id: DOC_ID },
        });
        const docText = doc.content?.[0]?.text ?? "";
        check(!doc.isError, "get_interpretation bez isError");
        check(docText.includes(SIG), "get_interpretation sygnatura zgodna");
        check(/Tresc \(pierwsze \d+ znakow/.test(docText), "get_interpretation ma tresc");
        const interp = doc.structuredContent?.interpretation;
        check(
            typeof interp?.content_preview === "string" &&
                interp.content_preview.length > 500,
            "structuredContent.interpretation.content_preview obecne",
        );

        // 5. suggest
        const sug = await rpc("tools/call", {
            name: "suggest",
            arguments: { phrase: "ulga na" },
        });
        const suggestions = sug.structuredContent?.suggestions;
        check(
            !sug.isError && Array.isArray(suggestions),
            `suggest -> tablica (${suggestions?.length ?? "?"} pozycji)`,
        );
    } catch (err) {
        failures.push(String(err));
        console.error("FAIL", err);
    } finally {
        child.kill();
    }

    if (failures.length === 0) {
        console.log("\nOK smoke - wszystkie asercje live przeszly.");
        process.exit(0);
    }
    console.error(`\nFAIL smoke - ${failures.length} problemow.`);
    process.exit(1);
}

runSmoke();
