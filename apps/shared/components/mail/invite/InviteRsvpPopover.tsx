///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { RefObject, useEffect, useId, useRef, useState } from "react";
import { HiOutlineCheck, HiOutlineEllipsisHorizontal } from "react-icons/hi2";
import { InviteResponse, MessageInvite, ProposedTime, proposeNewTime, respondToMessageInvite } from "@rapidmx/react-shared/calendar/inviteApi.js";
import Button from "@rapidmx/react-shared/components/buttons/Button.js";
import Modal from "@rapidmx/react-shared/components/overlays/Modal.js";
import PopoverPortal from "@rapidmx/react-shared/components/overlays/PopoverPortal.js";
import useIsMobile from "@rapidmx/react-shared/util/useIsMobile.js";
import { notifyApiError } from "../../../notifications/apiErrors.js";
import { calendarHref, conflictSummary, formatInviteWhen } from "./inviteFormat.js";
import InviteTimeline from "./InviteTimeline.js";
import ProposeTimeForm from "./ProposeTimeForm.js";

/** The popover's width, and the room it leaves the window's edges. */
const WIDTH = 360;
const WINDOW_MARGIN = 16;
/** What the popover is tall for its own text and footer, before the day view (px), and how tall the day view is per hour drawn. */
const CHROME_HEIGHT = 190;
const CONFLICT_LINE_HEIGHT = 22;
const HOURS_HEIGHT = 36;
const PROPOSE_HEIGHT = 340;

/** The hours the day view draws for an invitation, as `InviteTimeline` will (a fixed estimate is all a popover's box needs). */
function estimateHeight(invite: MessageInvite, proposing: boolean): number {
    const cap = window.innerHeight - WINDOW_MARGIN;
    if (proposing) {
        return Math.min(PROPOSE_HEIGHT, cap);
    }
    const start = invite.startDate ? new Date(invite.startDate) : undefined;
    const end = invite.endDate ? new Date(invite.endDate) : undefined;
    const spanHours = start && end ? Math.max(0, (end.getTime() - start.getTime()) / 3_600_000) : 1;
    // The day view spans the invitation with two hours either side, and never less than five.
    const hours = Math.min(24, Math.max(5, Math.ceil(spanHours) + 4));
    const allDay = invite.schedule.filter((entry) => entry.allDay).length;
    return Math.min(CHROME_HEIGHT + hours * HOURS_HEIGHT + allDay * CONFLICT_LINE_HEIGHT + (invite.conflicts.length > 0 ? CONFLICT_LINE_HEIGHT : 0), cap);
}

const RESPONSES: { response: InviteResponse; label: string; text: string; failure: string }[] = [
    { response: "accepted", label: "Accept", text: "Accept", failure: "Couldn't accept this meeting" },
    { response: "declined", label: "Decline", text: "Decline", failure: "Couldn't decline this meeting" },
    { response: "tentative", label: "Tentative", text: "?", failure: "Couldn't respond tentatively to this meeting" },
];

interface RsvpPanelProps {
    messageUid: string;
    invite: MessageInvite;
    /** Called with the invitation as it stands after an answer or a proposal - the popover then closes. */
    onDone: (invite: MessageInvite) => void;
    /** Escape, or Cancel: close without returning anything. */
    onClose: () => void;
    /** The proposal form is showing, so the box can be sized for it. */
    onProposingChange?: (proposing: boolean) => void;
}

/** What is inside the RSVP popover (or dialog): the meeting, a day view around it and the buttons that answer it. */
function RsvpPanel({ messageUid, invite, onDone, onClose, onProposingChange }: RsvpPanelProps) {
    const titleId = useId();
    const [pending, setPending] = useState<InviteResponse | "propose" | null>(null);
    const [proposing, setProposingState] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const moreRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const busy = pending !== null;
    const when = formatInviteWhen(invite);

    // Focus goes to the first thing to do when the panel opens.
    useEffect(() => {
        rootRef.current?.querySelector<HTMLElement>("button:not([disabled])")?.focus();
    }, []);

    function setProposing(next: boolean) {
        setProposingState(next);
        onProposingChange?.(next);
    }

    async function answer(response: InviteResponse, failure: string) {
        setPending(response);
        try {
            onDone(await respondToMessageInvite(messageUid, response));
        } catch (err) {
            notifyApiError(err, failure);
            setPending(null);
        }
    }

    async function propose(proposal: ProposedTime) {
        setPending("propose");
        try {
            onDone(await proposeNewTime(messageUid, proposal));
        } catch (err) {
            notifyApiError(err, "Couldn't send the proposed time");
            setPending(null);
        }
    }

    function handleKeyDown(event: React.KeyboardEvent) {
        if (event.key === "Escape") {
            event.stopPropagation();
            if (menuOpen) {
                setMenuOpen(false);
                moreRef.current?.focus();
            } else {
                onClose();
            }
        }
    }

    function handleMenuKeyDown(event: React.KeyboardEvent) {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
            return;
        }
        event.preventDefault();
        const items = Array.from(menuRef.current!.querySelectorAll<HTMLElement>('[role="menuitem"]'));
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    }

    return (
        <div
            ref={rootRef}
            role="group"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            className="relative flex-1 min-h-0 flex flex-col text-sm text-text outline-none"
        >
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-2 flex flex-col gap-2">
                <h3 id={titleId} className="font-semibold break-words">
                    {invite.summary?.trim() || "(no title)"}
                </h3>
                {when && <p className="break-words">{when}{invite.recurring && <span className="text-text-muted"> (Repeats)</span>}</p>}
                {invite.conflicts.length > 0 && (
                    <p className="text-danger break-words">
                        <span className="font-medium">Conflicts with:</span> {conflictSummary(invite.conflicts)}
                    </p>
                )}
                {proposing ? (
                    <ProposeTimeForm
                        invite={invite}
                        busy={pending === "propose"}
                        onSubmit={(proposal) => void propose(proposal)}
                        onCancel={() => setProposing(false)}
                    />
                ) : (
                    <InviteTimeline invite={invite} />
                )}
            </div>
            {!proposing && (
                <div className="flex items-center gap-2 px-4 py-3 border-t border-border" aria-busy={busy || undefined}>
                    {RESPONSES.map(({ response, label, text, failure }) => {
                        const current = invite.response === response;
                        return (
                            <Button
                                key={response}
                                type="button"
                                variant={response === "accepted" && !current ? "primary" : "secondary"}
                                className={["!w-auto", response === "tentative" ? "!px-3" : "", current ? "!bg-primary/10 !border-primary disabled:!opacity-100" : ""].join(" ")}
                                aria-label={label}
                                title={label}
                                aria-pressed={current}
                                aria-busy={pending === response || undefined}
                                loading={pending === response}
                                disabled={busy || current}
                                onClick={() => void answer(response, failure)}
                            >
                                {current && <HiOutlineCheck size={14} aria-hidden="true" />}
                                {text}
                            </Button>
                        );
                    })}
                    <div className="ml-auto relative">
                        <button
                            ref={moreRef}
                            type="button"
                            aria-label="More actions"
                            aria-haspopup="menu"
                            aria-expanded={menuOpen}
                            disabled={busy}
                            onClick={() => setMenuOpen((open) => !open)}
                            className="inline-flex items-center justify-center p-1.5 rounded-md border border-border text-text hover:bg-surface-alt disabled:opacity-50"
                        >
                            <HiOutlineEllipsisHorizontal size={18} aria-hidden="true" />
                        </button>
                        {menuOpen && (
                            <div
                                ref={(node) => {
                                    menuRef.current = node;
                                    // A menu that has just opened takes the focus, as a menu does.
                                    node?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
                                }}
                                role="menu"
                                aria-label="More actions"
                                onKeyDown={handleMenuKeyDown}
                                className="absolute bottom-full right-0 mb-1 w-48 py-1 rounded-md border border-border bg-surface shadow-modal z-10"
                            >
                                {invite.canPropose && (
                                    <button
                                        type="button"
                                        role="menuitem"
                                        onClick={() => {
                                            setMenuOpen(false);
                                            setProposing(true);
                                        }}
                                        className="w-full px-3 py-2 text-left hover:bg-surface-alt"
                                    >
                                        Propose new time
                                    </button>
                                )}
                                <a role="menuitem" href={calendarHref(invite)} className="block px-3 py-2 hover:bg-surface-alt">
                                    Open in calendar
                                </a>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export interface InviteRsvpPopoverProps {
    messageUid: string;
    invite: MessageInvite;
    /** The RSVP button: the popover hangs from it, and focus goes back to it when the popover closes. */
    anchorRef: RefObject<HTMLElement | null>;
    /** Called with the invitation as it stands after an answer or a proposal. The popover has closed itself. */
    onDone: (invite: MessageInvite) => void;
    onClose: () => void;
}

/**
 * What the RSVP button opens: an anchored popover on a desktop, a dialog on a phone. A day view of the reader's schedule around the meeting, with
 * the invitation highlighted and its conflicts marked, and Accept, Decline, a "?" for Tentative and a "..." menu (Propose new time, Open in calendar).
 * An answer is sent to the server, which puts the meeting on the calendar and replies to the organizer; the popover then closes and hands the
 * updated invitation to its caller. A failure raises a pop-up and leaves the popover open.
 *
 * Focus moves to the first button when it opens, Escape closes it (a menu open inside it first), and focus returns to the RSVP button.
 */
export default function InviteRsvpPopover({ messageUid, invite, anchorRef, onDone, onClose }: InviteRsvpPopoverProps) {
    const isMobile = useIsMobile();
    const [proposing, setProposing] = useState(false);
    const title = invite.summary?.trim() || "(no title)";

    function close() {
        onClose();
        anchorRef.current?.focus();
    }

    function done(updated: MessageInvite) {
        onDone(updated);
        close();
    }

    const panel = <RsvpPanel messageUid={messageUid} invite={invite} onDone={done} onClose={close} onProposingChange={setProposing} />;
    if (isMobile) {
        return (
            <Modal open onClose={close} title="Meeting invitation">
                {panel}
            </Modal>
        );
    }
    return (
        <PopoverPortal anchorRef={anchorRef} onClose={onClose} width={WIDTH} height={estimateHeight(invite, proposing)} aria-label={`RSVP: ${title}`}>
            {panel}
        </PopoverPortal>
    );
}
