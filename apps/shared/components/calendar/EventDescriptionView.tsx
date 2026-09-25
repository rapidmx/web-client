///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import { DescriptionNode, htmlToPlainText, parseEventDescription } from "@rapidmx/react-shared/calendar/eventDescription.js";

function renderNodes(nodes: DescriptionNode[]): ReactNode[] {
    return nodes.map((node, index) => {
        if ("text" in node) {
            return node.text;
        }
        switch (node.tag) {
            case "br":
                return <br key={index} />;
            case "a":
                return (
                    <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className="text-primary-dark underline break-words">
                        {renderNodes(node.children)}
                    </a>
                );
            case "ul":
                return (
                    <ul key={index} className="list-disc pl-5 my-0.5">
                        {renderNodes(node.children)}
                    </ul>
                );
            case "ol":
                return (
                    <ol key={index} className="list-decimal pl-5 my-0.5">
                        {renderNodes(node.children)}
                    </ol>
                );
            case "p":
                return (
                    <p key={index} className="mb-1 last:mb-0 min-h-[1lh]">
                        {renderNodes(node.children)}
                    </p>
                );
            case "li":
                return <li key={index}>{renderNodes(node.children)}</li>;
            case "strong":
                return <strong key={index}>{renderNodes(node.children)}</strong>;
            case "em":
                return <em key={index}>{renderNodes(node.children)}</em>;
            case "u":
                return <u key={index}>{renderNodes(node.children)}</u>;
        }
    });
}

export interface EventDescriptionViewProps {
    /** The description as HTML, from the server or an invitation - untrusted, so it is read into allowed elements only (`parseEventDescription()`) and drawn as
     * React elements, never as markup. */
    html?: string | null;
    /** The plain-text description, shown (line breaks kept) when there is no HTML, or when the HTML holds nothing this can draw. */
    text?: string | null;
    className?: string;
}

/**
 * An event's description, read-only: the rich text with its bold, italics, underline, lists and links (which open in a new tab, `noopener noreferrer`),
 * else the plain text. Nothing is drawn for an event with no description.
 */
export default function EventDescriptionView({ html, text, className }: EventDescriptionViewProps) {
    if (htmlToPlainText(html) !== "") {
        return <div className={["break-words", className].filter(Boolean).join(" ")}>{renderNodes(parseEventDescription(html))}</div>;
    }
    return text?.trim() ? <div className={["break-words whitespace-pre-wrap", className].filter(Boolean).join(" ")}>{text}</div> : null;
}
