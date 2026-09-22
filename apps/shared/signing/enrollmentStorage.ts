///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * A started signing enrollment's id, per mailbox. Kept only so a reload - and the app frame's watcher, on any page - can ask the server
 * (`checkSignEnrollmentStatus()`) whether that enrollment is still pending: a rotation while it is pending would strand the enrollment's
 * already-submitted private key under a master key that no longer exists. The stored id is never trusted on its own - the server's answer
 * decides the state, and restapi's own `rekey()` refuses (409) a rotation during an enrollment this browser never saw (e.g. one started on
 * another device).
 */
export const SIGN_ENROLLMENT_STORAGE_PREFIX = "rapidmx.signEnrollment.";

export function readStoredSignEnrollment(mailboxUid: string): string | null {
    try {
        return localStorage.getItem(SIGN_ENROLLMENT_STORAGE_PREFIX + mailboxUid);
    } catch {
        return null;
    }
}

export function storeSignEnrollment(mailboxUid: string, enrollmentId: string | null): void {
    try {
        if (enrollmentId) {
            localStorage.setItem(SIGN_ENROLLMENT_STORAGE_PREFIX + mailboxUid, enrollmentId);
        } else {
            localStorage.removeItem(SIGN_ENROLLMENT_STORAGE_PREFIX + mailboxUid);
        }
    } catch {
        // Storage blocked - restapi's own 409 on rekey still guards a rotation.
    }
}
