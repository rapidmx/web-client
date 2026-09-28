///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * A mailbox's Blocked Senders and Safe Senders lists (`Mailbox.blockedSenders`, `Mailbox.safeSenders`) - typed wrappers over
 * `@rapidmx/restapi`'s `POST/DELETE /mail/mailboxes/:id/blocked-senders[/:entry]` and `.../safe-senders[/:entry]`, and the entry
 * normalizer that mirrors the server's, so a form can say what is wrong with what was typed before sending it.
 *
 * An entry is a plain lowercase address (`user@example.com`) or a domain (`@example.com` - that exact domain, not its subdomains). Adding
 * an entry to one list takes it off the other. Both lists are owner-level settings: every call needs FULL access to the mailbox (a 403
 * otherwise), which the mailbox's owner and a "manager" delegate have.
 */
import { ApiClient, withClient } from "../util/api.js";

/** The most entries one list may hold (a 400 past it). */
export const MAX_SENDER_LIST_ENTRIES = 1000;

/** The longest an entry may be, in characters (RFC 5321's forward-path limit). */
export const MAX_SENDER_ENTRY_LENGTH = 254;

/** Which list. */
export type SenderListKind = "blocked" | "safe";

/** What a change to a list answers: the entry as the server stored it, whether anything changed (`false` for an entry already there, or an absent one
 * removed), and both lists as they now are. */
export interface SenderListsChange {
    entry: string;
    changed: boolean;
    blockedSenders: string[];
    safeSenders: string[];
}

/** A DNS host name of at least two labels: letters, digits and inner hyphens, each label at most 63 characters, the whole at most 253. Lowercase input. */
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** One plain address: no display name, angle brackets, group, comment, list, quoting or whitespace. */
const PLAIN_ADDRESS_PATTERN = /^[^\s()<>@,;:\\"[\]]+@[^\s()<>@,;:\\"[\]]+$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;

function parseDomain(value: string): string | undefined {
    const trimmed = value.trim().toLowerCase();
    const domain = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    return domain.length <= MAX_SENDER_ENTRY_LENGTH && DOMAIN_PATTERN.test(domain) ? domain : undefined;
}

function parseAddress(value: string): string | undefined {
    const address = value.trim().toLowerCase();
    return address.length <= MAX_SENDER_ENTRY_LENGTH && !CONTROL_CHARACTER.test(address) && PLAIN_ADDRESS_PATTERN.test(address) ? address : undefined;
}

/**
 * `value` as the canonical entry the server stores, or `undefined` when the server would refuse it (a 400): trimmed and lowercased, a plain address
 * stays `user@example.com`, and a domain - typed `@example.com` or `example.com` - becomes `@example.com`, so the two spellings are one entry.
 */
export function normalizeSenderEntry(value: string): string | undefined {
    const trimmed = value.trim();
    if (trimmed.startsWith("@") || !trimmed.includes("@")) {
        const domain = parseDomain(trimmed);
        return domain === undefined ? undefined : `@${domain}`;
    }
    return parseAddress(trimmed);
}

/** What `checkSenderEntry()` decided about what was typed. */
export type SenderEntryCheck = { ok: true; entry: string; kind: "address" | "domain" } | { ok: false; message: string };

/**
 * Checks what a person typed into an "add a sender" field: `{ ok: true, entry, kind }` with the canonical entry (`normalizeSenderEntry()`), or
 * `{ ok: false, message }` with a sentence that says what is wrong - nothing typed, too long, a name with the address in angle brackets, more than one address, a
 * domain with a single label, a non-ASCII domain - fit to show under the field.
 */
export function checkSenderEntry(value: string): SenderEntryCheck {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return { ok: false, message: "Type an email address (name@example.com) or a domain (example.com)." };
    }
    if (trimmed.length > MAX_SENDER_ENTRY_LENGTH) {
        return { ok: false, message: `That is longer than ${MAX_SENDER_ENTRY_LENGTH} characters.` };
    }
    const entry = normalizeSenderEntry(trimmed);
    if (entry !== undefined) {
        return { ok: true, entry, kind: entry.startsWith("@") ? "domain" : "address" };
    }
    if (/[<>]/.test(trimmed)) {
        return { ok: false, message: "Type only the address, without a name or angle brackets: name@example.com." };
    }
    if (/[,;\s]/.test(trimmed)) {
        return { ok: false, message: "Add one address or domain at a time, with no spaces or commas." };
    }
    if (trimmed.startsWith("@") || !trimmed.includes("@")) {
        if (/[\u0080-￿]/.test(trimmed)) {
            return { ok: false, message: "Use the ASCII (punycode) form of an international domain name, such as xn--bcher-kva.example." };
        }
        return { ok: false, message: "That is not a domain. Type one such as example.com, with at least two parts and only letters, digits and hyphens." };
    }
    return { ok: false, message: "That is not an email address. Type one such as name@example.com, or a domain such as example.com." };
}

/** The domain of `address` (after its last `@`), lowercased; `undefined` when it has none. */
export function senderDomainOf(address: string): string | undefined {
    const at = address.lastIndexOf("@");
    return at >= 0 && at < address.length - 1 ? address.slice(at + 1).trim().toLowerCase() : undefined;
}

/** Whether `entry` (`user@example.com` or `@example.com`) names `address` - compared case-insensitively; a domain entry names that exact domain, not its subdomains. */
export function senderEntryMatches(entry: string, address: string): boolean {
    const lower = address.trim().toLowerCase();
    return entry.startsWith("@") ? senderDomainOf(lower) === entry.slice(1).toLowerCase() : lower === entry.toLowerCase();
}

/** The entry of `list` that names `address` (the address itself, or its domain), if any - the one a "blocked" or "safe" badge would come from. */
export function senderListEntryFor(list: readonly string[] | null | undefined, address: string): string | undefined {
    return (list ?? []).find((entry) => senderEntryMatches(entry, address));
}

function listPath(mailboxUid: string, list: SenderListKind): string {
    return `/mail/mailboxes/${encodeURIComponent(mailboxUid)}/${list === "blocked" ? "blocked-senders" : "safe-senders"}`;
}

function add(mailboxUid: string, list: SenderListKind, entry: string, client?: ApiClient): Promise<SenderListsChange> {
    return withClient(client, listPath(mailboxUid, list), { method: "POST", body: JSON.stringify({ entry }) });
}

function remove(mailboxUid: string, list: SenderListKind, entry: string, client?: ApiClient): Promise<SenderListsChange> {
    return withClient(client, `${listPath(mailboxUid, list)}/${encodeURIComponent(entry)}`, { method: "DELETE" });
}

/** `client`, given by every function below, is an explicit `ApiClient` from `createApiClient()` (e.g. one
 * account of a multi-account app) to call instead of the default global `apiFetch()` - see `withClient()`'s
 * own doc comment in `util/api.ts`. Omitted (the default), every function here behaves exactly as before. */

/**
 * Adds an address or domain to the mailbox's Blocked Senders (`POST .../blocked-senders`) and takes it off its Safe Senders. Mail from it goes to Junk Email
 * from then on. `entry` is normalized by the server, so `Example.com` is `@example.com`; use `checkSenderEntry()` first to tell the person what is wrong.
 * Adding an entry already there changes nothing (`changed: false`). Rejects with a 400 for an invalid entry or a full list, a 403 without full access to the
 * mailbox, and a 404 for a mailbox the caller cannot read - or a server without the lists.
 */
export function addBlockedSender(mailboxUid: string, entry: string, client?: ApiClient): Promise<SenderListsChange> {
    return add(mailboxUid, "blocked", entry, client);
}

/** Takes an address or domain off the mailbox's Blocked Senders (`DELETE .../blocked-senders/:entry`, the entry URL-encoded, `@` included). Removing an absent entry
 * succeeds with `changed: false`. */
export function removeBlockedSender(mailboxUid: string, entry: string, client?: ApiClient): Promise<SenderListsChange> {
    return remove(mailboxUid, "blocked", entry, client);
}

/** Adds an address or domain to the mailbox's Safe Senders (`POST .../safe-senders`) and takes it off its Blocked Senders. Authenticated mail from it (a passing DKIM signature
 * aligned with its From domain) is then not sent to Junk Email for the spam filter's verdict; mail that fails authentication, carries a virus or is quarantined
 * by policy still is. Errors as `addBlockedSender()`. */
export function addSafeSender(mailboxUid: string, entry: string, client?: ApiClient): Promise<SenderListsChange> {
    return add(mailboxUid, "safe", entry, client);
}

/** Takes an address or domain off the mailbox's Safe Senders (`DELETE .../safe-senders/:entry`). Removing an absent entry succeeds with `changed: false`. */
export function removeSafeSender(mailboxUid: string, entry: string, client?: ApiClient): Promise<SenderListsChange> {
    return remove(mailboxUid, "safe", entry, client);
}
