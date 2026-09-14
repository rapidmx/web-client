///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useRef, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/util/api.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";

/** Page size for the async-request lists (the server returns them newest first and caps `limit` at 500). */
export const REQUEST_LIST_PAGE_SIZE = 50;

export interface PagedList<T> {
    items: T[];
    /** `true` until the first page has loaded (or failed). */
    loading: boolean;
    loadError: string | null;
    /** Whether the last page fetched was full, so another may follow. */
    hasMore: boolean;
    loadingMore: boolean;
    /** Re-fetches from the first page, dropping anything loaded beyond it. */
    reload: () => Promise<void>;
    /** Fetches the next page and appends what's new in it. */
    loadMore: () => Promise<void>;
    /** Replaces one already-loaded item in place (e.g. with an action's response). */
    replaceItem: (item: T) => void;
}

/**
 * A newest-first list fetched a page at a time with "Load more". Only the most recently started `reload()`'s
 * responses are applied, so a slow earlier fetch (e.g. the mount fetch racing a reload after a create) can't
 * overwrite a newer list, and a "Load more" that was in flight during a reload is dropped.
 *
 * Paging is by offset, so "Load more" re-reads the previous page alongside the next one and continues after the last
 * row already shown: rows created since shift older rows onto later pages (repeats are skipped), and rows deleted
 * since shift them onto earlier pages (which a plain next-page fetch would silently skip). If that row can't be found
 * in the two pages at all (it was deleted, or more than a page of rows came or went), the list reloads from the start.
 */
export function usePagedList<T extends { uid: string }>(
    fetchPage: (params: { limit: number; page: number }) => Promise<T[]>,
    errorMessage: string,
): PagedList<T> {
    const pageSize = REQUEST_LIST_PAGE_SIZE;
    const [items, setItems] = useState<T[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const generation = useRef(0);
    const nextPage = useRef(0);
    const loaded = useRef<T[]>(items);
    loaded.current = items;

    function describe(err: unknown): string {
        return err instanceof ApiRequestError ? err.message : errorMessage;
    }

    async function reload() {
        const current = ++generation.current;
        try {
            const data = await fetchPage({ limit: pageSize, page: 0 });
            if (current !== generation.current) return;
            setItems(data);
            setHasMore(data.length === pageSize);
            setLoadError(null);
            nextPage.current = 1;
        } catch (err) {
            if (current === generation.current) setLoadError(describe(err));
        } finally {
            if (current === generation.current) setLoading(false);
        }
    }

    async function loadMore() {
        const current = generation.current;
        const page = nextPage.current;
        setLoadingMore(true);
        try {
            const [previous, data] = await Promise.all([
                fetchPage({ limit: pageSize, page: page - 1 }),
                fetchPage({ limit: pageSize, page }),
            ]);
            if (current !== generation.current) return;
            const window: T[] = [...previous, ...data];
            // "Load more" is only offered after a full page, so at least one row is shown.
            const lastShown: string = loaded.current[loaded.current.length - 1].uid;
            const boundary: number = window.map((item) => item.uid).lastIndexOf(lastShown);
            if (boundary === -1) {
                await reload();
                return;
            }
            const after: T[] = window.slice(boundary + 1);
            setItems((prev) => [...prev, ...after.filter((item) => !prev.some((existing) => existing.uid === item.uid))]);
            setHasMore(data.length === pageSize);
            setLoadError(null);
            nextPage.current = page + 1;
        } catch (err) {
            if (current === generation.current) setLoadError(describe(err));
        } finally {
            setLoadingMore(false);
        }
    }

    function replaceItem(item: T) {
        setItems((prev) => prev.map((existing) => (existing.uid === item.uid ? item : existing)));
    }

    return { items, loading, loadError, hasMore, loadingMore, reload, loadMore, replaceItem };
}

/** The "Load more" button for a `usePagedList()` list - renders nothing once there's nothing more to load. */
export function LoadMoreButton({ list, label }: { list: Pick<PagedList<unknown>, "hasMore" | "loadingMore" | "loadMore">; label: string }) {
    if (!list.hasMore) {
        return null;
    }
    return (
        <div className="mt-3">
            <Button
                type="button"
                variant="secondary"
                className="!w-auto"
                loading={list.loadingMore}
                disabled={list.loadingMore}
                onClick={() => void list.loadMore()}
            >
                {label}
            </Button>
        </div>
    );
}
