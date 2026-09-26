///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useMemo, useState } from "react";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import type { DiagnosticsVersions } from "./diagnosticsApi.js";
import Badge from "./Badge.js";

/** How many packages are listed at first, and how many more each "Show more" adds: the list can be a thousand long. */
export const PACKAGES_PAGE_SIZE = 100;

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

/** Every package installed on the server, filtered by a name and paged, with a badge on the ones the server itself depends on. */
export default function PackagesTable({ packages }: { packages: DiagnosticsVersions["packages"] }) {
    const [query, setQuery] = useState("");
    const [directOnly, setDirectOnly] = useState(false);
    const [limit, setLimit] = useState(PACKAGES_PAGE_SIZE);

    const matching = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return packages.filter(
            (item) => (!directOnly || item.direct) && (needle === "" || `${item.name} ${item.version}`.toLowerCase().includes(needle))
        );
    }, [packages, query, directOnly]);
    const shown = matching.slice(0, limit);

    return (
        <section aria-labelledby="diagnostics-packages-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-packages-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                Installed packages
            </h2>
            <div className="mb-3 flex flex-wrap items-center gap-3">
                <div className="min-w-48 flex-1">
                    <input
                        type="search"
                        aria-label="Filter packages"
                        className={INPUT_CLASS}
                        placeholder="Filter by name or version"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setLimit(PACKAGES_PAGE_SIZE);
                        }}
                    />
                </div>
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="checkbox"
                        checked={directOnly}
                        onChange={(event) => {
                            setDirectOnly(event.target.checked);
                            setLimit(PACKAGES_PAGE_SIZE);
                        }}
                    />
                    Direct dependencies only
                </label>
            </div>
            <p role="status" className="mb-2 text-xs text-text-muted">
                {matching.length === packages.length
                    ? `${packages.length} packages`
                    : `${matching.length} of ${packages.length} packages match`}
            </p>
            {matching.length === 0 ? (
                <p className="text-sm text-text-muted">No packages match.</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Package", "Version", ""].map((heading) => (
                                    <th
                                        key={heading}
                                        className="text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border"
                                    >
                                        {heading}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {shown.map((item) => (
                                <tr key={`${item.name}@${item.version}`}>
                                    <td className="py-2 px-2.5 border-b border-border font-mono break-all">{item.name}</td>
                                    <td className="py-2 px-2.5 border-b border-border font-mono">{item.version}</td>
                                    <td className="py-2 px-2.5 border-b border-border">{item.direct && <Badge tone="info">direct</Badge>}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {shown.length < matching.length && (
                <div className="mt-3 flex items-center gap-3">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setLimit(limit + PACKAGES_PAGE_SIZE)}>
                        Show more
                    </Button>
                    <span className="text-xs text-text-muted">
                        Showing {shown.length} of {matching.length}
                    </span>
                </div>
            )}
        </section>
    );
}
