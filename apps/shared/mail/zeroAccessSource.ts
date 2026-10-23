///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { getUnlockedKeys } from "../../../lib/crypto/keySession.js";
import { openZeroAccessMessage } from "../../../lib/crypto/messageSecurity.js";
import { getMessageRawContent, type Message } from "../../../lib/mail/mailApi.js";
import type { ApiClient } from "../../../lib/util/api.js";

/**
 * The original source of a zero-access `message`, decrypted with its mailbox's unlocked keys and base64-encoded - what the server, which holds
 * only the sealed copy, needs for an action that reads the message itself (`reportMessage()`'s `rawMessage`). `undefined` for any other
 * message, while the mailbox is locked, or when it can't be fetched or opened: the action then goes ahead without it.
 */
export async function zeroAccessSourceBase64(message: Pick<Message, "uid" | "mailboxUid" | "zeroAccess">, client?: ApiClient): Promise<string | undefined> {
    const unlocked = message.zeroAccess ? getUnlockedKeys(message.mailboxUid) : undefined;
    if (!unlocked) {
        return undefined;
    }
    try {
        const original = await openZeroAccessMessage(await getMessageRawContent(message.uid, client), unlocked);
        // A binary string (one char per byte), which `btoa()` encodes as the bytes themselves.
        return original === undefined ? undefined : btoa(original);
    } catch {
        return undefined;
    }
}
