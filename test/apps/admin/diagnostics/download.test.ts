// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveTextFile, timestampedFilename } from "../../../../apps/shared/components/admin/diagnostics/download.js";

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("timestampedFilename", () => {
    it("puts the time in the name with the colons replaced", () => {
        expect(timestampedFilename("rapidmx-server-logs", "log", new Date("2026-09-26T10:30:00.000Z"))).toBe(
            "rapidmx-server-logs-2026-09-26T10-30-00.000Z.log"
        );
    });

    it("defaults to now", () => {
        expect(timestampedFilename("a", "json")).toMatch(/^a-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z\.json$/);
    });
});

describe("saveTextFile", () => {
    it("clicks a temporary download link to a Blob, removes it, and revokes the URL afterwards", async () => {
        vi.useFakeTimers();
        const createObjectURL = vi.fn((_blob: Blob) => "blob:test-url");
        const revokeObjectURL = vi.fn();
        vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
        let clicked: HTMLAnchorElement | undefined;
        let attachedWhenClicked = false;
        vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
            clicked = this;
            attachedWhenClicked = document.body.contains(this);
        });

        saveTextFile("out.log", "hello\n", "text/plain");

        expect(attachedWhenClicked).toBe(true);
        expect(clicked?.download).toBe("out.log");
        expect(clicked?.getAttribute("href")).toBe("blob:test-url");
        expect(clicked && document.body.contains(clicked)).toBe(false);
        const blob = createObjectURL.mock.calls[0][0];
        expect(blob.type).toBe("text/plain");
        expect(await blob.text()).toBe("hello\n");
        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
    });
});
