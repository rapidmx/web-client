///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { HiOutlineLockClosed } from "react-icons/hi2";

/** The subject an encrypted message carries on the server (RFC 9788's placeholder): the real one is inside the ciphertext. */
export const ENCRYPTED_SUBJECT_PLACEHOLDER = "[...]";

/**
 * What a list row's preview line says for an encrypted message nothing has been decrypted of yet: a small lock and "Encrypted message". The server never
 * derives a preview for encrypted mail (it has no plaintext), so the line would otherwise be empty.
 */
export function EncryptedPreview() {
    return (
        <span className="inline-flex items-center gap-1">
            <HiOutlineLockClosed size={12} aria-hidden="true" className="shrink-0" />
            Encrypted message
        </span>
    );
}

/**
 * Whether a conversation row stands for an encrypted latest message. A conversation summary carries no flag for it, but an encrypted message has no preview
 * and the placeholder subject - which a plaintext message with an empty body does not.
 */
export function conversationLooksEncrypted(conversation: { subject: string; latestPreview: string }): boolean {
    return conversation.latestPreview === "" && conversation.subject === ENCRYPTED_SUBJECT_PLACEHOLDER;
}

/** The subject to show for a message's own: what an encrypted message says is the placeholder, which nobody should have to read as a title. */
export function displaySubject(subject: string): string {
    return subject === ENCRYPTED_SUBJECT_PLACEHOLDER ? "Encrypted message" : subject;
}
