///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * Emoji data for the Compose window's "Insert emoji" picker — the full standard unicode emoji set
 * (categories + native characters), sourced from `@emoji-mart/data` (used as a pure data file only;
 * this app has its own grid UI rather than pulling in `@emoji-mart`'s full React picker component).
 */
import emojiData from "@emoji-mart/data" with { type: "json" };

/** The subset of `@emoji-mart/data`'s own shape this file actually reads — declared locally rather
 * than importing its `EmojiMartData` type, which would need a second, non-`{type:"json"}` import of
 * the same specifier (its `.d.ts` and its JSON data resolve from the same package name, so importing
 * both is a `no-duplicate-imports` lint error, not just style noise). */
interface RawEmojiMartData {
    categories: { id: string; emojis: string[] }[];
    emojis: Record<string, { id: string; name: string; skins: { native: string }[] } | undefined>;
}

const data = emojiData as RawEmojiMartData;

export interface EmojiCategory {
    id: string;
    emojis: { id: string; native: string; name: string }[];
}

export const EMOJI_CATEGORIES: EmojiCategory[] = data.categories.map((category) => ({
    id: category.id,
    emojis: category.emojis
        .map((emojiId) => data.emojis[emojiId])
        .filter((emoji): emoji is NonNullable<typeof emoji> => emoji != null && emoji.skins.length > 0)
        .map((emoji) => ({ id: emoji.id, native: emoji.skins[0].native, name: emoji.name })),
}));
