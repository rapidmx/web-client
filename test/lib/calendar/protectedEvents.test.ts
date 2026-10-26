// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it, vi } from "vitest";
import { KeysLockedError } from "../../../lib/crypto/masterKey.js";

const { isOpenedRecord } = vi.hoisted(() => ({ isOpenedRecord: vi.fn((record: any) => !!record?.opened) }));
vi.mock("../../../lib/zeroAccess/sealedRecords.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/zeroAccess/sealedRecords.js")>()),
    isOpenedRecord,
}));

const { invitationContentOf, isSealedContentOpened, markSealedContentOpened, protectedEventWrite } = await import("../../../lib/calendar/protectedEvents.js");

const sealedFields = { title: "c", location: "c", description: "c" };
const openedEvent: any = { uid: "e1", mailboxUid: "mb", title: "Board meeting", location: "Room 4", description: "Agenda", descriptionHtml: null, sealedFields, opened: true };
const lockedEvent: any = { uid: "e1", mailboxUid: "mb", title: "Protected event", location: null, description: null, sealedFields };

describe("protectedEvents", () => {
    it("leaves a write to an unprotected event as it is", () => {
        const input = { uid: "e1", version: 1, title: "Same", location: null };
        expect(protectedEventWrite({ ...openedEvent, sealedFields: null }, input)).toBe(input);
        expect(protectedEventWrite(undefined, input)).toBe(input);
    });

    it("sends only the content that changed, with the whole content to invite with", () => {
        expect(protectedEventWrite(openedEvent, { uid: "e1", version: 1, title: "Board meeting", location: "Room 5", description: "Agenda", startDate: "s" })).toEqual({
            uid: "e1",
            version: 1,
            location: "Room 5",
            startDate: "s",
            invitationContent: { title: "Board meeting", location: "Room 5", description: "Agenda", descriptionHtml: undefined },
        });
        // A cleared field is a change, named as cleared (the server applies an empty sealed field only then), and leaves it out of the
        // invitation. One that isn't sealed needs no naming.
        expect(protectedEventWrite({ ...openedEvent, descriptionHtml: "<p>Agenda</p>" }, { uid: "e1", version: 1, location: null, descriptionHtml: null })).toEqual({
            uid: "e1",
            version: 1,
            location: null,
            descriptionHtml: null,
            clearedFields: ["location"],
            invitationContent: { title: "Board meeting", location: undefined, description: "Agenda", descriptionHtml: undefined },
        });
    });

    it("never overwrites the sealed content from a device showing placeholders, nor invites with them", () => {
        expect(protectedEventWrite(lockedEvent, { uid: "e1", version: 1, title: "Protected event", location: null, description: "", startDate: "s" })).toEqual({
            uid: "e1",
            version: 1,
            startDate: "s",
        });
        // Nor clears one: a device that couldn't open it doesn't know what it holds.
        expect(protectedEventWrite(lockedEvent, { uid: "e1", version: 1, title: "" })).toEqual({ uid: "e1", version: 1, title: "" });
        expect(invitationContentOf(lockedEvent)).toBeUndefined();
        expect(invitationContentOf({ ...openedEvent, sealedFields: undefined })).toBeUndefined();
        expect(invitationContentOf({ ...openedEvent, title: "" })).toBeUndefined();
    });

    it("names an event made from a zero-access invitation (sealedContent) by its content once it was opened here", () => {
        const sealedContent = { keyFingerprint: "f", sealed: "c" };
        const unopened: any = { uid: "e2", mailboxUid: "mb", title: "[...]", location: null, description: null, sealedContent };
        expect(invitationContentOf(unopened)).toBeUndefined();
        const opened = markSealedContentOpened({ ...unopened, title: "Offsite", location: "Lisbon", description: "Plan" });
        expect(isSealedContentOpened(opened)).toBe(true);
        expect(isSealedContentOpened(unopened)).toBe(false);
        // An occurrence is a spread copy: still opened.
        expect(invitationContentOf({ ...opened, startDate: "s" })).toEqual({ title: "Offsite", location: "Lisbon", description: "Plan", descriptionHtml: undefined });
        // A write without content is left as it is.
        const input = { uid: "e2", version: 1, startDate: "s" };
        expect(protectedEventWrite(opened, input)).toBe(input);
        // Sealed field by field as well: both parts must be opened.
        expect(invitationContentOf({ ...opened, sealedFields })).toBeUndefined();
        expect(invitationContentOf({ ...opened, sealedFields, opened: true })).toEqual({ title: "Offsite", location: "Lisbon", description: "Plan", descriptionHtml: undefined });
    });

    describe("a write to an event made from a zero-access invitation (sealedContent), which restapi seals again whole from what it sends", () => {
        const sealedContent = { keyFingerprint: "f", sealed: "c" };
        const opened: any = markSealedContentOpened({
            uid: "e2",
            mailboxUid: "mb",
            title: "Offsite",
            location: "Lisbon",
            description: "Plan",
            descriptionHtml: "<p>Plan</p>",
            sealedContent,
        } as any);

        it("sends the content it leaves out as shown, so an edit of one field never drops the others", () => {
            // The editor's save of a changed time: title and location, but the unchanged description not at all.
            expect(protectedEventWrite(opened, { uid: "e2", version: 1, title: "Offsite", location: "Lisbon", startDate: "s" })).toEqual({
                uid: "e2",
                version: 1,
                title: "Offsite",
                location: "Lisbon",
                description: "Plan",
                descriptionHtml: "<p>Plan</p>",
                startDate: "s",
            });
            // A description edit sends its own pair, and the title and location it left out.
            expect(protectedEventWrite(opened, { uid: "e2", version: 1, description: "New", descriptionHtml: "<p>New</p>" })).toEqual({
                uid: "e2",
                version: 1,
                title: "Offsite",
                location: "Lisbon",
                description: "New",
                descriptionHtml: "<p>New</p>",
            });
            // A cleared field stays cleared, and a description sent alone keeps its own meaning (its HTML cleared).
            expect(protectedEventWrite({ ...opened, location: undefined, descriptionHtml: null }, { uid: "e2", version: 1, location: null, description: "Plain" })).toEqual({
                uid: "e2",
                version: 1,
                title: "Offsite",
                location: null,
                description: "Plain",
            });
            // An untitled one (opened to an empty title) sends it empty, and nothing it doesn't hold.
            expect(protectedEventWrite(markSealedContentOpened({ ...opened, title: "", location: undefined, description: null, descriptionHtml: undefined }), { uid: "e2", version: 1, location: "Room 2" })).toEqual({
                uid: "e2",
                version: 1,
                title: "",
                location: "Room 2",
                description: null,
                descriptionHtml: null,
                sequence: 1,
            });
        });

        it("raises the sequence past the opened one only when the location it sends differs, so the server knows to invite again", () => {
            const meeting = markSealedContentOpened({ ...opened, sequence: 4 });
            // Unchanged location (a reminder or title change): the stored sequence stays.
            expect(protectedEventWrite(meeting, { uid: "e2", version: 1, title: "Offsite", location: "Lisbon", reminders: [] })).not.toHaveProperty("sequence");
            expect(protectedEventWrite(meeting, { uid: "e2", version: 1, description: "New" })).not.toHaveProperty("sequence");
            // Moved, or cleared.
            expect(protectedEventWrite(meeting, { uid: "e2", version: 1, title: "Offsite", location: "Porto" })).toMatchObject({ location: "Porto", sequence: 5 });
            expect(protectedEventWrite(meeting, { uid: "e2", version: 1, location: null })).toMatchObject({ location: null, sequence: 5 });
            // A placeholder shown (not opened) is never a change.
            const locked: any = { uid: "e2", mailboxUid: "mb", title: "[...]", location: null, description: null, sealedContent, sequence: 4 };
            expect(protectedEventWrite(locked, { uid: "e2", version: 1, title: "[...]", location: null })).not.toHaveProperty("sequence");
        });

        it("sends the whole opened content of one that also keeps its title sealed field by field, and invites with it", () => {
            // A revision without SUMMARY over a row whose title is sealed field by field: its sealed content's title is empty, the title
            // shown is the per-field one.
            const both: any = { ...opened, sealedFields: { title: "c" }, opened: true };
            expect(protectedEventWrite(both, { uid: "e2", version: 1, title: "Offsite", location: "Lisbon", description: "New", descriptionHtml: "<p>New</p>" })).toEqual({
                uid: "e2",
                version: 1,
                title: "Offsite",
                location: "Lisbon",
                description: "New",
                descriptionHtml: "<p>New</p>",
                invitationContent: { title: "Offsite", location: "Lisbon", description: "New", descriptionHtml: "<p>New</p>" },
            });
            expect(protectedEventWrite(both, { uid: "e2", version: 1, title: "Retreat" })).toMatchObject({
                title: "Retreat",
                location: "Lisbon",
                description: "Plan",
                descriptionHtml: "<p>Plan</p>",
                invitationContent: { title: "Retreat", location: "Lisbon" },
            });
        });

        it("never sends the placeholders of one it couldn't open, and refuses a content change it can't send whole", () => {
            const locked: any = { uid: "e2", mailboxUid: "mb", title: "[...]", location: null, description: null, sealedContent };
            expect(protectedEventWrite(locked, { uid: "e2", version: 1, title: "[...]", location: null, startDate: "s" })).toEqual({ uid: "e2", version: 1, startDate: "s" });
            expect(() => protectedEventWrite(locked, { uid: "e2", version: 1, title: "[...]", location: "Room 2" })).toThrow(KeysLockedError);
            // Opened field by field but not its sealed content: not shown opened either.
            expect(() => protectedEventWrite({ ...locked, sealedFields: { title: "c" }, opened: true, title: "Offsite" }, { uid: "e2", version: 1, title: "Offsite", description: "New" })).toThrow(
                /Unlock it to change its title/,
            );
        });
    });
});
