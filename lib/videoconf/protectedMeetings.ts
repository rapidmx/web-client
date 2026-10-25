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
import { getUnlockedKeys, subscribeKeySession } from "../crypto/keySession.js";
import { generateMeetingKey, meetingKeyFragment } from "../crypto/meetingKeys.js";
import { decryptEnvelopedDataWithKeys, encryptForRecipients } from "../crypto/smime.js";
import type { ApiClient } from "../util/api.js";
import { getVideoMeeting, updateVideoMeeting, type VideoMeetingDetail, type VideoMeetingInvitee } from "./videoMeetingsApi.js";

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
    /** When the meeting key is discarded (ISO). */
    keyExpiresAt?: string | null;
}

/** Link keys by meeting uid, each with the organizer mailbox it belongs to: a protected meeting's key is opened once, and forgotten when
 * that mailbox's keys are locked. `fragment: null`: a meeting known to be unprotected. */
const fragments = new Map<string, { mailboxUid: string; fragment: string | null }>();

/** Forgets every opened meeting key (sign-out, or the test seam). */
export function clearMeetingKeys(): void {
    fragments.clear();
}

let watchingKeys = false;

/** Records `uid`'s link key, forgetting it - like everything opened with a mailbox's keys - once that mailbox locks. Subscribed on the
 * first key remembered, not on import. */
function remember(uid: string, mailboxUid: string, fragment: string | null): void {
    if (!watchingKeys) {
        watchingKeys = true;
        subscribeKeySession(({ mailboxUid: locked, state }) => {
            if (state === "locked") {
                for (const [meetingUid, entry] of fragments) {
                    if (entry.mailboxUid === locked) {
                        fragments.delete(meetingUid);
                    }
                }
            }
        });
    }
    // A key opened or minted across an await the mailbox locked during: the lock's clear has already run, so it isn't kept.
    if (fragment !== null && !getUnlockedKeys(mailboxUid)) {
        return;
    }
    fragments.set(uid, { mailboxUid, fragment });
}

/** Meeting `uid`'s remembered link key - `null` for one known to be unprotected - or `undefined` when none is remembered, or its mailbox
 * isn't unlocked here (a key is never handed out past its mailbox's lock). */
function rememberedFragment(uid: string): string | null | undefined {
    const entry = fragments.get(uid);
    if (!entry || (entry.fragment !== null && !getUnlockedKeys(entry.mailboxUid))) {
        return undefined;
    }
    return entry.fragment;
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
 * meeting or reopen its wrap. `mailboxUid` is the organizer's mailbox: its lock forgets the key. */
export function rememberMeetingKey(meetingUid: string, fragment: string | null, mailboxUid: string): void {
    remember(meetingUid, mailboxUid, fragment);
}

/** `meeting`'s link key - remembered, or opened from the organizer's wrap with the mailbox's unlocked zero-access keys - or `undefined`
 * when it isn't protected or can't be opened here. Never rejects. */
export async function meetingKeyFragmentOf(meeting: VideoMeetingDetail & ProtectedMeetingFields): Promise<string | undefined> {
    if (!meeting.keyProtected) {
        return undefined;
    }
    const known = rememberedFragment(meeting.uid);
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
        // Locked while it was opened: neither kept nor handed out.
        if (!getUnlockedKeys(meeting.mailboxUid)) {
            return undefined;
        }
        remember(meeting.uid, meeting.mailboxUid, fragment);
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
        const known = rememberedFragment(event.videoMeetingUid);
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

/**
 * Moves the key expiry of meeting `meetingUid` - when it is protected - to follow its event's new end, `endDate` (the last occurrence's
 * end, for a series): its key is discarded an hour after the end it was made for, so a meeting moved later (or a series extended) would
 * otherwise be unjoinable by then. Best effort, after the event itself is saved: a failure is logged, never thrown.
 */
export async function followMeetingKeyExpiry(meetingUid: string, endDate: Date, client?: ApiClient): Promise<void> {
    try {
        if (fragments.get(meetingUid)?.fragment === null) {
            return;
        }
        const meeting: VideoMeetingDetail & ProtectedMeetingFields = await getVideoMeeting(meetingUid, client);
        const keyExpiresAt = meetingKeyExpiry(endDate);
        // Unprotected, or already right to the minute (an unchanged end).
        if (!meeting.keyProtected || (meeting.keyExpiresAt && Math.abs(new Date(meeting.keyExpiresAt).valueOf() - keyExpiresAt.valueOf()) < 60_000)) {
            return;
        }
        await updateVideoMeeting(meetingUid, { keyExpiresAt: keyExpiresAt.toISOString() }, client);
    } catch (err) {
        console.warn("Could not move the video meeting's key expiry to the event's new end", err);
    }
}
