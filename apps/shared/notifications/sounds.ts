///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { getNotificationSoundsEnabled } from "./preferences.js";

/**
 * The sounds that go with the app's notifications: a chime for new mail, a bell for a calendar alarm and a low double buzz for an error. They are
 * made with the Web Audio API as they are played - no audio files to download, cache or ship - so they work offline and cost nothing until used.
 *
 * Browsers only let a page make sound after the person has interacted with it; until then the audio context stays suspended and a sound is silently
 * skipped (it is resumed, and plays from then on, as soon as the page has had a click or a key press). A sound is never an error: whatever
 * goes wrong with the audio is swallowed. The same sound is not played twice within `MIN_GAP_MS`, so a burst of notifications is one sound, not a clatter.
 */
export type NotificationSound = "mail" | "calendar" | "error";

/** The shortest time between two plays of the same sound. */
export const MIN_GAP_MS = 750;

interface Tone {
    /** Pitch in Hz at the start. */
    frequency: number;
    /** Pitch in Hz at the end, when it slides. */
    endFrequency?: number;
    /** Seconds after the sound starts. */
    start: number;
    /** Seconds it takes to die away. */
    duration: number;
    type: OscillatorType;
    /** Peak loudness, 0 to 1. */
    gain: number;
}

/** A soft two-note rising chime. */
const CHIME: Tone[] = [
    { frequency: 1046.5, start: 0, duration: 0.5, type: "sine", gain: 0.16 },
    { frequency: 1568, start: 0.14, duration: 0.8, type: "sine", gain: 0.14 },
];

/** A struck bell, twice: a fundamental with the inharmonic partials of a bell, each dying away slowly. */
const BELL: Tone[] = [0, 0.75].flatMap((start) =>
    [
        { ratio: 1, gain: 0.16, duration: 1.4 },
        { ratio: 2.76, gain: 0.08, duration: 1.0 },
        { ratio: 5.4, gain: 0.04, duration: 0.7 },
        { ratio: 8.93, gain: 0.02, duration: 0.4 },
    ].map<Tone>((partial) => ({ frequency: 880 * partial.ratio, start, duration: partial.duration, type: "sine", gain: partial.gain })),
);

/** Two short falling buzzes - nothing like the other two. */
const ERROR: Tone[] = [
    { frequency: 300, endFrequency: 190, start: 0, duration: 0.2, type: "sawtooth", gain: 0.09 },
    { frequency: 300, endFrequency: 190, start: 0.26, duration: 0.2, type: "sawtooth", gain: 0.09 },
];

const SOUNDS: Record<NotificationSound, Tone[]> = { mail: CHIME, calendar: BELL, error: ERROR };

let context: AudioContext | undefined;
const lastPlayed: Partial<Record<NotificationSound, number>> = {};

function audioContext(): AudioContext | undefined {
    if (context) {
        return context;
    }
    const Ctor: typeof AudioContext | undefined =
        typeof window === "undefined" ? undefined : (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
    if (!Ctor) {
        return undefined;
    }
    try {
        context = new Ctor();
    } catch {
        return undefined;
    }
    return context;
}

function playTone(audio: AudioContext, tone: Tone): void {
    const begin = audio.currentTime + tone.start;
    const end = begin + tone.duration;
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.frequency, begin);
    if (tone.endFrequency !== undefined) {
        oscillator.frequency.exponentialRampToValueAtTime(tone.endFrequency, end);
    }
    // A short attack so it doesn't click, then an exponential die-away.
    volume.gain.setValueAtTime(0.0001, begin);
    volume.gain.exponentialRampToValueAtTime(tone.gain, begin + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(volume);
    volume.connect(audio.destination);
    oscillator.start(begin);
    oscillator.stop(end + 0.05);
}

/** Plays `sound`, unless the person turned notification sounds off, the same sound just played, or the browser won't make sound yet. Never throws. */
export function playNotificationSound(sound: NotificationSound, now: number = Date.now()): void {
    if (!getNotificationSoundsEnabled()) {
        return;
    }
    const last = lastPlayed[sound];
    if (last !== undefined && now - last < MIN_GAP_MS) {
        return;
    }
    try {
        const audio = audioContext();
        if (!audio) {
            return;
        }
        lastPlayed[sound] = now;
        const play = (): void => {
            for (const tone of SOUNDS[sound]) {
                playTone(audio, tone);
            }
        };
        if (audio.state === "suspended") {
            // Allowed once the page has been interacted with; until then this is refused and the sound is skipped.
            void audio.resume().then(play, () => undefined);
        } else {
            play();
        }
    } catch {
        // Audio is a nicety: a failure to make a sound never reaches the notification.
    }
}

/** Forgets the audio context and what was played when - for tests. */
export function resetNotificationSounds(): void {
    context = undefined;
    for (const key of Object.keys(lastPlayed) as NotificationSound[]) {
        delete lastPlayed[key];
    }
}
