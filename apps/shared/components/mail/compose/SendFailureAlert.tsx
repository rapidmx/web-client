///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import Alert from "@rapidmx/react-shared/components/feedback/Alert.js";
import CopyButton from "@rapidmx/react-shared/components/buttons/CopyButton.js";

export interface SendFailureAlertProps {
    /** The plain, human message - always shown. */
    message: string;
    /** The technical facts behind it (`describeSendFailure().lines`): per-recipient SMTP results, a transport error.
     * With none, only the message is shown. */
    lines: string[];
}

/**
 * The banner a compose window shows when a send (or scheduled send) fails: the plain message, prominent, and - when the
 * server said more - a collapsed "Technical details" block of monospace lines, one per fact, that can be selected or
 * copied in one go to send to whoever runs the server. Collapsed, because most people only need the message.
 */
export default function SendFailureAlert({ message, lines }: SendFailureAlertProps) {
    return (
        <Alert>
            <div className="flex-1 min-w-0">
                <p className="font-semibold break-words">{message}</p>
                {lines.length > 0 && (
                    <details className="mt-2">
                        <summary className="cursor-pointer text-xs font-semibold">Technical details</summary>
                        <ul
                            aria-label="Technical details"
                            className="mt-2 max-h-40 overflow-auto rounded-sm border border-border bg-surface p-2 text-xs font-mono text-text select-text"
                        >
                            {lines.map((line, index) => (
                                <li key={index} className="whitespace-pre-wrap break-words">
                                    {line}
                                </li>
                            ))}
                        </ul>
                        <div className="mt-2">
                            <CopyButton value={lines.join("\n")} label="Copy technical details" />
                        </div>
                    </details>
                )}
            </div>
        </Alert>
    );
}
