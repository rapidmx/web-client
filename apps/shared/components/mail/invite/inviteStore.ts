///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { useCallback, useEffect, useReducer } from "react";
import { MessageInvite, getMessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";

/**
 * A per-message cache of the calendar invitation the server reads out of a message, shared by everything that draws one: the reading pane's
 * card, the list row's RSVP chip and its popover. They ask for the same message a moment apart (the row's chip, then the pane once it is
 * opened), and an answer given in one has to show in the others, so a lookup is made once and every answer goes through `storeInvite()`.
 *
 * A message with no invitation (`null`, the server's 404) is remembered too. A lookup that fails is not - nothing is cached and the next
 * thing to ask (a remount, another row) tries again - but nothing retries on its own. An entry goes stale after `INVITE_TTL_MS`, because the
 * calendar it describes can change elsewhere (the meeting deleted, another device answering); it is refetched when next asked for.
 */

/** How long a looked-up invitation is trusted before the next ask reads it again. */
export const INVITE_TTL_MS = 30_000;

interface Entry {
    promise: Promise<MessageInvite | null>;
    /** `undefined` until the lookup answers; `null` for a message with no readable invitation. */
    value?: MessageInvite | null;
    at: number;
}

const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();

function notify(uid: string): void {
    listeners.get(uid)?.forEach((listener) => listener());
}

/** Older servers, or a partial answer, may leave a list out: a card must never fail to draw over one. */
function normalize(invite: MessageInvite | null): MessageInvite | null {
    if (!invite) {
        return null;
    }
    const partial: Partial<MessageInvite> = invite;
    return { ...invite, attendees: partial.attendees ?? [], conflicts: partial.conflicts ?? [], schedule: partial.schedule ?? [] };
}

/** Reads a message's invitation, from the cache when it is fresh. Rejects when the lookup fails. */
export function loadInvite(uid: string): Promise<MessageInvite | null> {
    const existing = entries.get(uid);
    if (existing && (existing.value === undefined || Date.now() - existing.at < INVITE_TTL_MS)) {
        return existing.promise;
    }
    const entry: Entry = {
        at: Date.now(),
        promise: getMessageInvite(uid).then(
            (invite) => {
                entry.value = normalize(invite);
                entry.at = Date.now();
                notify(uid);
                return entry.value;
            },
            (err: unknown) => {
                if (entries.get(uid) === entry) {
                    entries.delete(uid);
                }
                throw err;
            },
        ),
    };
    entries.set(uid, entry);
    return entry.promise;
}

/** Records the invitation as it now stands after an answer, so the pane, the chip and the popover all show it. */
export function storeInvite(uid: string, invite: MessageInvite): void {
    const value = normalize(invite);
    entries.set(uid, { promise: Promise.resolve(value), value, at: Date.now() });
    notify(uid);
}

/** Forgets everything - for tests, and for a sign-out. */
export function clearInviteCache(): void {
    entries.clear();
}

/**
 * A message's invitation, looked up once (shared with every other user of the same message) when `enabled`. `invite` is `null` until it is
 * known, and stays `null` for a message with none or a lookup that failed - nothing to draw either way. `settled` says the lookup is over.
 * Nothing is asked while disabled, and a failure is never retried from here.
 */
export function useMessageInvite(uid: string, enabled = true): { invite: MessageInvite | null; settled: boolean; setInvite: (invite: MessageInvite) => void } {
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        if (!enabled) {
            return;
        }
        let cancelled = false;
        const update = () => {
            if (!cancelled) {
                rerender();
            }
        };
        const set = listeners.get(uid) ?? new Set();
        set.add(update);
        listeners.set(uid, set);
        loadInvite(uid).then(update, () => {
            // Nothing to show, and nothing worth interrupting the reader with: the message reads the same without it.
        });
        return () => {
            cancelled = true;
            set.delete(update);
        };
    }, [uid, enabled]);
    const setInvite = useCallback((invite: MessageInvite) => storeInvite(uid, invite), [uid]);
    const value = enabled ? entries.get(uid)?.value : undefined;
    return { invite: value ?? null, settled: value !== undefined, setInvite };
}
