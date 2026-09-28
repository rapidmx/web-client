// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { copyTextToClipboard } from "../../../lib/util/clipboard.js";

describe("copyTextToClipboard without a DOM", () => {
    it("reports failure rather than throwing where there is no document (server-side rendering)", async () => {
        expect(typeof document).toBe("undefined");
        await expect(copyTextToClipboard("x")).resolves.toBe(false);
    });
});
