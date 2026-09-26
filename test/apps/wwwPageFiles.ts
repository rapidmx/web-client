///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import fs from "node:fs";
import path from "node:path";

/** `apps/www`: the webmail's pages, which `@rapidrest/react` routes by file. */
export const wwwPagesDir = path.resolve(__dirname, "../../apps/www");

/** The route template a page file serves, as `@rapidrest/react` derives it: `index.tsx` is its directory, `[uid].tsx` is `:uid`. */
export function templateOf(file: string): string {
    const segments = file
        .replace(/\.tsx$/, "")
        .replace(/(^|\/)index$/, "")
        .split("/")
        .filter(Boolean)
        .map((segment) => (segment.startsWith("[") ? `:${segment.slice(1, -1)}` : segment));
    return "/" + segments.join("/");
}

/** The page files under `dir`, relative to `base` with forward slashes: every `.tsx` at any depth but the `_`-prefixed ones (`_shell.tsx`, `_layout.tsx`). */
export function pageFiles(dir: string = wwwPagesDir, base: string = dir): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name.startsWith("_")) {
            return [];
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return pageFiles(full, base);
        }
        return entry.name.endsWith(".tsx") ? [path.relative(base, full).split(path.sep).join("/")] : [];
    });
}

/** The route templates of the webmail's pages. */
export function wwwRouteTemplates(): string[] {
    return pageFiles().map(templateOf);
}
