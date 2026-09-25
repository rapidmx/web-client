///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useEffect, useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import { LeftoverMailbox, listLeftoverMailboxes } from "@rapidmx/react-shared/admin/leftoverMailboxApi.js";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import EraseLeftoverDataDialog from "./EraseLeftoverDataDialog.js";

/** How many deleted mailboxes one request asks for. */
const PAGE_SIZE = 50;
/** How often the list is refreshed while an erasure is under way. */
export const LEFTOVER_REFRESH_INTERVAL_MS = 5000;

const HEADING_CLASS = "text-left text-xs uppercase tracking-wide text-text-muted py-2 px-2.5 border-b border-border";
const CELL_CLASS = "py-2.5 px-2.5 border-b border-border align-middle";

/** Whether the erasure the server last filed for `item` is still to finish. */
function isErasing(item: LeftoverMailbox): boolean {
    return item.erasure?.status === "approved" || item.erasure?.status === "in_progress";
}

export interface LeftoverMailboxesSectionProps {
    /** How often the list is refreshed while an erasure is under way. */
    refreshIntervalMs?: number;
    /** How often an open erasure asks how far it has got. */
    pollIntervalMs?: number;
}

/**
 * "Deleted mailboxes with remaining data": deleting a mailbox keeps everything in it, and the address can't be used again until
 * that is erased, so this lists what is left (from `GET /mailboxes/leftover`) with an "Erase data" action for each. It shows nothing
 * at all while there is nothing left - the section is only there when it is needed. An erasure that is under way shows as such, and
 * the list refreshes itself until it has finished.
 */
export default function LeftoverMailboxesSection({ refreshIntervalMs = LEFTOVER_REFRESH_INTERVAL_MS, pollIntervalMs }: LeftoverMailboxesSectionProps) {
    const [items, setItems] = useState<LeftoverMailbox[]>([]);
    const [next, setNext] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [target, setTarget] = useState<LeftoverMailbox | null>(null);
    // Only the newest reload is applied: a slow earlier one can't put back what a later one already removed.
    const generation = useRef(0);

    async function reload() {
        const current = ++generation.current;
        try {
            const page = await listLeftoverMailboxes({ limit: PAGE_SIZE });
            if (current !== generation.current) return;
            setItems(page.items);
            setNext(page.next);
            setError(null);
        } catch (err) {
            if (current === generation.current) {
                setError(err instanceof ApiRequestError ? err.message : "Could not check for deleted mailboxes with remaining data.");
            }
        }
    }

    async function loadMore() {
        const current = generation.current;
        setLoadingMore(true);
        try {
            const page = await listLeftoverMailboxes({ limit: PAGE_SIZE, after: next });
            if (current !== generation.current) return;
            setItems((existing) => [...existing, ...page.items.filter((item) => !existing.some((seen) => seen.mailboxUid === item.mailboxUid))]);
            setNext(page.next);
        } catch (err) {
            if (current === generation.current) {
                setError(err instanceof ApiRequestError ? err.message : "Could not load more deleted mailboxes.");
            }
        } finally {
            setLoadingMore(false);
        }
    }

    useEffect(() => {
        void reload();
    }, []);

    const anyErasing = items.some(isErasing);
    useEffect(() => {
        if (!anyErasing) {
            return;
        }
        const timer = setInterval(() => void reload(), refreshIntervalMs);
        return () => clearInterval(timer);
    }, [anyErasing, refreshIntervalMs]);

    // Only there when something is left (or the check failed).
    const section =
        items.length > 0 || error !== null ? (
            <section className="mt-10" aria-labelledby="leftover-heading">
                <h2 id="leftover-heading" className="text-sm font-bold uppercase tracking-wide text-text-muted mb-2">
                    Deleted mailboxes with remaining data
                </h2>
                <p className="text-sm text-text-muted mb-3">
                    Deleting a mailbox keeps everything in it, and its address can&rsquo;t be used for a new mailbox until that data is
                    erased. Erasing is permanent.
                </p>

                {error && <Alert>{error}</Alert>}

                {items.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm border-collapse">
                            <caption className="sr-only">Deleted mailboxes with remaining data</caption>
                            <thead>
                                <tr>
                                    <th scope="col" className={HEADING_CLASS}>
                                        Address
                                    </th>
                                    <th scope="col" className={HEADING_CLASS}>
                                        Folders
                                    </th>
                                    <th scope="col" className={HEADING_CLASS}>
                                        Messages
                                    </th>
                                    <th scope="col" className={HEADING_CLASS}>
                                        Erasure
                                    </th>
                                    <th scope="col" className="border-b border-border">
                                        <span className="sr-only">Actions</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {items.map((item) => (
                                    <tr key={item.mailboxUid}>
                                        <td className={`${CELL_CLASS} break-all`}>{item.mailboxUid}</td>
                                        <td className={CELL_CLASS}>{item.folderCount}</td>
                                        <td className={CELL_CLASS}>{item.messageCount}</td>
                                        <td className={CELL_CLASS}>
                                            {isErasing(item) ? (
                                                <span className="inline-block text-xs font-bold uppercase tracking-wide py-0.5 px-2 rounded-pill bg-surface-alt text-text-muted">
                                                    Erasing
                                                </span>
                                            ) : (
                                                <span className="text-text-muted">Not erased</span>
                                            )}
                                        </td>
                                        <td className={`${CELL_CLASS} text-right`}>
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                className={isErasing(item) ? "!w-auto" : "!w-auto !border-danger !text-danger hover:!border-danger hover:!text-danger"}
                                                aria-label={`${isErasing(item) ? "Show the erasure of" : "Erase data of"} ${item.mailboxUid}`}
                                                onClick={() => setTarget(item)}
                                            >
                                                {isErasing(item) ? "Show progress" : "Erase data"}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                {next !== undefined && (
                    <Button type="button" variant="secondary" className="!w-auto mt-3" loading={loadingMore} disabled={loadingMore} onClick={() => void loadMore()}>
                        Load more
                    </Button>
                )}
            </section>
        ) : null;

    // The dialog outlives the row it was opened from - erasing the last one empties the list while its "erased" message is still up - and
    // keeps its place among the fragment's children whether or not the section is there, so it is not rebuilt (and does not lose where it
    // is) when the section goes.
    const dialog = target && (
        <EraseLeftoverDataDialog
            key={target.mailboxUid}
            address={target.mailboxUid}
            counts={{ folders: target.folderCount, messages: target.messageCount }}
            resume={isErasing(target) && target.erasure ? { uid: target.erasure.uid, status: target.erasure.status } : undefined}
            pollIntervalMs={pollIntervalMs}
            onErased={() => void reload()}
            onClose={() => {
                setTarget(null);
                void reload();
            }}
        />
    );

    return (
        <>
            {section}
            {dialog}
        </>
    );
}
