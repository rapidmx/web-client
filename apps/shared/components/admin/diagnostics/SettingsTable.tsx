///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useMemo, useState } from "react";
import Button from "../../../../../lib/components/buttons/Button.js";
import CopyIconButton from "../../../../../lib/components/buttons/CopyIconButton.js";
import type { DiagnosticsSetting } from "./diagnosticsApi.js";

/** How many settings are listed at first, and how many more each "Show more" adds: an environment can be a hundred long. */
export const SETTINGS_PAGE_SIZE = 100;

/** What stands where the server withheld a value. Drawn here from `redacted`: the server never sends the value (or any text for it). */
export const HIDDEN_VALUE = "•••• (hidden)";

const INPUT_CLASS =
    "w-full text-sm py-2 px-3 border border-border rounded-sm bg-surface text-text focus:outline-none focus:border-primary";

export interface SettingsTableProps {
    /** The section's heading, which also names its filter box and labels the section. */
    title: string;
    /** What the section lists, under the heading. */
    description: string;
    /** Also the prefix of the heading's element id. */
    id: string;
    settings: DiagnosticsSetting[];
}

/**
 * A filterable, paged list of settings (name and value). A value the server withheld is shown as "•••• (hidden)", never as
 * anything it could have held. The filter matches names, and the values that are shown: a hidden value can't be searched for.
 */
export default function SettingsTable({ title, description, id, settings }: SettingsTableProps) {
    const [query, setQuery] = useState("");
    const [limit, setLimit] = useState(SETTINGS_PAGE_SIZE);

    const matching = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return settings.filter((item) => needle === "" || `${item.name} ${item.redacted ? "" : (item.value ?? "")}`.toLowerCase().includes(needle));
    }, [settings, query]);
    const shown = matching.slice(0, limit);
    const hiddenCount = settings.filter((item) => item.redacted).length;

    return (
        <section aria-labelledby={`${id}-heading`} className="rounded-md border border-border bg-surface p-4">
            <h2 id={`${id}-heading`} className="text-base font-bold uppercase tracking-wide mb-1">
                {title}
            </h2>
            <p className="mb-3 text-xs text-text-muted">{description}</p>
            <div className="mb-3">
                <input
                    type="search"
                    aria-label={`Filter ${title.toLowerCase()}`}
                    className={INPUT_CLASS}
                    placeholder="Filter by name or value"
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setLimit(SETTINGS_PAGE_SIZE);
                    }}
                />
            </div>
            <p role="status" className="mb-2 text-xs text-text-muted">
                {(matching.length === settings.length ? `${settings.length} settings` : `${matching.length} of ${settings.length} settings match`) +
                    (hiddenCount > 0 ? `, ${hiddenCount} with a hidden value` : "")}
            </p>
            {matching.length === 0 ? (
                <p className="text-sm text-text-muted">{settings.length === 0 ? "Nothing is set." : "No settings match."}</p>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm border-collapse">
                        <thead>
                            <tr>
                                {["Name", "Value"].map((heading) => (
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
                                <tr key={item.name}>
                                    <td className="py-2 px-2.5 border-b border-border font-mono break-all">
                                        {item.name}
                                        <CopyIconButton value={item.name} label={`Copy the name of ${item.name}`} />
                                    </td>
                                    <td className="py-2 px-2.5 border-b border-border font-mono break-all">
                                        {item.redacted ? (
                                            <span className="text-text-muted">{HIDDEN_VALUE}</span>
                                        ) : (
                                            <>
                                                {item.value}
                                                <CopyIconButton value={item.value ?? ""} label={`Copy the value of ${item.name}`} />
                                            </>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {shown.length < matching.length && (
                <div className="mt-3 flex items-center gap-3">
                    <Button type="button" variant="secondary" className="!w-auto" onClick={() => setLimit(limit + SETTINGS_PAGE_SIZE)}>
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
