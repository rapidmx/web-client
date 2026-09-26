///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import {
    HiOutlineArrowDownTray,
    HiOutlineArrowUturnLeft,
    HiOutlineArrowUturnRight,
    HiOutlineCodeBracket,
    HiOutlineCog6Tooth,
    HiOutlineDocumentText,
    HiOutlineEllipsisHorizontal,
    HiOutlineEnvelope,
    HiOutlineEnvelopeOpen,
    HiOutlineEye,
    HiOutlineFlag,
    HiOutlineFunnel,
    HiOutlineHandRaised,
    HiOutlineInformationCircle,
    HiOutlineNoSymbol,
    HiOutlinePrinter,
    HiOutlineShieldCheck,
    HiOutlineShieldExclamation,
    HiOutlineTrash,
} from "react-icons/hi2";
import MenuButton, { MenuItemSpec, MenuSectionSpec } from "../MenuButton.js";

/** What each row of the menu does - the reading pane's own handlers. */
export interface MessageMenuActions {
    replyAll: () => void;
    forward: () => void;
    deleteMessage: () => void;
    toggleRead: () => void;
    toggleFlag: () => void;
    reportJunk: () => void;
    reportPhishing: () => void;
    blockSender: () => void;
    neverBlockSender: () => void;
    print: () => void;
    viewSource: () => void;
    viewDetails: () => void;
    saveAsEml: () => void;
    createRule: () => void;
}

export interface MessageMoreMenuProps {
    actions: MessageMenuActions;
    /** The sender's address the Block rows name. */
    senderAddress: string;
    read: boolean;
    flagged: boolean;
    /** The reader may change this mailbox's messages and filters (it is not a view-only share). */
    writable: boolean;
    /** Something is already being done to the message: its rows wait. */
    busy: boolean;
    inJunk: boolean;
    /** The message is in Deleted Items: the Delete row reads "Delete permanently". */
    inDeletedItems: boolean;
    /** Mail the reader sent: it is not junk, and its sender is the reader. */
    sent: boolean;
    /** The sender is one of the reader's own addresses, which is not blocked. */
    ownSender: boolean;
    /** Why the message cannot be printed right now (an encrypted one that is locked or still opening), or `undefined`. */
    printReason: string | undefined;
    /** The compose window is opening for a reply or forward: Reply all and Forward wait for it. */
    composing: boolean;
    /** The classes of the round "..." button - the reading pane's own icon-button look. */
    triggerClassName: string;
}

const VIEW_ONLY = "View-only mailbox";

/** A row, disabled with `reason` (shown under the label, where a keyboard or phone user sees it as well) when there is one. */
function row(key: string, label: string, icon: React.ReactNode, onSelect: () => void, reason?: string, extra: Partial<MenuItemSpec> = {}): MenuItemSpec {
    return { key, label, icon, onSelect, disabled: reason !== undefined, description: reason, ...extra } as MenuItemSpec;
}

/** The sections of the menu - Outlook's "More actions", cut to what this product really does. */
export function buildMessageMenu(props: MessageMoreMenuProps): MenuSectionSpec[] {
    const { actions, read, flagged, writable, busy, inJunk, inDeletedItems, sent, ownSender, printReason, composing } = props;
    // The reason a row that changes the message is unavailable, if it is: the first that applies wins.
    const changeReason = !writable ? VIEW_ONLY : undefined;
    const junkReason = changeReason ?? (sent ? "Not available for mail you sent" : inJunk ? "Already in Junk Email" : undefined);
    const blockReason = changeReason ?? (sent ? "Not available for mail you sent" : ownSender ? "This is your own address" : undefined);
    const waiting = (reason: string | undefined) => reason ?? (busy ? "Working on this message" : undefined);
    const blockLabel = `Block ${props.senderAddress}`;
    const neverBlockLabel = `Never block ${props.senderAddress}`;
    return [
        {
            key: "message",
            items: [
                {
                    key: "reply-actions",
                    label: "Other reply actions",
                    icon: <HiOutlineArrowUturnLeft size={16} />,
                    submenu: [
                        {
                            key: "reply-actions-items",
                            items: [
                                row("reply-all", "Reply all", <HiOutlineArrowUturnLeft size={16} />, actions.replyAll, composing ? "Opening the compose window" : undefined),
                                row("forward", "Forward", <HiOutlineArrowUturnRight size={16} />, actions.forward, composing ? "Opening the compose window" : undefined),
                            ],
                        },
                    ],
                },
                row(
                    "delete",
                    // In Deleted Items there is nowhere further to move it to: Delete is the permanent one, and asks first.
                    inDeletedItems ? "Delete permanently" : "Delete",
                    <HiOutlineTrash size={16} />,
                    actions.deleteMessage,
                    waiting(changeReason),
                ),
                row(
                    "toggle-read",
                    read ? "Mark as unread" : "Mark as read",
                    read ? <HiOutlineEnvelope size={16} /> : <HiOutlineEnvelopeOpen size={16} />,
                    actions.toggleRead,
                    waiting(changeReason),
                ),
                row("toggle-flag", flagged ? "Unflag" : "Flag", <HiOutlineFlag size={16} />, actions.toggleFlag, waiting(changeReason)),
            ],
        },
        {
            key: "sender",
            items: [
                {
                    key: "report",
                    label: "Report",
                    icon: <HiOutlineNoSymbol size={16} />,
                    submenu: [
                        {
                            key: "report-items",
                            items: [
                                row("report-junk", "Report junk", <HiOutlineNoSymbol size={16} />, actions.reportJunk, waiting(junkReason)),
                                row("report-phishing", "Report phishing", <HiOutlineShieldExclamation size={16} />, actions.reportPhishing, waiting(junkReason)),
                            ],
                        },
                    ],
                },
                {
                    key: "block",
                    label: "Block",
                    icon: <HiOutlineHandRaised size={16} />,
                    submenu: [
                        {
                            key: "block-items",
                            items: [
                                row("block-sender", blockLabel, <HiOutlineHandRaised size={16} />, actions.blockSender, waiting(blockReason), { title: blockLabel }),
                                row(
                                    "never-block-sender",
                                    neverBlockLabel,
                                    <HiOutlineShieldCheck size={16} />,
                                    actions.neverBlockSender,
                                    waiting(blockReason),
                                    { title: neverBlockLabel },
                                ),
                            ],
                        },
                    ],
                },
            ],
        },
        {
            key: "output",
            items: [
                row("print", "Print", <HiOutlinePrinter size={16} />, actions.print, printReason),
                {
                    key: "view",
                    label: "View",
                    icon: <HiOutlineEye size={16} />,
                    submenu: [
                        {
                            key: "view-items",
                            items: [
                                row("view-source", "View message source", <HiOutlineCodeBracket size={16} />, actions.viewSource),
                                row("view-details", "Message details", <HiOutlineInformationCircle size={16} />, actions.viewDetails),
                            ],
                        },
                    ],
                },
                {
                    key: "save-as",
                    label: "Save as",
                    icon: <HiOutlineArrowDownTray size={16} />,
                    submenu: [
                        {
                            key: "save-as-items",
                            items: [
                                row("save-eml", "Save as .eml", <HiOutlineEnvelope size={16} />, actions.saveAsEml),
                                row("save-pdf", "Save as PDF", <HiOutlineDocumentText size={16} />, actions.print, printReason, {
                                    description: printReason ?? "Opens the print dialog: choose Save as PDF",
                                }),
                            ],
                        },
                    ],
                },
            ],
        },
        {
            key: "advanced",
            items: [
                {
                    key: "advanced-actions",
                    label: "Advanced actions",
                    icon: <HiOutlineCog6Tooth size={16} />,
                    submenu: [
                        {
                            key: "advanced-items",
                            items: [row("create-rule", "Create rule", <HiOutlineFunnel size={16} />, actions.createRule, changeReason)],
                        },
                    ],
                },
            ],
        },
    ];
}

/**
 * The "..." at the end of a message card's icon row: Outlook's More actions menu, holding the actions there is no room for beside the
 * message and the ones that are less often wanted. An ARIA menu (`MenuButton`): arrows, Home and End move, Right or Enter opens a submenu, Left or
 * Escape leaves it (Escape at the top closes the menu and the focus goes back to this button), and a click outside closes it. A row that cannot be used right now
 * is disabled and says why under its label.
 */
export default function MessageMoreMenu(props: MessageMoreMenuProps) {
    return (
        <MenuButton
            iconOnly
            label="More actions"
            aria-label="More actions"
            title="More actions"
            icon={<HiOutlineEllipsisHorizontal size={16} aria-hidden="true" />}
            className={props.triggerClassName}
            sections={buildMessageMenu(props)}
            width={288}
        />
    );
}
