///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type Contact, type ContactAddressKind, contactPhotoUrl, setContactFavorite } from "../../../../lib/contacts/contactsApi.js";
import { clearPinnedSignerCache } from "../mail/pinnedSigners.js";
import ContactAvatar from "../../../../lib/components/avatar/ContactAvatar.js";
import Button from "../../../../lib/components/buttons/Button.js";
import CopyIconButton from "../../../../lib/components/buttons/CopyIconButton.js";
import { HiOutlineEnvelope, HiOutlineUserPlus } from "react-icons/hi2";
import FavoriteStarButton from "./FavoriteStarButton.js";
import Skeleton from "../../../../lib/components/feedback/Skeleton.js";
import Modal from "../../../../lib/components/overlays/Modal.js";
import { formatMailAddress } from "../../../../lib/mail/mailAddress.js";
import type { ParsedVCardContact } from "../../../../lib/contacts/vcard.js";
import { type Folder, type Mailbox, listMailboxes } from "../../../../lib/mail/mailApi.js";
import { useApiClient } from "../../../../lib/util/apiClientContext.js";
import { MAILBOX_LIST_LIMIT, MailConnectionContext } from "../../mail/useMailConnection.js";
import { notify } from "../../notifications/store.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import { APP_HREFS } from "../../navigation/appHrefs.js";
import { useCompose } from "../mail/compose/ComposeContext.js";
import { formatInviteWhen } from "../mail/invite/inviteFormat.js";
import {
    type ContactCardContext,
    contactScope,
    createContactFor,
    findContact,
    loadFolders,
    loadParticipantCard,
    loadRecentMessages,
    loadUpcomingEvents,
    scopeMailboxes,
} from "./contactCardData.js";
import { type Participant, contactInputFor, isExternalAddress, ownDomains, participantName } from "./participantDetails.js";

type Section<T> = { status: "loading" } | { status: "error" } | { status: "ready"; data: T };

/** What creating the contact is made from. */
interface CreateWith {
    folders: Folder[];
    mailboxes: Mailbox[];
    card: ParsedVCardContact | undefined;
}

/**
 * One piece of the card's data. `load` is `undefined` while what it needs is still coming (it stays loading), and runs once when it is there; a
 * failure is this section's error and nothing else's. `upstream` is the section this one needs: its error is this one's too.
 */
function useSection<T>(load: (() => Promise<T>) | undefined, upstream?: Section<unknown>): Section<T> {
    const [state, setState] = useState<Section<T>>({ status: "loading" });
    const ready = !!load;
    useEffect(() => {
        if (!load) {
            return;
        }
        let cancelled = false;
        load().then(
            (data) => !cancelled && setState({ status: "ready", data }),
            () => !cancelled && setState({ status: "error" }),
        );
        return () => {
            cancelled = true;
        };
    }, [ready]);
    return upstream?.status === "error" ? { status: "error" } : state;
}

const KIND_LABEL: Record<ContactAddressKind, string> = { work: "Work", home: "Home", other: "" };

function kindLabel(kind: ContactAddressKind): string {
    return KIND_LABEL[kind];
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex gap-3 text-sm">
            <dt className="w-24 shrink-0 text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words whitespace-pre-line">{children}</dd>
        </div>
    );
}

/** A card section: its heading, and while loading a skeleton, on failure the reason, when empty the empty text, else what `render` draws. */
function CardSection<T>({
    title,
    section,
    empty,
    failure,
    isEmpty,
    render,
}: {
    title: string;
    section: Section<T>;
    empty: string;
    failure: string;
    isEmpty: (data: T) => boolean;
    render: (data: T) => ReactNode;
}) {
    return (
        <section className="mt-5">
            <h3 className="text-sm font-bold mb-2">{title}</h3>
            {section.status === "loading" ? (
                <div role="status" aria-label={`Loading ${title.toLowerCase()}`} className="flex flex-col gap-2">
                    <Skeleton width="w-3/4" />
                    <Skeleton width="w-1/2" />
                </div>
            ) : section.status === "error" ? (
                <p role="alert" className="text-sm text-danger">
                    {failure}
                </p>
            ) : isEmpty(section.data) ? (
                <p className="text-sm text-text-muted">{empty}</p>
            ) : (
                render(section.data)
            )}
        </section>
    );
}

const ACTION_CLASS = "!w-auto !py-1 !px-3 text-xs";
const ROW_LINK_CLASS = "block rounded-sm px-2 py-1.5 -mx-2 hover:bg-surface-alt focus-visible:outline-2 focus-visible:outline-primary";

export interface ContactCardProps {
    participant: Participant;
    context?: ContactCardContext;
    onClose: () => void;
    userUid?: string;
}

/**
 * A person's contact card, as Outlook's people card: a big avatar, their name, an "External" badge when the address is outside the user's own
 * domains, the actions (email them, copy the address, create the contact or open it), then their contact details, the last messages to or from
 * them and the events coming up that they organize or were invited to. Each section loads on its own, with a skeleton, an empty text and an
 * error that touches nothing else on the card.
 *
 * When the address is not in the user's address book the details are what is known: the name and address, and everything a vCard attached to the
 * message they were met in says. "Create contact" stores that. The lookups are made once, when the card opens.
 */
export default function ContactCard({ participant, context = {}, onClose, userUid }: ContactCardProps) {
    const client = useApiClient();
    const { openCompose } = useCompose();
    const connection = useContext(MailConnectionContext);
    const [listed, setListed] = useState<Section<Mailbox[]>>({ status: "loading" });
    const [created, setCreated] = useState<Contact | undefined>();
    const [creating, setCreating] = useState(false);
    // The contact as last changed from this card (starred or unstarred), which is newer than the one looked up.
    const [changed, setChanged] = useState<Contact | undefined>();
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => void (mounted.current = false);
    }, []);

    // The mailboxes come from the app frame's connection when there is one; otherwise (a page rendered outside it) they are asked for.
    useEffect(() => {
        if (connection) {
            return;
        }
        listMailboxes({ limit: MAILBOX_LIST_LIMIT }, client).then(
            (data) => mounted.current && setListed({ status: "ready", data }),
            () => mounted.current && setListed({ status: "error" }),
        );
    }, []);
    const mailboxes: Section<Mailbox[]> = connection
        ? connection.status === "ready"
            ? { status: "ready", data: connection.mailboxes }
            : connection.status === "error"
              ? { status: "error" }
              : { status: "loading" }
        : listed;

    const scope = mailboxes.status === "ready" ? scopeMailboxes(mailboxes.data, userUid, context.message) : undefined;
    const now = useRef(new Date());
    const folders = useSection(scope && (() => loadFolders(scope, client)), mailboxes);
    const contact = useSection(
        folders.status === "ready" ? () => findContact(folders.data, participant.address, client) : undefined,
        folders,
    );
    const messages = useSection(scope && (() => loadRecentMessages(scope, participant.address, client)), mailboxes);
    const events = useSection(
        folders.status === "ready" ? () => loadUpcomingEvents(folders.data, participant.address, now.current, client) : undefined,
        folders,
    );
    const card = useSection(() => loadParticipantCard(participant, context, client));

    const name = participantName(participant);
    const stored = changed ?? created ?? (contact.status === "ready" ? contact.data : undefined);
    const external = mailboxes.status === "ready" && isExternalAddress(participant.address, ownDomains(mailboxes.data));
    // What is known when there is no contact: the name, the address and the message's vCard.
    const known = stored ?? contactInputFor(participant, card.status === "ready" ? card.data : undefined, { mailboxUid: "", folderUid: "" });
    // What "Create contact" needs, once it is all there.
    const createWith =
        folders.status === "ready" && mailboxes.status === "ready" && card.status === "ready"
            ? { folders: folders.data, mailboxes: mailboxes.data, card: card.data }
            : undefined;

    async function handleCreate({ folders: folderList, mailboxes: mailboxList, card: parsed }: CreateWith) {
        setCreating(true);
        try {
            const target = contactScope(mailboxList, folderList, userUid, context.message);
            const made = await createContactFor(participant, parsed, target, client);
            clearPinnedSignerCache();
            notify({ kind: "success", title: "Contact created", message: `${made.displayName} was added to your contacts.` });
            if (mounted.current) {
                setCreated(made);
            }
        } catch (err) {
            notifyApiError(err, "Couldn't create this contact");
        } finally {
            if (mounted.current) {
                setCreating(false);
            }
        }
    }

    async function handleToggleFavorite(current: Contact) {
        try {
            const next = await setContactFavorite(current, !current.favorite, client);
            if (mounted.current) {
                setChanged(next);
            }
        } catch (err) {
            notifyApiError(err, "Couldn't update this contact");
        }
    }

    function handleEmail() {
        openCompose({ to: formatMailAddress(participant) });
        onClose();
    }

    return (
        <Modal open onClose={onClose} title={name}>
            <div className="flex items-center gap-4">
                <ContactAvatar displayName={name} size={72} photoUrl={stored && contactPhotoUrl(stored)} email={participant.address} />
                <div className="min-w-0 flex-1">
                    <p className="text-sm text-text-muted break-words">
                        {participant.address}
                        <CopyIconButton value={participant.address} label="Copy address" className="ml-1" />
                    </p>
                    {external && (
                        <span className="inline-block mt-1 text-xs font-semibold py-0.5 px-2 rounded-pill bg-warning/15 text-text">External</span>
                    )}
                    {(known.jobTitle || known.company) && (
                        <p className="mt-1 text-sm break-words">{[known.jobTitle, known.company].filter(Boolean).join(", ")}</p>
                    )}
                </div>
                {stored && <FavoriteStarButton favorite={!!stored.favorite} onToggle={() => void handleToggleFavorite(stored)} className="shrink-0 self-start" />}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button type="button" variant="secondary" className={`${ACTION_CLASS} inline-flex items-center gap-1.5`} onClick={handleEmail}>
                    <HiOutlineEnvelope aria-hidden="true" className="size-4" />
                    Email
                </Button>
                {stored ? (
                    <a
                        href={`${APP_HREFS.contacts}/${encodeURIComponent(stored.uid)}`}
                        onClick={onClose}
                        className="inline-flex items-center text-xs font-semibold py-1 px-3 rounded-sm border border-border hover:border-accent hover:text-accent-dark focus-visible:outline-2 focus-visible:outline-primary"
                    >
                        Open contact
                    </a>
                ) : (
                    <Button
                        type="button"
                        variant="secondary"
                        className={`${ACTION_CLASS} inline-flex items-center gap-1.5`}
                        disabled={!createWith || creating}
                        loading={creating}
                        onClick={() => void handleCreate(createWith as CreateWith)}
                    >
                        <HiOutlineUserPlus aria-hidden="true" className="size-4" />
                        Add to contacts
                    </Button>
                )}
            </div>

            <section className="mt-5">
                <h3 className="text-sm font-bold mb-2">Contact</h3>
                {!stored && contact.status === "loading" && <Skeleton width="w-1/2" className="mb-2" />}
                {!stored && contact.status === "error" && (
                    <p role="alert" className="text-sm text-danger mb-2">
                        Couldn&rsquo;t check your address book.
                    </p>
                )}
                {!stored && contact.status === "ready" && <p className="text-sm text-text-muted mb-2">Not in your address book.</p>}
                <dl className="flex flex-col gap-1.5">
                    {known.emails.map((email) => (
                        <Detail key={`e:${email.address}`} label={["Email", kindLabel(email.type)].filter(Boolean).join(" ")}>
                            {email.address}
                            <CopyIconButton value={email.address} label="Copy email address" className="ml-1" />
                        </Detail>
                    ))}
                    {known.phones.map((phone) => (
                        <Detail key={`p:${phone.phoneNumber}`} label={["Phone", kindLabel(phone.type)].filter(Boolean).join(" ")}>
                            {phone.phoneNumber}
                        </Detail>
                    ))}
                    {known.company && <Detail label="Company">{known.company}</Detail>}
                    {known.jobTitle && <Detail label="Job title">{known.jobTitle}</Detail>}
                    {known.addresses.map((address, index) => (
                        <Detail key={`a:${index}`} label={["Address", kindLabel(address.type)].filter(Boolean).join(" ")}>
                            {[address.street, [address.postalCode, address.city].filter(Boolean).join(" "), address.state, address.country].filter(Boolean).join("\n")}
                        </Detail>
                    ))}
                    {known.notes && <Detail label="Notes">{known.notes}</Detail>}
                </dl>
            </section>
            <CardSection
                title="Recent messages"
                section={messages}
                empty="No recent messages"
                failure="Couldn't load recent messages."
                isEmpty={(list) => list.length === 0}
                render={(list) => (
                    <ul className="flex flex-col">
                        {list.map((message) => (
                            <li key={message.uid}>
                                <a href={`/messages/${encodeURIComponent(message.uid)}`} onClick={onClose} className={ROW_LINK_CLASS}>
                                    <span className="flex items-baseline justify-between gap-3 text-sm">
                                        <span className="font-medium truncate">{message.subject || "(No subject)"}</span>
                                        <time dateTime={message.receivedDate} className="text-xs text-text-muted shrink-0">
                                            {new Date(message.receivedDate).toLocaleDateString()}
                                        </time>
                                    </span>
                                    <span className="block text-xs text-text-muted truncate">{message.bodyPreview}</span>
                                </a>
                            </li>
                        ))}
                    </ul>
                )}
            />
            <CardSection
                title="Upcoming events"
                section={events}
                empty="No upcoming events"
                failure="Couldn't load upcoming events."
                isEmpty={(list) => list.length === 0}
                render={(list) => (
                    <ul className="flex flex-col">
                        {list.map((event) => (
                            <li key={event.occurrenceKey}>
                                <a href={APP_HREFS.calendar} onClick={onClose} className={ROW_LINK_CLASS}>
                                    <span className="block text-sm font-medium truncate">{event.title}</span>
                                    <span className="block text-xs text-text-muted">{formatInviteWhen(event)}</span>
                                </a>
                            </li>
                        ))}
                    </ul>
                )}
            />
        </Modal>
    );
}
