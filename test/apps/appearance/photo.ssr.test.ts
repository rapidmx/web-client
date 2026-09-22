// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { measureImage } from "../../../apps/shared/appearance/photo.js";

describe("photo measuring without a DOM", () => {
    it("measures nothing where there is no document", async () => {
        expect(typeof document).toBe("undefined");
        expect(await measureImage("/x")).toBeUndefined();
    });
});
