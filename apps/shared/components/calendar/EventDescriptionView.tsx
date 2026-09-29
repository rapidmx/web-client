///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React, { ReactNode } from "react";
import { DescriptionNode, htmlToPlainText, parseEventDescription } from "../../../../lib/calendar/eventDescription.js";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;
const LINK_CLASS = "text-primary-dark underline break-words";

function count(text: string, character: string): number {
    return text.split(character).length - 1;
}

/**
 * `text` with every web address in it made a link that opens in a new tab: a description's own links are its author's, but Google Meet joins, dial-in pages
 * and the like are often only typed into the text. Punctuation that ends a sentence, or closes a bracket the address was not in, stays out of the link.
 */
export function linkifyText(text: string): ReactNode[] {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        let url = match[0];
        while (/[.,;:!?]$/.test(url) || (url.endsWith(")") && count(url, ")") > count(url, "(")) || (url.endsWith("]") && count(url, "]") > count(url, "["))) {
            url = url.slice(0, -1);
        }
        const at = match.index!;
        parts.push(text.slice(last, at));
        parts.push(
            <a key={at} href={url} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                {url}
            </a>,
        );
        last = at + url.length;
    }
    parts.push(text.slice(last));
    return parts;
}

function renderNodes(nodes: DescriptionNode[], insideLink = false): ReactNode[] {
    return nodes.map((node, index) => {
        if ("text" in node) {
            return insideLink ? node.text : <React.Fragment key={index}>{linkifyText(node.text)}</React.Fragment>;
        }
        switch (node.tag) {
            case "br":
                return <br key={index} />;
            case "a":
                return (
                    <a key={index} href={node.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                        {renderNodes(node.children, true)}
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
    return text?.trim() ? <div className={["break-words whitespace-pre-wrap", className].filter(Boolean).join(" ")}>{linkifyText(text)}</div> : null;
}
