// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64 } from "../../../lib/crypto/encoding.js";
import { generateMeetingKey, importMeetingKey, readMeetingKeyFragment } from "../../../lib/crypto/meetingKeys.js";
import { decryptEnvelopedDataWithKeys } from "../../../lib/crypto/smime.js";

const { getUnlockedKeys, getVideoMeeting } = vi.hoisted(() => ({ getUnlockedKeys: vi.fn(), getVideoMeeting: vi.fn() }));
vi.mock("../../../lib/crypto/keySession.js", () => ({ getUnlockedKeys }));
vi.mock("../../../lib/videoconf/videoMeetingsApi.js", () => ({ getVideoMeeting }));

const { clearMeetingKeys, meetingKeyExpiry, meetingKeyFragmentOf, meetingLinkSecrets, organizerJoinLink, protectMeeting, rememberMeetingKey, MEETING_KEY_GRACE_MS } =
    await import("../../../lib/videoconf/protectedMeetings.js");

/** A stand-in for the organizer's zero-access key: a meeting key pair serves, being P-256 with a certificate. */
async function organizerZeroAccessKey() {
    const key = await generateMeetingKey(new Date(Date.now() + 86_400_000));
    const { decryptionKey } = await importMeetingKey(key.pkcs8, key.certificateDer, "unused");
    return { certDer: key.certificateDer, privateKey: decryptionKey.privateKey, fingerprint: key.fingerprint };
}

afterEach(() => {
    clearMeetingKeys();
    vi.clearAllMocks();
});

describe("protectedMeetings", () => {
    it("protects nothing while the organizer's mailbox has no zero-access key unlocked", async () => {
        getUnlockedKeys.mockReturnValue(undefined);
        expect(await protectMeeting("mb", "Board", [{ email: "g@example.org" }], new Date(Date.now() + 60_000))).toBeUndefined();
    });

    it("seals the title and names to the meeting key and the organizer, wraps the key to the organizer, and gives every link the key", async () => {
        const organizer = await organizerZeroAccessKey();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [organizer] });
        const secured = (await protectMeeting("mb", "Board meeting", [{ email: "g@example.org", displayName: "Grace" }, { email: "h@example.org" }], new Date(Date.now() + 60_000)))!;

        const pkcs8 = readMeetingKeyFragment(secured.fragment)!;
        const { decryptionKey } = await importMeetingKey(pkcs8, fromBase64(secured.protection.meetingKey.certificate), "m1");
        const open = async (b64: string, keys: any[]) => JSON.parse(new TextDecoder().decode(await decryptEnvelopedDataWithKeys(fromBase64(b64), keys)));
        // The meeting key opens the title and names, and so does the organizer's own key.
        expect(await open(secured.protection.sealedFields.title, [decryptionKey])).toBe("Board meeting");
        expect(await open(secured.protection.sealedFields.title, [organizer])).toBe("Board meeting");
        expect(await open(secured.invitees[0].sealedFields!.displayName, [decryptionKey])).toBe("Grace");
        expect(secured.invitees[1]).toEqual({ email: "h@example.org" });
        expect(secured.protection.keyWraps).toEqual([expect.objectContaining({ mailboxUid: "mb", recipientFingerprint: organizer.fingerprint, kind: "meeting-key" })]);
        expect(await decryptEnvelopedDataWithKeys(fromBase64(secured.protection.keyWraps[0].cms), [organizer])).toEqual(pkcs8);
    });

    it("reopens a meeting's key from the organizer's wrap, adds it to the organizer's link, and remembers it", async () => {
        const organizer = await organizerZeroAccessKey();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [organizer] });
        const secured = (await protectMeeting("mb", "Board", [], new Date(Date.now() + 60_000)))!;
        const meeting: any = { uid: "m1", mailboxUid: "mb", keyProtected: true, keyWraps: secured.protection.keyWraps, organizerJoinUrl: "https://meet.example/o" };

        expect(await organizerJoinLink(meeting)).toBe(`https://meet.example/o#${secured.fragment}`);
        getUnlockedKeys.mockReturnValue(undefined);
        // Remembered: it opens even once the mailbox is locked.
        expect(await meetingKeyFragmentOf(meeting)).toBe(secured.fragment);
        clearMeetingKeys();
        expect(await organizerJoinLink(meeting)).toBeNull();
        expect(await organizerJoinLink({ ...meeting, keyProtected: false })).toBe("https://meet.example/o");
        expect(await organizerJoinLink({ ...meeting, organizerJoinUrl: undefined })).toBeNull();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [await organizerZeroAccessKey()] });
        expect(await meetingKeyFragmentOf(meeting)).toBeUndefined();
        getUnlockedKeys.mockReturnValue({ zeroAccessKeys: [{ ...organizer, privateKey: (await organizerZeroAccessKey()).privateKey }] });
        expect(await meetingKeyFragmentOf(meeting)).toBeUndefined();
    });

    it("gives every attendee but the organizer the link key for a save of an event with a protected meeting", async () => {
        rememberMeetingKey("m1", "k=remembered");
        const event = { videoMeetingUid: "m1", organizer: { address: "Me@Example.com" }, attendees: [{ address: "me@example.com" }, { address: " Bob@Example.org " }] };
        expect(await meetingLinkSecrets(event)).toEqual({ "bob@example.org": "k=remembered" });
        expect(getVideoMeeting).not.toHaveBeenCalled();
        expect(await meetingLinkSecrets({ ...event, attendees: [{ address: "me@example.com" }] })).toBeUndefined();
        expect(await meetingLinkSecrets({ attendees: event.attendees })).toBeUndefined();
        // Known to be unprotected: nothing to fetch.
        rememberMeetingKey("plain", null);
        expect(await meetingLinkSecrets({ ...event, videoMeetingUid: "plain" })).toBeUndefined();
        expect(await meetingKeyFragmentOf({ uid: "plain", keyProtected: true } as any)).toBeUndefined();
        expect(getVideoMeeting).not.toHaveBeenCalled();

        getVideoMeeting.mockResolvedValueOnce({ uid: "m2", keyProtected: false });
        expect(await meetingLinkSecrets({ ...event, videoMeetingUid: "m2" })).toBeUndefined();
        getVideoMeeting.mockRejectedValueOnce(new Error("offline"));
        expect(await meetingLinkSecrets({ ...event, videoMeetingUid: "m3" })).toBeUndefined();
    });

    it("discards the key an hour after the meeting ends, and never more than five years ahead", () => {
        const now = Date.UTC(2026, 0, 1);
        expect(meetingKeyExpiry(new Date(now + 1000), now).valueOf()).toBe(now + 1000 + MEETING_KEY_GRACE_MS);
        expect(meetingKeyExpiry(new Date(8.64e15), now).valueOf()).toBe(now + 5 * 365 * 24 * 60 * 60_000);
    });
});
