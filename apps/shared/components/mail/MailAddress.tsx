///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { useState } from "react";
import { MailAddressLike, formatMailAddress, splitMailAddress } from "@rapidmx/react-shared/mail/mailAddress.js";

export interface MailAddressProps {
    /** A message's `from`, a recipient, a conversation participant. */
    recipient: MailAddressLike;
    className?: string;
}

/**
 * A sender or recipient as one compact line for a dense row: the name, when there is one, with the real address in muted
 * type after it - `Jean-Philippe  <jp@example.com>` - or the bare address without a name. The address is never left out,
 * and when the row is too narrow for both the name gives way first (it shrinks a thousand times faster), then the
 * address's own local part - the `@domain`, which is what says who really sent it, keeps its room to the end. The full
 * `Name <address>` is the tooltip and, once, the accessible text (the two visible halves are hidden from assistive
 * technology), so a screen reader hears one address, not fragments.
 */
export default function MailAddress({ recipient, className }: MailAddressProps) {
    const { name, address } = splitMailAddress(recipient);
    const full = formatMailAddress(recipient);
    const at = address.lastIndexOf("@");
    const local = at > 0 ? address.slice(0, at) : address;
    const domain = at > 0 ? address.slice(at) : "";
    return (
        <span className={["flex min-w-0 items-baseline gap-1.5", className].filter(Boolean).join(" ")} title={full}>
            <span className="sr-only">{full}</span>
            {name && (
                <span aria-hidden="true" className="truncate min-w-0" style={{ flexShrink: 1000 }}>
                    {name}
                </span>
            )}
            <span
                aria-hidden="true"
                className={["flex min-w-0 items-baseline", name ? "text-xs font-normal text-text-muted" : ""].filter(Boolean).join(" ")}
            >
                {name && <span>&lt;</span>}
                <span className="truncate min-w-0">{local}</span>
                {domain && <span className="shrink-0">{domain}</span>}
                {name && <span>&gt;</span>}
            </span>
        </span>
    );
}

/** How many recipients a `RecipientLine` shows before folding the rest behind "and N more". */
export const RECIPIENT_LINE_LIMIT = 3;

/**
 * A `To`/`Cc` line of a message header: every recipient as `Name <address>` in the text itself (never hover-only), wrapping
 * onto more lines as needed. A long list shows its first `RECIPIENT_LINE_LIMIT` and folds the rest behind a button -
 * "and 12 more" / "Show fewer" - so a message to a hundred people doesn't take the whole header. Nothing when empty.
 */
export function RecipientLine({ label, recipients }: { label: string; recipients: MailAddressLike[] }) {
    const [expanded, setExpanded] = useState(false);
    if (recipients.length === 0) {
        return null;
    }
    const folded = recipients.length > RECIPIENT_LINE_LIMIT;
    const shown = folded && !expanded ? recipients.slice(0, RECIPIENT_LINE_LIMIT) : recipients;
    return (
        <p className="text-sm text-text-muted break-words">
            <span>{label}</span>{" "}
            {shown.map((recipient, index) => (
                <React.Fragment key={index}>
                    {index > 0 && ", "}
                    <span>{formatMailAddress(recipient)}</span>
                </React.Fragment>
            ))}
            {folded && (
                <>
                    {" "}
                    <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setExpanded((open) => !open)}
                        className="text-xs font-semibold text-primary-dark underline hover:no-underline"
                    >
                        {expanded ? "Show fewer" : `and ${recipients.length - RECIPIENT_LINE_LIMIT} more`}
                    </button>
                </>
            )}
        </p>
    );
}
