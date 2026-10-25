///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * The organizer's side of a protected video meeting (meet-plugin `specs/meeting_privacy.md`): a meeting whose organizer has a zero-access
 * key gets a temporary meeting key, made here. Its title and invitees' names are sealed to the meeting key and the organizer's
 * zero-access certificate; the meeting key itself is wrapped to the organizer's zero-access certificate, so any of the organizer's
 * devices can reopen it; and every participant's link carries the key after `#k=`, which this module supplies on each save that sends an
 * invitation (`invitationContent.meetingLinkSecrets`) and on the organizer's own join link - never stored by the server.
 *
 * The meeting key is discarded an hour after the event ends (the last occurrence's end for a series with an end; five years at most).
 */
import { fromBase64, toBase64 } from "../crypto/encoding.js";
import { getUnlockedKeys } from "../crypto/keySession.js";
import { generateMeetingKey, meetingKeyFragment } from "../crypto/meetingKeys.js";
import { decryptEnvelopedDataWithKeys, encryptForRecipients } from "../crypto/smime.js";
import type { ApiClient } from "../util/api.js";
import { getVideoMeeting, type VideoMeetingDetail, type VideoMeetingInvitee } from "./videoMeetingsApi.js";

/** How long after the meeting ends its key is kept (`mail:videoconf:key_grace_minutes`' default). */
export const MEETING_KEY_GRACE_MS = 60 * 60_000;

/** The longest a meeting key is kept: a series without an end keeps it this long, just inside the server's limit. */
const MAX_KEY_LIFETIME_MS = 5 * 365 * 24 * 60 * 60_000;

/** What `createVideoMeeting()` sends to protect a meeting. */
export interface MeetingProtectionInput {
    meetingKey: { certificate: string };
    keyExpiresAt: string;
    keyWraps: { mailboxUid: string; recipientFingerprint: string; kind: "meeting-key"; cms: string }[];
    sealedFields: { title: string };
}

/** A protected meeting's fields, as the server returns them to its organizer. */
export interface ProtectedMeetingFields {
    keyProtected?: boolean | null;
    keyWraps?: { mailboxUid: string; recipientFingerprint: string; kind: string; cms: string }[] | null;
}

/** Link keys by meeting uid, for this page's life: a protected meeting's key is opened once. `null`: a meeting known to be unprotected. */
const fragments = new Map<string, string | null>();

/** Forgets every opened meeting key (sign-out, or the test seam). */
export function clearMeetingKeys(): void {
    fragments.clear();
}

/** When a meeting ending at `endDate` - the last occurrence's end, for a series that has one - has its key discarded. */
export function meetingKeyExpiry(endDate: Date, now: number = Date.now()): Date {
    return new Date(Math.min(endDate.valueOf() + MEETING_KEY_GRACE_MS, now + MAX_KEY_LIFETIME_MS));
}

/** The organizer mailbox's active zero-access key, while the mailbox is unlocked. */
function organizerKey(mailboxUid: string): { certDer: Uint8Array; fingerprint: string; privateKey: CryptoKey } | undefined {
    return getUnlockedKeys(mailboxUid)?.zeroAccessKeys?.[0];
}

/** What protects a new meeting of `mailboxUid` titled `title` with `invitees`, its key discarded at `expiresAt` - or `undefined` when
 * the mailbox has no zero-access key unlocked here (the meeting is then not protected). `fragment` is every participant's link key. */
export async function protectMeeting(
    mailboxUid: string,
    title: string,
    invitees: VideoMeetingInvitee[],
    expiresAt: Date,
): Promise<{ protection: MeetingProtectionInput; invitees: { email: string; sealedFields?: { displayName: string } }[]; fragment: string } | undefined> {
    const organizer = organizerKey(mailboxUid);
    if (!organizer) {
        return undefined;
    }
    const key = await generateMeetingKey(expiresAt);
    const seal = async (value: unknown): Promise<string> =>
        toBase64(await encryptForRecipients(new TextEncoder().encode(JSON.stringify(value)), [key.certificateDer, organizer.certDer]));
    return {
        protection: {
            meetingKey: { certificate: toBase64(key.certificateDer) },
            keyExpiresAt: expiresAt.toISOString(),
            keyWraps: [{ mailboxUid, recipientFingerprint: organizer.fingerprint, kind: "meeting-key", cms: toBase64(await encryptForRecipients(key.pkcs8, [organizer.certDer])) }],
            sealedFields: { title: await seal(title) },
        },
        invitees: await Promise.all(
            invitees.map(async (invitee) => (invitee.displayName ? { email: invitee.email, sealedFields: { displayName: await seal(invitee.displayName) } } : { email: invitee.email })),
        ),
        fragment: meetingKeyFragment(key.pkcs8),
    };
}

/** Remembers a just-created meeting's link key - `null` for one that isn't protected - so the save that invites to it needn't fetch the
 * meeting or reopen its wrap. */
export function rememberMeetingKey(meetingUid: string, fragment: string | null): void {
    fragments.set(meetingUid, fragment);
}

/** `meeting`'s link key - remembered, or opened from the organizer's wrap with the mailbox's unlocked zero-access keys - or `undefined`
 * when it isn't protected or can't be opened here. Never rejects. */
export async function meetingKeyFragmentOf(meeting: VideoMeetingDetail & ProtectedMeetingFields): Promise<string | undefined> {
    if (!meeting.keyProtected) {
        return undefined;
    }
    const known = fragments.get(meeting.uid);
    if (known !== undefined) {
        return known ?? undefined;
    }
    const keys = getUnlockedKeys(meeting.mailboxUid)?.zeroAccessKeys;
    const wrap = meeting.keyWraps?.find((candidate) => keys?.some((key) => key.fingerprint === candidate.recipientFingerprint));
    if (!keys?.length || !wrap) {
        return undefined;
    }
    try {
        const fragment = meetingKeyFragment(await decryptEnvelopedDataWithKeys(fromBase64(wrap.cms), keys));
        fragments.set(meeting.uid, fragment);
        return fragment;
    } catch {
        return undefined;
    }
}

/** `meeting`'s organizer join link, with the meeting key after `#` when it is protected - `null` when there is none, or the key can't
 * be opened here (a protected meeting can't be joined without it). */
export async function organizerJoinLink(meeting: VideoMeetingDetail & ProtectedMeetingFields): Promise<string | null> {
    if (!meeting.organizerJoinUrl) {
        return null;
    }
    if (!meeting.keyProtected) {
        return meeting.organizerJoinUrl;
    }
    const fragment = await meetingKeyFragmentOf(meeting);
    return fragment ? `${meeting.organizerJoinUrl}#${fragment}` : null;
}

/** For a save of `event` that may invite: every attendee's link key (`invitationContent.meetingLinkSecrets`), when its video meeting is
 * protected and its key opens here - else `undefined`. Never rejects. */
export async function meetingLinkSecrets(
    event: { videoMeetingUid?: string | null; attendees?: { address: string }[]; organizer?: { address: string } },
    client?: ApiClient,
): Promise<Record<string, string> | undefined> {
    if (!event.videoMeetingUid) {
        return undefined;
    }
    try {
        const known = fragments.get(event.videoMeetingUid);
        const fragment = known !== undefined ? known : await meetingKeyFragmentOf(await getVideoMeeting(event.videoMeetingUid, client));
        if (!fragment) {
            return undefined;
        }
        const organizer = event.organizer?.address.trim().toLowerCase();
        const secrets: Record<string, string> = {};
        for (const attendee of event.attendees ?? []) {
            const address = attendee.address.trim().toLowerCase();
            if (address && address !== organizer) {
                secrets[address] = fragment;
            }
        }
        return Object.keys(secrets).length > 0 ? secrets : undefined;
    } catch {
        return undefined;
    }
}
