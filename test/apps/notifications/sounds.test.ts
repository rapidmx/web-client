// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNotificationSoundsEnabled } from "../../../apps/shared/notifications/preferences.js";
import { MIN_GAP_MS, playNotificationSound, resetNotificationSounds } from "../../../apps/shared/notifications/sounds.js";

interface FakeOscillator {
    type: string;
    frequency: { setValueAtTime: ReturnType<typeof vi.fn>; exponentialRampToValueAtTime: ReturnType<typeof vi.fn> };
    connect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
}

/** A stand-in for `AudioContext` that records the oscillators a sound is made of. */
class FakeAudioContext {
    static instances: FakeAudioContext[] = [];
    static initialState: "running" | "suspended" = "running";
    static resumeResult: Promise<void> = Promise.resolve();
    static throwOnCreate = false;
    state: "running" | "suspended" = FakeAudioContext.initialState;
    currentTime = 10;
    destination = {};
    oscillators: FakeOscillator[] = [];
    resume = vi.fn(() => FakeAudioContext.resumeResult);
    constructor() {
        if (FakeAudioContext.throwOnCreate) {
            throw new Error("no audio");
        }
        FakeAudioContext.instances.push(this);
    }
    createOscillator(): FakeOscillator {
        const oscillator: FakeOscillator = {
            type: "",
            frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
            connect: vi.fn(),
            start: vi.fn(),
            stop: vi.fn(),
        };
        this.oscillators.push(oscillator);
        return oscillator;
    }
    createGain() {
        return { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() };
    }
}

beforeEach(() => {
    localStorage.clear();
    resetNotificationSounds();
    FakeAudioContext.instances = [];
    FakeAudioContext.initialState = "running";
    FakeAudioContext.resumeResult = Promise.resolve();
    FakeAudioContext.throwOnCreate = false;
    vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const audio = () => FakeAudioContext.instances[0];

describe("playNotificationSound", () => {
    it("plays a two-note chime for new mail, in sine tones", () => {
        playNotificationSound("mail", 1000);
        expect(audio().oscillators).toHaveLength(2);
        expect(audio().oscillators.every((oscillator) => oscillator.type === "sine" && oscillator.start.mock.calls.length === 1)).toBe(true);
    });

    it("plays a struck bell, twice, for a calendar alarm: a fundamental and three bell partials a strike", () => {
        playNotificationSound("calendar", 1000);
        expect(audio().oscillators).toHaveLength(8);
        const starts = audio().oscillators.map((oscillator) => oscillator.start.mock.calls[0][0]);
        expect(new Set(starts)).toEqual(new Set([10, 10.75]));
    });

    it("plays two falling sawtooth buzzes for an error, sliding in pitch", () => {
        playNotificationSound("error", 1000);
        expect(audio().oscillators).toHaveLength(2);
        for (const oscillator of audio().oscillators) {
            expect(oscillator.type).toBe("sawtooth");
            expect(oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(190, expect.any(Number));
        }
    });

    it("makes the three sounds different from one another", () => {
        playNotificationSound("mail", 1000);
        playNotificationSound("calendar", 1000);
        playNotificationSound("error", 1000);
        const pitches = (from: number, to: number) => audio().oscillators.slice(from, to).map((oscillator) => oscillator.frequency.setValueAtTime.mock.calls[0][0]);
        expect(pitches(0, 2)).not.toEqual(pitches(2, 4));
        expect(pitches(2, 4)).not.toEqual(pitches(10, 12));
    });

    it("does not play the same sound twice within the minimum gap, but plays it again after, and another sound at once", () => {
        playNotificationSound("mail", 1000);
        playNotificationSound("mail", 1000 + MIN_GAP_MS - 1);
        expect(audio().oscillators).toHaveLength(2);
        playNotificationSound("error", 1000 + 10);
        expect(audio().oscillators).toHaveLength(4);
        playNotificationSound("mail", 1000 + MIN_GAP_MS);
        expect(audio().oscillators).toHaveLength(6);
    });

    it("plays nothing when the sounds are turned off", () => {
        setNotificationSoundsEnabled(false);
        playNotificationSound("mail", 1000);
        expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it("reuses one audio context for every sound", () => {
        playNotificationSound("mail", 1000);
        playNotificationSound("error", 1000);
        expect(FakeAudioContext.instances).toHaveLength(1);
    });

    it("resumes a suspended context first, and plays once it is running", async () => {
        FakeAudioContext.initialState = "suspended";
        playNotificationSound("mail", 1000);
        expect(audio().resume).toHaveBeenCalledTimes(1);
        expect(audio().oscillators).toHaveLength(0);
        await Promise.resolve();
        await Promise.resolve();
        expect(audio().oscillators).toHaveLength(2);
    });

    it("skips the sound, quietly, when the browser refuses to resume the context", async () => {
        FakeAudioContext.initialState = "suspended";
        FakeAudioContext.resumeResult = Promise.reject(new Error("not allowed"));
        playNotificationSound("mail", 1000);
        await Promise.resolve();
        await Promise.resolve();
        expect(audio().oscillators).toHaveLength(0);
    });

    it("makes no sound, and no error, where there is no Web Audio", () => {
        vi.stubGlobal("AudioContext", undefined);
        expect(() => playNotificationSound("mail", 1000)).not.toThrow();
    });

    it("falls back to the prefixed constructor of an older Safari", () => {
        vi.stubGlobal("AudioContext", undefined);
        vi.stubGlobal("webkitAudioContext", FakeAudioContext);
        playNotificationSound("mail", 1000);
        expect(audio().oscillators).toHaveLength(2);
    });

    it("makes no sound, and no error, when the audio context cannot be made", () => {
        FakeAudioContext.throwOnCreate = true;
        expect(() => playNotificationSound("mail", 1000)).not.toThrow();
        expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it("never lets a failure while making the sound out", () => {
        vi.spyOn(FakeAudioContext.prototype, "createOscillator").mockImplementation(() => {
            throw new Error("broken");
        });
        expect(() => playNotificationSound("mail", 1000)).not.toThrow();
    });

    it("uses the current time when none is given", () => {
        playNotificationSound("mail");
        expect(audio().oscillators).toHaveLength(2);
    });
});
