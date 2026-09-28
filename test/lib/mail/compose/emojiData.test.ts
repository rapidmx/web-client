// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Mocks @emoji-mart/data with a small synthetic dataset rather than relying on the real (large, opaque)
// unicode dataset to happen to contain both a missing-id reference and a skins-less emoji - this file's
// own transform (map/filter over categories/emojis) is what's under test, not the real dataset's shape.
import { describe, it, expect, vi } from "vitest";

vi.mock("@emoji-mart/data", () => ({
    default: {
        categories: [{ id: "smileys", emojis: ["grin", "missing-id", "no-skins"] }],
        emojis: {
            grin: { id: "grin", name: "Grinning Face", skins: [{ native: "😀" }] },
            "no-skins": { id: "no-skins", name: "No Skins", skins: [] },
        },
    },
}));

const { EMOJI_CATEGORIES } = await import("../../../../lib/mail/compose/emojiData.js");

describe("EMOJI_CATEGORIES", () => {
    it("builds one category per source category, filtering out missing and skins-less emojis", () => {
        expect(EMOJI_CATEGORIES).toEqual([
            {
                id: "smileys",
                emojis: [{ id: "grin", native: "😀", name: "Grinning Face" }],
            },
        ]);
    });
});
