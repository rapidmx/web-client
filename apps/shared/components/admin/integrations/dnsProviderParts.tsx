///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import type { DnsProvider } from "../../../../../lib/admin/dnsProvidersApi.js";
import type { DnsExistingRecord } from "../../../../../lib/admin/domainsApi.js";

/** A small label beside a name ("Not yet live-tested", "Added by the installer"). */
export function Badge({ children }: { children: ReactNode }) {
    return <span className="ml-2 text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">{children}</span>;
}

/** How long without a report from the DNS controller before it is shown as possibly down: it reports every minute by default
 * (`DNS_CONTROLLER_STATUS_INTERVAL_SECONDS`), so this is ten missed reports, well past a pod restart or a clock off by a few minutes. */
export const CONTROLLER_SILENT_MS = 10 * 60 * 1000;

/** Whether a report made at `iso` is older than `CONTROLLER_SILENT_MS`: what it says may no longer hold. */
export function isStaleReport(iso: string, now: number = Date.now()): boolean {
    return now - new Date(iso).getTime() > CONTROLLER_SILENT_MS;
}

/** What the console says of a provider config's external-dns instance: Disabled (the admin's switch), Unknown when the DNS controller last reported
 * on it too long ago (it may be down: nothing it said still holds), Error with the last error the controller reported, Running (a ready pod), or Not
 * ready (none yet, including a config the controller hasn't reported on). */
export function dnsProviderStatus(
    provider: DnsProvider,
    now: number = Date.now()
): { label: "Disabled" | "Unknown" | "Error" | "Running" | "Not ready"; error?: string } {
    if (!provider.enabled) {
        return { label: "Disabled" };
    }
    if (provider.status?.reportedAt && isStaleReport(provider.status.reportedAt, now)) {
        return {
            label: "Unknown",
            error: `The DNS controller hasn't reported on it since ${formatTime(provider.status.reportedAt)}; it may be down.`,
        };
    }
    if (provider.status?.lastError) {
        return { label: "Error", error: provider.status.lastError };
    }
    return { label: (provider.status?.readyReplicas ?? 0) > 0 ? "Running" : "Not ready" };
}

/** `iso` as the browser's local date and time, nothing when unset. */
export function formatTime(iso: string | undefined): string {
    return iso ? new Date(iso).toLocaleString() : "";
}

/** "1 domain", "2 domains". */
export function domainsText(count: number): string {
    return count === 1 ? "1 domain" : `${count} domains`;
}

/** What a record in `type_mismatch` conflict says: records of another type stand where this one would be published, RapidMX never deletes or takes them over,
 * and the administrator deletes them at their DNS host. Lists them (type and value) when the server names them. */
export function TypeMismatchNotice({ existing }: { existing?: DnsExistingRecord[] }) {
    return (
        <div className="text-xs mt-1 max-w-xs">
            Records of another type are in the way. RapidMX never deletes them; delete them at your DNS host and this record is published.
            {existing && existing.length > 0 && (
                <ul className="mt-1 list-none flex flex-col gap-0.5">
                    {existing.map((record) => (
                        <li key={`${record.type} ${record.value}`}>
                            <code className="break-all">{`${record.type} ${record.value}`}</code>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
