///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { pageTitle } from "../../../shared/navigation/pageTitle.js";
import React, { FormEvent, useId, useRef, useState } from "react";
import { blockedSendersOf, isSharedWithMe, safeSendersOf } from "@rapidmx/react-shared/mail/mailApi.js";
import {
    MAX_SENDER_LIST_ENTRIES,
    SenderListKind,
    SenderListsChange,
    addBlockedSender,
    addSafeSender,
    checkSenderEntry,
    removeBlockedSender,
    removeSafeSender,
} from "@rapidmx/react-shared/mail/senderListsApi.js";
import SettingsShell, { SettingsShellProps, useSettingsShell } from "../../../shared/components/settings/layout/SettingsShell.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import { useMailboxUpdateAccess } from "../../../shared/mail/useMailboxUpdateAccess.js";
import { notifyApiError } from "../../../shared/notifications/apiErrors.js";

export type SettingsBlockedSendersPageProps = Omit<SettingsShellProps, "active">;

function SettingsBlockedSendersPage(props: SettingsBlockedSendersPageProps) {
    return (
        <SettingsShell {...props} active="blocked-senders">
            <BlockedSendersContent />
        </SettingsShell>
    );
}

/** What each list is called and does, in the words the page uses for it. */
const COPY: Record<SenderListKind, { title: string; add: string; addLabel: string; verb: string; other: string; explain: string; empty: string }> = {
    blocked: {
        title: "Blocked senders",
        add: "Block",
        addLabel: "Add a blocked sender",
        verb: "Blocked",
        other: "safe senders",
        explain: "Mail from these addresses and domains goes to Junk Email, without the spam filter or your filters looking at it.",
        empty: "No blocked senders.",
    },
    safe: {
        title: "Safe senders",
        add: "Trust",
        addLabel: "Add a safe sender",
        verb: "Trusted",
        other: "blocked senders",
        explain:
            "Mail from these addresses and domains is not sent to Junk Email because of the spam filter's verdict, as long as it passes authentication: " +
            "a valid signature from the sender's own domain. Mail that fails it, carries a virus or is quarantined by policy is still kept out.",
        empty: "No safe senders.",
    },
};

const CAP = MAX_SENDER_LIST_ENTRIES.toLocaleString("en-US");

interface ListSectionProps {
    kind: SenderListKind;
    entries: string[];
    /** The other list, to say when an entry moves here from it. */
    otherEntries: string[];
    /** The reader's own addresses: they are not blocked. */
    ownAddresses: string[];
    editable: boolean;
    onAdd: (entry: string) => Promise<SenderListsChange | undefined>;
    onRemove: (entry: string) => Promise<SenderListsChange | undefined>;
}

/** One list: its count, the form that adds an address or domain to it, and its entries with a Remove button each. */
function ListSection({ kind, entries, otherEntries, ownAddresses, editable, onAdd, onRemove }: ListSectionProps) {
    const copy = COPY[kind];
    const id = useId();
    const headingRef = useRef<HTMLHeadingElement>(null);
    const [value, setValue] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const full = entries.length >= MAX_SENDER_LIST_ENTRIES;
    const sorted = [...entries].sort();

    async function handleAdd(e: FormEvent) {
        e.preventDefault();
        setStatus(null);
        const checked = checkSenderEntry(value);
        if (!checked.ok) {
            setError(checked.message);
            return;
        }
        if (kind === "blocked" && ownAddresses.includes(checked.entry)) {
            setError("That is one of your own addresses, so it cannot be blocked.");
            return;
        }
        setError(null);
        setBusy(true);
        try {
            const moved = otherEntries.includes(checked.entry);
            const result = await onAdd(checked.entry);
            if (result) {
                setValue("");
                setStatus(
                    !result.changed
                        ? `${checked.entry} is already on this list.`
                        : `${copy.verb} ${checked.entry}.${moved ? ` It was on your ${copy.other} and was moved here.` : ""}`,
                );
            }
        } finally {
            setBusy(false);
        }
    }

    async function handleRemove(entry: string) {
        setStatus(null);
        setBusy(true);
        try {
            if (await onRemove(entry)) {
                setStatus(`Removed ${entry}.`);
                // The button that was pressed is gone with its entry: focus goes to the list's heading rather than back to the page's start.
                headingRef.current?.focus();
            }
        } finally {
            setBusy(false);
        }
    }

    return (
        <section aria-labelledby={`${id}-title`} className="min-w-0 rounded-md border border-border bg-surface p-4">
            <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1} className="text-base font-bold tracking-tight outline-none">
                {copy.title}
            </h2>
            <p className="text-xs text-text-muted mt-0.5 mb-2">
                {entries.length.toLocaleString("en-US")} of {CAP}
            </p>
            <p className="text-sm text-text-muted mb-3">{copy.explain}</p>

            {editable && (
                <form onSubmit={handleAdd} noValidate className="mb-3">
                    <label htmlFor={`${id}-entry`} className="block text-sm font-semibold mb-1.5 text-text">
                        {copy.addLabel}
                    </label>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <input
                            id={`${id}-entry`}
                            type="text"
                            inputMode="email"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            value={value}
                            disabled={full || busy}
                            placeholder="name@example.com or example.com"
                            aria-invalid={error ? true : undefined}
                            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
                            onChange={(e) => {
                                setValue(e.target.value);
                                setError(null);
                            }}
                            className="flex-1 min-w-0 text-sm px-3 py-1.5 rounded-md border border-border bg-surface disabled:opacity-55"
                        />
                        <Button type="submit" className="!w-auto shrink-0" disabled={full || busy} loading={busy}>
                            {copy.add}
                        </Button>
                    </div>
                    <p id={`${id}-hint`} className="text-xs text-text-muted mt-1">
                        A domain such as example.com covers every address at it, but not its subdomains. An address already on your {copy.other} moves here.
                    </p>
                    {error && (
                        <p id={`${id}-error`} role="alert" className="text-sm text-danger mt-1">
                            {error}
                        </p>
                    )}
                    {full && (
                        <p className="text-sm text-danger mt-1">
                            This list is full: it holds {CAP} senders. Remove one to add another.
                        </p>
                    )}
                </form>
            )}

            <p role="status" className="text-sm text-success font-medium mb-2 empty:hidden">
                {status}
            </p>

            {sorted.length === 0 ? (
                <p className="text-sm text-text-muted">{copy.empty}</p>
            ) : (
                <ul aria-label={copy.title} className="divide-y divide-border border-y border-border">
                    {sorted.map((entry) => (
                        <li key={entry} className="flex items-center justify-between gap-3 py-2">
                            <span className="min-w-0 break-all text-sm">
                                {entry}
                                {entry.startsWith("@") && <span className="block text-xs text-text-muted">Everyone at {entry.slice(1)}</span>}
                            </span>
                            {editable && (
                                <button
                                    type="button"
                                    disabled={busy}
                                    aria-label={`Remove ${entry} from ${copy.title.toLowerCase()}`}
                                    onClick={() => void handleRemove(entry)}
                                    className="shrink-0 text-sm font-medium text-primary-dark hover:underline disabled:opacity-55"
                                >
                                    Remove
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function BlockedSendersContent() {
    const { mailboxUid } = useSettingsShell();
    // A mailbox chosen in the shell's switcher is a different set of lists: the content starts over for it.
    return <ListsContent key={mailboxUid} />;
}

function ListsContent() {
    const { mailboxUid, mailboxes } = useSettingsShell();
    // `SettingsShell` only ever renders its children once `mailboxes` has loaded and `mailboxUid` has resolved to one of them - same established
    // non-null pattern as `apps/www/settings/read-receipts/index.tsx`.
    const mailbox = mailboxes.find((mb) => mb.uid === mailboxUid)!;
    const writable = useMailboxUpdateAccess(mailbox);
    // The lists are the owner's (and a manager's) to change; the server does not say which of the two a delegate is, so one who may update is offered the
    // forms and told what a refusal means.
    const delegated = isSharedWithMe(mailbox);
    // A server before the lists sends neither.
    const supported = mailbox.blockedSenders !== undefined || mailbox.safeSenders !== undefined;
    const [blocked, setBlocked] = useState(blockedSendersOf(mailbox));
    const [safe, setSafe] = useState(safeSendersOf(mailbox));
    const ownAddresses = mailboxes.flatMap((mb) => [mb.primarySmtpAddress, ...(mb.aliasAddresses ?? [])]).filter((a) => !!a).map((a) => a.toLowerCase());

    async function change(action: () => Promise<SenderListsChange>, context: string): Promise<SenderListsChange | undefined> {
        try {
            const result = await action();
            // The answer carries both lists as they now are: adding to one takes the entry off the other.
            setBlocked(result.blockedSenders);
            setSafe(result.safeSenders);
            return result;
        } catch (err) {
            notifyApiError(err, context);
            return undefined;
        }
    }

    return (
        <div className="flex-1 min-w-0 overflow-y-auto p-4 sm:p-6">
            <div className="max-w-4xl">
                <h1 className="text-lg font-bold tracking-tight mb-1">Blocked and safe senders</h1>
                <p className="text-sm text-text-muted mb-4">
                    These lists belong to <span className="font-medium text-text">{mailbox.displayName}</span> ({mailbox.primarySmtpAddress}). Each entry is an email address or a domain. An
                    entry is on one list at a time: adding it to one takes it off the other.
                </p>

                {!supported ? (
                    <p role="status" className="text-sm text-text-muted">
                        This server does not support blocked and safe senders yet.
                    </p>
                ) : (
                    <>
                        {!writable && (
                            <p role="status" className="text-sm rounded-md border border-border bg-surface-alt px-3 py-2 mb-4">
                                You have view-only access to this mailbox, so you can see these lists but not change them.
                            </p>
                        )}
                        {writable && delegated && (
                            <p className="text-sm text-text-muted mb-4">
                                Only this mailbox&rsquo;s owner, or someone with full access to it, can change these lists. If you cannot, the server says so when you try.
                            </p>
                        )}
                        <div className="grid gap-4 md:grid-cols-2">
                            <ListSection
                                kind="blocked"
                                entries={blocked}
                                otherEntries={safe}
                                ownAddresses={ownAddresses}
                                editable={writable}
                                onAdd={(entry) => change(() => addBlockedSender(mailbox.uid, entry), "Couldn't block this sender")}
                                onRemove={(entry) => change(() => removeBlockedSender(mailbox.uid, entry), "Couldn't unblock this sender")}
                            />
                            <ListSection
                                kind="safe"
                                entries={safe}
                                otherEntries={blocked}
                                ownAddresses={ownAddresses}
                                editable={writable}
                                onAdd={(entry) => change(() => addSafeSender(mailbox.uid, entry), "Couldn't add this safe sender")}
                                onRemove={(entry) => change(() => removeSafeSender(mailbox.uid, entry), "Couldn't remove this safe sender")}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

export default SettingsBlockedSendersPage;

/** The tab's title: `Brand: Settings` (see `pageTitle()`). */
export const title = pageTitle("Settings");
