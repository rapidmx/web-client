///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { RefObject, useEffect, useState } from "react";
import { ApiRequestError } from "@rapidmx/react-shared/api.js";
import { GiphyGif, searchGifs } from "@rapidmx/react-shared/giphyApi.js";
import PopoverPortal from "./PopoverPortal.js";

export interface GifPickerProps {
    anchorRef: RefObject<HTMLElement | null>;
    onSelect: (url: string) => void;
    onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 350;
const WIDTH = 288;
const HEIGHT = 320;

/** "Insert GIF" popup — a search box plus a scrollable grid of Giphy thumbnails (trending by default,
 * live-searched as the user types). Selecting one inserts its full-resolution URL into the message
 * body — see `ComposeToolbar.tsx`'s own doc comment on why that's a plain `<img>` reference rather
 * than an uploaded attachment (unlike "Insert image"): a GIF is already hosted at a stable public
 * URL, so there's nothing to upload. Rendered via `PopoverPortal` — see that component's own doc
 * comment on why (escaping the toolbar's `overflow-hidden` ancestors). */
export default function GifPicker({ anchorRef, onSelect, onClose }: GifPickerProps) {
    const [query, setQuery] = useState("");
    const [gifs, setGifs] = useState<GiphyGif[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        setError(null);
        const handle = setTimeout(() => {
            searchGifs(query)
                .then(setGifs)
                .catch((err) => setError(err instanceof ApiRequestError ? err.message : "Could not load GIFs."))
                .finally(() => setLoading(false));
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [query]);

    return (
        <PopoverPortal anchorRef={anchorRef} onClose={onClose} width={WIDTH} height={HEIGHT} aria-label="Insert GIF">
            <div className="p-2 border-b border-border shrink-0">
                <input
                    type="text"
                    autoFocus
                    aria-label="Search GIFs"
                    placeholder="Search GIFs"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full text-sm py-1.5 px-2 border border-border rounded-sm bg-surface focus:outline-none focus:border-primary"
                />
            </div>
            <div className="flex-1 overflow-y-auto p-2">
                {error ? (
                    <p className="text-xs text-danger">{error}</p>
                ) : loading ? (
                    <p className="text-xs text-text-muted">Loading&hellip;</p>
                ) : gifs.length === 0 ? (
                    <p className="text-xs text-text-muted">No GIFs found.</p>
                ) : (
                    <div className="grid grid-cols-2 gap-1.5">
                        {gifs.map((gif) => (
                            <button
                                key={gif.id}
                                type="button"
                                title={gif.title}
                                onClick={() => onSelect(gif.url)}
                                className="rounded-sm overflow-hidden hover:opacity-80"
                            >
                                <img src={gif.previewUrl} alt={gif.title} className="w-full h-20 object-cover" />
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </PopoverPortal>
    );
}
