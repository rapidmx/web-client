// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markComposePhase } from "../../../apps/shared/components/mail/compose/composePerf.js";

let id = 0;
const freshId = () => `perf-${++id}`;

beforeEach(() => {
    vi.spyOn(performance, "mark").mockImplementation((() => undefined) as any);
    vi.spyOn(performance, "measure").mockImplementation((() => undefined) as any);
});

afterEach(() => {
    delete (globalThis as any).__RAPIDMX_PERF__;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe("markComposePhase", () => {
    it("marks a phase and measures it from the click in a development build", () => {
        const window = freshId();
        markComposePhase(window, "click");
        markComposePhase(window, "shell");
        expect(performance.mark).toHaveBeenCalledWith(`compose:${window}:click`);
        expect(performance.mark).toHaveBeenCalledWith(`compose:${window}:shell`);
        expect(performance.measure).toHaveBeenCalledWith("compose:click->shell", {
            start: `compose:${window}:click`,
            end: `compose:${window}:shell`,
            detail: { id: window },
        });
    });

    it("only counts the first mark of each phase, and never measures the click against itself", () => {
        const window = freshId();
        markComposePhase(window, "click");
        markComposePhase(window, "click");
        markComposePhase(window, "chunk");
        markComposePhase(window, "chunk");
        expect(performance.mark).toHaveBeenCalledTimes(2);
        expect(performance.measure).toHaveBeenCalledTimes(1);
    });

    it("marks a phase without measuring when there was no click mark for that window", () => {
        markComposePhase(freshId(), "draft");
        expect(performance.mark).toHaveBeenCalledTimes(1);
        expect(performance.measure).not.toHaveBeenCalled();
    });

    it("does nothing in a production build unless the page switched it on", () => {
        vi.stubEnv("DEV", false);
        markComposePhase(freshId(), "click");
        expect(performance.mark).not.toHaveBeenCalled();

        (globalThis as any).__RAPIDMX_PERF__ = true;
        markComposePhase(freshId(), "click");
        expect(performance.mark).toHaveBeenCalledTimes(1);
    });

    it("does nothing where the browser has no performance marks", () => {
        const mark = performance.mark;
        vi.stubGlobal("performance", {});
        markComposePhase(freshId(), "click");
        vi.stubGlobal("performance", undefined);
        markComposePhase(freshId(), "click");
        vi.unstubAllGlobals();
        expect(mark).not.toHaveBeenCalled();
    });
});
