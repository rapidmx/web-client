///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useId, useState } from "react";
import { HiOutlineCalendarDays, HiOutlineCheck } from "react-icons/hi2";
import {
    InviteParticipant,
    InviteResponse,
    MessageInvite,
    ProposedTime,
    acceptProposal,
    proposeNewTime,
    removeMessageInvite,
    respondToMessageInvite,
} from "@rapidmx/react-shared/calendar/inviteApi.js";
import { guestPermissionsOf } from "@rapidmx/react-shared/calendar/calendarApi.js";
import { formatMailAddress } from "@rapidmx/react-shared/mail/mailAddress.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import EventDescriptionView from "../calendar/EventDescriptionView.js";
import RequestChangeForm from "../calendar/RequestChangeForm.js";
import { VISIBILITY_LABEL, describeGuestPermissions } from "../calendar/eventFormat.js";
import { notifyApiError } from "../../notifications/apiErrors.js";
import { calendarHref, conflictSummary, formatInviteWhen } from "./invite/inviteFormat.js";
import { useMessageInvite } from "./invite/inviteStore.js";
import ProposeTimeForm from "./invite/ProposeTimeForm.js";

export { formatInviteWhen, isCalendarAttachment } from "./invite/inviteFormat.js";

const HEADINGS: Record<string, string> = {
    REQUEST: "Meeting invitation",
    CANCEL: "Meeting canceled",
    REPLY: "Meeting response",
    COUNTER: "New time proposed",
};

/** The heading of a `COUNTER` that is a guest's request for a change (rather than a different time). */
const CHANGE_REQUEST_HEADING = "Change requested";

/** How an answer reads in "Bob accepted." (a REPLY) - a participant who has not answered has not answered. */
const REPLY_VERBS: Partial<Record<NonNullable<InviteParticipant["responseStatus"]>, string>> = {
    accepted: "accepted",
    tentative: "tentatively accepted",
    declined: "declined",
};

/** The reader's own answer, as the line under the invitation says it. */
const ANSWER_TEXT: Record<InviteResponse, string> = {
    accepted: "You accepted this meeting.",
    tentative: "You tentatively accepted this meeting.",
    declined: "You declined this meeting. It is not on your calendar.",
};

const ANSWER_CLASS: Record<InviteResponse, string> = {
    accepted: "text-success",
    tentative: "text-text",
    declined: "text-danger",
};

const RESPONSES: { response: InviteResponse; label: string; failure: string }[] = [
    { response: "accepted", label: "Accept", failure: "Couldn't accept this meeting" },
    { response: "tentative", label: "Tentative", failure: "Couldn't respond tentatively to this meeting" },
    { response: "declined", label: "Decline", failure: "Couldn't decline this meeting" },
];

/** The most attendees that are listed by name; a longer list is only counted. */
const MAX_NAMED_ATTENDEES = 5;

/** What the card is doing for the reader right now: an answer being sent, an add/remove, a proposal, an accepted proposal. */
type Pending = InviteResponse | "add" | "remove" | "propose" | "acceptProposal";

function attendeeSummary(attendees: InviteParticipant[]): string | undefined {
    if (attendees.length === 0) {
        return undefined;
    }
    const count = `${attendees.length} ${attendees.length === 1 ? "attendee" : "attendees"}`;
    return attendees.length <= MAX_NAMED_ATTENDEES ? `${count}: ${attendees.map((a) => a.displayName || a.address).join(", ")}` : count;
}

export interface InviteCardProps {
    /** The message whose calendar invitation to show, if it carries one. Nothing is drawn until the server says there is one. */
    messageUid: string;
    /** The level of the card's heading, so it sits below whatever heading its surroundings have (`2` in the reading pane, `3` inside a thread's card). */
    headingLevel?: 2 | 3;
}

/**
 * The calendar invitation a message carries, as Outlook and Gmail draw it: what the meeting is, when and where, who organizes it, and the buttons
 * that answer it - Accept, Tentative, Decline (and Propose new time) for a request; "Add to calendar" for a published event; "Remove from
 * calendar" for a cancellation; "Accept proposal" for an attendee's proposed new time. An attendee's answer to the reader's own invitation is
 * one line ("Bob tentatively accepted."). Everything that follows an action (the meeting going onto the calendar or off it, the reply to the
 * organizer) is the server's; this only asks for it and draws the invitation the server sends back.
 *
 * Asks the server once per message (through the shared invitation cache, so the list row's RSVP chip and this card agree). A message with no readable
 * invitation, and a lookup that fails for any reason, draw nothing - a lookup that fails is never retried and never disturbs the message around it.
 * An answer that arrives after the message changed or this was unmounted is dropped.
 */
export default function InviteCard({ messageUid, headingLevel = 2 }: InviteCardProps) {
    const { invite, setInvite } = useMessageInvite(messageUid);
    const [pending, setPending] = useState<Pending | null>(null);
    const [proposing, setProposing] = useState(false);
    // Said once after a proposal went out: the invitation itself doesn't change.
    const [proposed, setProposed] = useState(false);
    // A guest's request for a change (or for guests to be added): the form is open, and once it went out.
    const [requesting, setRequesting] = useState(false);
    const [requested, setRequested] = useState(false);
    const headingId = useId();

    if (!invite) {
        return null;
    }

    /** Runs one of the card's actions: the buttons are off while it does, its result replaces what the card shows, and a failure leaves the card as it was. */
    async function run(action: Pending, failure: string, call: () => Promise<MessageInvite>): Promise<boolean> {
        setPending(action);
        try {
            setInvite(await call());
            return true;
        } catch (err) {
            notifyApiError(err, failure);
            return false;
        } finally {
            setPending(null);
        }
    }

    async function sendProposal(proposal: ProposedTime) {
        if (await run("propose", "Couldn't send the proposed time", () => proposeNewTime(messageUid, proposal))) {
            setProposing(false);
            setProposed(true);
        }
    }

    const busy = pending !== null;
    const Heading = `h${headingLevel}` as const;
    const method = invite.method.toUpperCase();
    const isReply = method === "REPLY";
    const isCounter = method === "COUNTER";
    // A `COUNTER` a guest sent to change the event (not just its time): whether the organizer's server applied it already.
    const changeRequest = isCounter ? invite.changeRequest : undefined;
    const permissions = guestPermissionsOf(invite.guestPermissions ?? {});
    const hiddenList = !invite.isOrganizer && !permissions.guestsCanSeeGuestList;
    const canRequest = !!invite.calendarEventUid && (!!invite.canRequestChange || !!invite.canRequestInvite);
    const title = invite.summary?.trim() || "(no title)";
    const when = formatInviteWhen(invite);
    const attendees = hiddenList ? "The organizer has hidden the guest list" : attendeeSummary(invite.attendees);
    const hasDescription = !!(invite.descriptionHtml?.trim() || invite.description?.trim());
    const visibility = invite.visibility && invite.visibility !== "default" ? VISIBILITY_LABEL[invite.visibility] : undefined;
    const sender = invite.reply ?? invite.attendees[0];
    const senderName = sender ? sender.displayName || sender.address : "Someone";
    const showResponses = invite.canRespond && !invite.isOrganizer;
    const conflicts = !isReply && !isCounter && method !== "CANCEL" && invite.conflicts.length > 0 ? conflictSummary(invite.conflicts) : undefined;
    const hasActions =
        showResponses ||
        invite.canPropose ||
        invite.canAcceptProposal ||
        invite.canAdd ||
        invite.canRemove ||
        canRequest ||
        (invite.onCalendar && !!invite.calendarEventUid);

    return (
        <section aria-labelledby={headingId} className="rounded-sm border border-border bg-surface-alt px-3 py-3 flex flex-col gap-2 text-sm text-text">
            <Heading id={headingId} className="flex items-center gap-2 text-sm font-semibold">
                <HiOutlineCalendarDays size={16} aria-hidden="true" className="shrink-0" />
                {changeRequest ? CHANGE_REQUEST_HEADING : (HEADINGS[method] ?? "Calendar event")}
            </Heading>
            {isReply && (
                // Someone answering the reader's own invitation: a line of news, nothing to do.
                <p className="break-words">
                    <span className="font-semibold">{senderName}</span> {(sender?.responseStatus && REPLY_VERBS[sender.responseStatus]) ?? "responded"}.
                </p>
            )}
            {isCounter && !changeRequest && (
                <p className="break-words">
                    <span className="font-semibold">{senderName}</span> proposed a new time{when ? <>: {when}</> : "."}
                </p>
            )}
            {changeRequest && (
                <p className="break-words">
                    {changeRequest.applied ? (
                        <>
                            <span className="font-semibold">{senderName}</span>&rsquo;s change was applied.
                        </>
                    ) : (
                        <>
                            <span className="font-semibold">{senderName}</span> requested a change.
                        </>
                    )}
                </p>
            )}
            <p className="font-medium break-words">{title}</p>
            {!isReply && (
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                    {when && (!isCounter || !!changeRequest) && (
                        <>
                            <dt className="text-text-muted">When</dt>
                            <dd className="break-words">
                                {when}
                                {invite.recurring && <span className="text-text-muted"> (Repeats)</span>}
                            </dd>
                        </>
                    )}
                    {invite.location && (
                        <>
                            <dt className="text-text-muted">Where</dt>
                            <dd className="break-words">{invite.location}</dd>
                        </>
                    )}
                    {hasDescription && (!isCounter || !!changeRequest) && (
                        <>
                            <dt className="text-text-muted">Description</dt>
                            <dd className="break-words">
                                <EventDescriptionView html={invite.descriptionHtml} text={invite.description} />
                            </dd>
                        </>
                    )}
                    {invite.organizer && !isCounter && (
                        <>
                            <dt className="text-text-muted">Organizer</dt>
                            <dd className="break-words">{formatMailAddress(invite.organizer)}</dd>
                        </>
                    )}
                    {attendees && (!isCounter || !!changeRequest) && (
                        <>
                            <dt className="text-text-muted">Attendees</dt>
                            <dd className="break-words">{attendees}</dd>
                        </>
                    )}
                    {visibility && !isCounter && (
                        <>
                            <dt className="text-text-muted">Visibility</dt>
                            <dd className="break-words">{visibility}</dd>
                        </>
                    )}
                </dl>
            )}
            {isReply && when && <p className="text-text-muted break-words">{when}</p>}
            {conflicts && (
                <p className="text-danger break-words">
                    <span className="font-medium">Conflicts with:</span> {conflicts}
                </p>
            )}
            {invite.guestPermissions && !isReply && !isCounter && method !== "CANCEL" && (
                <p className="text-xs text-text-muted break-words">{describeGuestPermissions(permissions)}</p>
            )}
            {invite.isOrganizer && !isReply && !isCounter && <p className="text-text-muted">You are the organizer of this meeting.</p>}
            {method === "CANCEL" && <p className="font-medium text-danger">This meeting was canceled.</p>}
            {invite.response && !invite.isOrganizer && !isReply && !isCounter && (
                <p role="status" className={`font-medium ${ANSWER_CLASS[invite.response]}`}>
                    {ANSWER_TEXT[invite.response]}
                </p>
            )}
            {isCounter && invite.response === "accepted" && !changeRequest?.applied && (
                <p role="status" className="font-medium text-success">
                    You accepted the proposed time.
                </p>
            )}
            {proposed && (
                <p role="status" className="font-medium text-text">
                    Your proposed time was sent to the organizer.
                </p>
            )}
            {requested && (
                <p role="status" className="font-medium text-text">
                    Your change was sent to the organizer.
                </p>
            )}
            {invite.outdated && <p className="text-xs text-text-muted">A newer version of this meeting is already on your calendar.</p>}
            {hasActions && (
                <div className="flex flex-wrap items-center gap-2">
                    {showResponses && (
                        <div role="group" aria-label="Respond to this meeting" aria-busy={busy || undefined} className="flex flex-wrap gap-2">
                            {RESPONSES.map(({ response, label, failure }) => {
                                const current = invite.response === response;
                                return (
                                    <Button
                                        key={response}
                                        type="button"
                                        variant="secondary"
                                        className={["!w-auto", current ? "!bg-primary/10 !border-primary disabled:!opacity-100" : ""].join(" ")}
                                        aria-pressed={current}
                                        aria-busy={pending === response || undefined}
                                        loading={pending === response}
                                        disabled={busy || current}
                                        onClick={() => void run(response, failure, () => respondToMessageInvite(messageUid, response))}
                                    >
                                        {current && <HiOutlineCheck size={14} aria-hidden="true" />}
                                        {label}
                                    </Button>
                                );
                            })}
                        </div>
                    )}
                    {invite.canPropose && !proposing && (
                        <Button type="button" variant="text" disabled={busy} onClick={() => setProposing(true)}>
                            Propose new time
                        </Button>
                    )}
                    {canRequest && !requesting && (
                        <Button type="button" variant="secondary" className="!w-auto" disabled={busy} onClick={() => setRequesting(true)}>
                            {invite.canRequestChange ? "Request a change" : "Add guests"}
                        </Button>
                    )}
                    {invite.canAcceptProposal && invite.response !== "accepted" && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            aria-busy={pending === "acceptProposal" || undefined}
                            loading={pending === "acceptProposal"}
                            disabled={busy}
                            onClick={() => void run("acceptProposal", "Couldn't accept the proposed time", () => acceptProposal(messageUid))}
                        >
                            Accept proposal
                        </Button>
                    )}
                    {invite.canAdd && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            aria-busy={pending === "add" || undefined}
                            loading={pending === "add"}
                            disabled={busy}
                            // A published event has no organizer to answer, so adding it is accepting it: the server sends no reply.
                            onClick={() => void run("add", "Couldn't add this event to your calendar", () => respondToMessageInvite(messageUid, "accepted"))}
                        >
                            Add to calendar
                        </Button>
                    )}
                    {invite.canRemove && (
                        <Button
                            type="button"
                            variant="secondary"
                            className="!w-auto"
                            aria-busy={pending === "remove" || undefined}
                            loading={pending === "remove"}
                            disabled={busy}
                            onClick={() => void run("remove", "Couldn't remove this meeting from your calendar", () => removeMessageInvite(messageUid))}
                        >
                            Remove from calendar
                        </Button>
                    )}
                    {invite.onCalendar && invite.calendarEventUid && (
                        <a href={calendarHref(invite)} className="text-sm font-medium text-primary-dark hover:underline">
                            Open in Calendar
                        </a>
                    )}
                </div>
            )}
            {requesting && (
                <div className="rounded-md bg-surface p-3">
                    <RequestChangeForm
                        subject={{
                            uid: invite.calendarEventUid as string,
                            title: invite.summary ?? "",
                            location: invite.location,
                            startDate: invite.startDate,
                            endDate: invite.endDate,
                            allDay: invite.allDay,
                            recurring: invite.recurring,
                            description: invite.description,
                            descriptionHtml: invite.descriptionHtml,
                            guestAddresses: invite.attendees.map((attendee) => attendee.address),
                        }}
                        canChange={!!invite.canRequestChange}
                        canInvite={!!invite.canRequestInvite}
                        onSent={() => {
                            setRequesting(false);
                            setRequested(true);
                        }}
                        onCancel={() => setRequesting(false)}
                    />
                </div>
            )}
            {proposing && (
                <ProposeTimeForm
                    invite={invite}
                    busy={pending === "propose"}
                    onSubmit={(proposal) => void sendProposal(proposal)}
                    onCancel={() => setProposing(false)}
                />
            )}
        </section>
    );
}
