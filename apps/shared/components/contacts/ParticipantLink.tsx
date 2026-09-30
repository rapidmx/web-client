///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import { useContactCard } from "./ContactCardProvider.js";
import type { ContactCardContext } from "./contactCardData.js";
import type { Participant } from "./participantDetails.js";

export interface ParticipantLinkProps {
    participant: Participant;
    /** The message the participant was met in - see `ContactCardValue.show`. */
    context?: ContactCardContext;
    /** The button's accessible name, when what it shows has none of its own (an avatar). */
    label?: string;
    className?: string;
    children: ReactNode;
}

/**
 * A participant of a message or an event (a sender, a recipient, an organizer, a guest) that opens their contact card when clicked: a real
 * button, underlined on hover and with a visible focus ring, named by what it shows. Outside a `ContactCardProvider` it is plain text. Never
 * put one inside another button or link.
 */
export default function ParticipantLink({ participant, context, label, className, children }: ParticipantLinkProps) {
    const { show, available } = useContactCard();
    if (!available) {
        return <span className={className}>{children}</span>;
    }
    return (
        <button
            type="button"
            aria-label={label}
            onClick={() => show(participant, context)}
            className={["text-left rounded-sm hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary", className]
                .filter(Boolean)
                .join(" ")}
        >
            {children}
        </button>
    );
}
