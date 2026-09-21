// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setReadState, setReadStateMany } from "../../../apps/shared/mail/messageReadState.js";

const { setMessageRead, setMessagesRead } = vi.hoisted(() => ({ setMessageRead: vi.fn(), setMessagesRead: vi.fn() }));
vi.mock("@rapidmx/react-shared/mail/mailApi.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@rapidmx/react-shared/mail/mailApi.js")>()),
    setMessageRead,
    setMessagesRead,
}));

const message = (uid: string, read: boolean | undefined, version = 1) =>
    ({ uid, version, folderUid: "f1", mailboxUid: "mb1", flags: read === undefined ? { flagged: false } : { read, flagged: false } }) as any;

function sink() {
    const trackers: { settle: ReturnType<typeof vi.fn>; revert: ReturnType<typeof vi.fn> }[] = [];
    const events: string[] = [];
    return {
        trackers,
        events,
        patch: vi.fn((updated: any, previous?: any) => {
            events.push(`patch:${updated.uid}:${updated.flags.read}:v${updated.version}${previous ? `<-${previous.flags.read}` : ""}`);
        }),
        track: vi.fn((previous: any, next: any) => {
            events.push(`track:${previous.flags.read}->${next.flags.read}`);
            const tracker = { settle: vi.fn(() => events.push("settle")), revert: vi.fn(() => events.push("revert")) };
            trackers.push(tracker);
            return tracker;
        }),
    };
}

beforeEach(() => {
    setMessageRead.mockReset();
    setMessagesRead.mockReset();
});

describe("setReadState", () => {
    it("changes the row and the badge first, then asks the server, then swaps in its copy and keeps the change", async () => {
        const s = sink();
        const original = message("m1", false);
        let answer!: (value: any) => void;
        setMessageRead.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

        const pending = setReadState(original, true, s);
        // Before the server has said anything:
        expect(s.events).toEqual(["patch:m1:true:v1<-false", "track:false->true"]);
        expect(setMessageRead).toHaveBeenCalledWith(original, true);

        answer(message("m1", true, 2));
        expect(await pending).toEqual(message("m1", true, 2));
        expect(s.events).toEqual(["patch:m1:true:v1<-false", "track:false->true", "patch:m1:true:v2", "settle"]);
    });

    it("puts everything back when the server refuses, and resolves nothing", async () => {
        const s = sink();
        const original = message("m1", false);
        setMessageRead.mockRejectedValue(new Error("409"));

        expect(await setReadState(original, true, s)).toBeUndefined();
        expect(s.events).toEqual(["patch:m1:true:v1<-false", "track:false->true", "patch:m1:false:v1<-true", "revert"]);
        // The original object itself is what goes back, so the row is exactly what it was.
        expect(s.patch).toHaveBeenLastCalledWith(original, expect.objectContaining({ uid: "m1" }));
    });

    it("marks a message unread the same way", async () => {
        const s = sink();
        setMessageRead.mockResolvedValue(message("m1", false, 2));
        await setReadState(message("m1", true), false, s);
        expect(s.events[0]).toBe("patch:m1:false:v1<-true");
        expect(setMessageRead).toHaveBeenCalledWith(expect.anything(), false);
    });

    it("does nothing for a message already in the state asked for - one with no read flag is unread", async () => {
        const s = sink();
        expect(await setReadState(message("m1", true), true, s)).toBeUndefined();
        expect(await setReadState(message("m2", false), false, s)).toBeUndefined();
        expect(await setReadState(message("m3", undefined), false, s)).toBeUndefined();
        expect(s.events).toEqual([]);
        expect(setMessageRead).not.toHaveBeenCalled();
    });
});

describe("setReadStateMany", () => {
    it("changes every row that needs it at once, sends the whole selection in one request, then swaps in the server's copies", async () => {
        const s = sink();
        const selection = [message("a", false), message("b", true), message("c", undefined)];
        let answer!: (value: any) => void;
        setMessagesRead.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

        const pending = setReadStateMany(selection, true, s);
        // `b` was already read: no change to show or count.
        expect(s.events).toEqual(["patch:a:true:v1<-false", "track:false->true", "patch:c:true:v1<-undefined", "track:undefined->true"]);
        expect(setMessagesRead).toHaveBeenCalledWith(selection, true);

        const updated = [message("a", true, 2), message("b", true, 2), message("c", true, 2)];
        answer(updated);
        expect(await pending).toBe(updated);
        expect(s.events.slice(4)).toEqual(["patch:a:true:v2", "patch:b:true:v2", "patch:c:true:v2", "settle", "settle"]);
    });

    it("reverts every optimistic change and rejects when the server refuses part of it", async () => {
        const s = sink();
        setMessagesRead.mockRejectedValue(new Error("409"));

        await expect(setReadStateMany([message("a", true), message("b", true)], false, s)).rejects.toThrow("409");
        expect(s.events).toEqual([
            "patch:a:false:v1<-true",
            "track:true->false",
            "patch:b:false:v1<-true",
            "track:true->false",
            "patch:a:true:v1<-false",
            "revert",
            "patch:b:true:v1<-false",
            "revert",
        ]);
    });

    it("has nothing to show or count for a selection already in that state, but still asks the server", async () => {
        const s = sink();
        setMessagesRead.mockResolvedValue([message("a", true, 2)]);
        await setReadStateMany([message("a", true)], true, s);
        expect(s.track).not.toHaveBeenCalled();
        expect(s.patch).toHaveBeenCalledTimes(1);
    });
});
