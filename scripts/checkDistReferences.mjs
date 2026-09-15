///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Fails `yarn build` when a compiled module in `dist` references a relative file that isn't in `dist`.
 *
 * tsc copies module specifiers and `new URL("...", import.meta.url)` literals into its output unchanged, so a
 * reference that only resolves against the `.ts`/`.tsx` sources (a Worker named by its `.ts` file, say) ships
 * broken and fails every consumer that bundles `dist` with Vite. Checks static and dynamic imports, re-exports
 * and `new URL(..., import.meta.url)` in every `.js` and `.d.ts` file under the given directory (default `dist`).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "dist");

const REFERENCE_PATTERNS = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /\bnew\s+URL\s*\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*,\s*import\.meta\.url/g,
];

function listFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? listFiles(full) : [full];
    });
}

/** Block and line comments often quote source paths in prose; drop them before matching. */
function stripComments(code) {
    return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function resolves(file, specifier) {
    const target = path.resolve(path.dirname(file), specifier.replace(/[?#].*$/, ""));
    if (existsSync(target)) {
        return true;
    }
    // A declaration file's `./x.js` import is satisfied by the `./x.d.ts` next to it.
    return file.endsWith(".d.ts") && /\.js$/.test(target) && existsSync(target.replace(/\.js$/, ".d.ts"));
}

if (!existsSync(root)) {
    console.error(`checkDistReferences: ${root} does not exist; run the build first.`);
    process.exit(1);
}

const problems = [];
for (const file of listFiles(root).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const pattern of REFERENCE_PATTERNS) {
        for (const match of code.matchAll(pattern)) {
            const specifier = match[1];
            if (/\.tsx?$/.test(specifier) || !resolves(file, specifier)) {
                problems.push(`${path.relative(process.cwd(), file)}: "${specifier}" does not exist in the build output`);
            }
        }
    }
}

if (problems.length > 0) {
    console.error(`checkDistReferences: ${problems.length} broken relative reference(s):\n  ${problems.join("\n  ")}`);
    process.exit(1);
}
console.log(`checkDistReferences: every relative reference under ${path.relative(process.cwd(), root) || "."} resolves.`);
