#!/usr/bin/env node
// format-md.mjs — porządkuje "porozrywany" tekst interpretacji w plikach Markdown.
//
// Tekst interpretacji z EUREKI bywa łamany wizualnie (każda linia źródła to osobne
// łamanie), przez co po wklejeniu do .md wychodzi "rozjechany" — pojedyncze słowa
// w osobnych wierszach. Ten skrypt skleja zawijane wiersze w płynne akapity,
// zachowując wypunktowania (1) / a) / - / § / art. / ust. / pkt / lit.) i łamiąc
// po dwukropku. Działa TYLKO na sekcji pod nagłówkiem "## Pełna treść" — nagłówek
// z metadanymi zostaje nietknięty.
//
// Użycie:
//   node scripts/format-md.mjs <plik.md> [kolejny.md ...]
//   node scripts/format-md.mjs <folder>        (wszystkie .md w folderze)

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

const MARKER = "## Pełna treść";

// Skleja porozrywane wiersze w akapity. Blok = tekst oddzielony pustą linią.
export function reflowText(text) {
    const norm = text.replace(/\r\n?/g, "\n");
    const blocks = norm.split(/\n{2,}/);
    const listRe =
        /^(\d+[.)]\s|[a-zA-Z]\)\s|[-–•*]\s|§\s?\d|art\.\s|ust\.\s|pkt\s|lit\.\s)/;
    const out = [];
    for (const block of blocks) {
        const lines = block
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        if (lines.length === 0) continue;
        const paras = [];
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

function formatFile(path) {
    const raw = readFileSync(path, "utf8");
    const idx = raw.indexOf(MARKER);
    if (idx === -1) return "pominięto (brak sekcji treści)";
    const head = raw.slice(0, idx + MARKER.length);
    const body = raw.slice(idx + MARKER.length);
    const next = head + "\n\n" + reflowText(body) + "\n";
    if (next === raw) return "bez zmian";
    writeFileSync(path, next, "utf8");
    return "sformatowano";
}

function collectTargets(args) {
    const files = [];
    for (const a of args) {
        const st = statSync(a);
        if (st.isDirectory()) {
            for (const f of readdirSync(a)) {
                if (extname(f).toLowerCase() === ".md") files.push(join(a, f));
            }
        } else {
            files.push(a);
        }
    }
    return files;
}

function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error(
            "Użycie: node scripts/format-md.mjs <plik.md | folder> [...]",
        );
        process.exit(1);
    }
    const files = collectTargets(args);
    if (files.length === 0) {
        console.error("Nie znaleziono plików .md w podanych ścieżkach.");
        process.exit(1);
    }
    for (const f of files) {
        let status;
        try {
            status = formatFile(f);
        } catch (e) {
            status = "BŁĄD: " + (e?.message ?? e);
        }
        console.log(status.padEnd(30) + f);
    }
}

main();
