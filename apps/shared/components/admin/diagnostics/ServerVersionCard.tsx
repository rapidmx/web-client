///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import type { DiagnosticsVersions } from "./diagnosticsApi.js";
import { formatDateTime, formatUptime, NO_VALUE } from "./format.js";

/** The server process: Node.js, the deployed package, the machine and how long it has been up. */
export default function ServerVersionCard({ server }: { server: DiagnosticsVersions["server"] }) {
    const rows: [string, string][] = [
        ["Node.js", server.nodeVersion || NO_VALUE],
        ["V8", server.v8Version || NO_VALUE],
        ["Package", server.packageName ? `${server.packageName} ${server.packageVersion ?? ""}`.trim() : NO_VALUE],
        ["Environment", server.nodeEnv || NO_VALUE],
        ["Platform", [server.platform, server.arch].filter(Boolean).join(" / ") || NO_VALUE],
        ["Host name", server.hostname || NO_VALUE],
        ["Process ID", server.pid === undefined ? NO_VALUE : String(server.pid)],
        ["Started", formatDateTime(server.startedAt)],
        ["Up for", formatUptime(server.uptimeSeconds)],
    ];
    return (
        <section aria-labelledby="diagnostics-server-heading" className="rounded-md border border-border bg-surface p-4">
            <h2 id="diagnostics-server-heading" className="text-base font-bold uppercase tracking-wide mb-3">
                Server
            </h2>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {rows.map(([term, description]) => (
                    <div key={term}>
                        <dt className="text-xs uppercase tracking-wide text-text-muted">{term}</dt>
                        <dd className="break-words">{description}</dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
