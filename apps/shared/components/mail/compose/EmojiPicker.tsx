///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { RefObject } from "react";
import { EMOJI_CATEGORIES } from "@rapidmx/react-shared/emojiData.js";
import PopoverPortal from "./PopoverPortal.js";

export interface EmojiPickerProps {
    anchorRef: RefObject<HTMLElement | null>;
    onSelect: (native: string) => void;
    onClose: () => void;
}

const CATEGORY_LABELS: Record<string, string> = {
    people: "Smileys & People",
    nature: "Animals & Nature",
    foods: "Food & Drink",
    activity: "Activity",
    places: "Travel & Places",
    objects: "Objects",
    symbols: "Symbols",
    flags: "Flags",
};

const WIDTH = 288;
const HEIGHT = 320;

/**
 * "Insert emoji" popup — a scrollable grid of every standard unicode emoji, grouped by category (see
 * `emojiData.ts`). Deliberately no search box, unlike `GifPicker`'s — the user's own request only
 * asked for a browsable grid here, and 8 category headers over ~1900 emojis is already a reasonably
 * navigable amount without one. Rendered via `PopoverPortal` — see that component's own doc comment
 * on why (escaping the toolbar's `overflow-hidden` ancestors).
 */
export default function EmojiPicker({ anchorRef, onSelect, onClose }: EmojiPickerProps) {
    return (
        <PopoverPortal anchorRef={anchorRef} onClose={onClose} width={WIDTH} height={HEIGHT} aria-label="Insert emoji">
            <div className="flex-1 overflow-y-auto p-2">
                {EMOJI_CATEGORIES.map((category) => (
                    <div key={category.id} className="mb-2">
                        <h3 className="text-[11px] font-bold uppercase tracking-wide text-text-muted px-1 mb-1 sticky top-0 bg-surface">
                            {CATEGORY_LABELS[category.id] ?? category.id}
                        </h3>
                        <div className="grid grid-cols-8 gap-0.5">
                            {category.emojis.map((emoji) => (
                                <button
                                    key={emoji.id}
                                    type="button"
                                    title={emoji.name}
                                    aria-label={emoji.name}
                                    onClick={() => onSelect(emoji.native)}
                                    className="w-8 h-8 flex items-center justify-center text-lg rounded-sm hover:bg-surface-alt"
                                >
                                    {emoji.native}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </PopoverPortal>
    );
}
