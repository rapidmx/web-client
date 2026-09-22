// @vitest-environment node
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
// Forced onto the plain `node` environment so `window` and `document` are genuinely absent, the way they are while the server renders a page.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SigningCertificateCard from "../../../apps/shared/components/settings/SigningCertificateCard.js";
import ThemeSwitch from "../../../apps/shared/components/layout/ThemeSwitch.js";
import { useSigningEnrollmentWatcher } from "../../../apps/shared/signing/useSigningEnrollmentWatcher.js";
import { useEnrollmentSnapshot } from "../../../apps/shared/signing/enrollmentTracker.js";

function Probe() {
    const snapshot = useEnrollmentSnapshot("mb1");
    useSigningEnrollmentWatcher({ userUid: "u1", mailboxes: [], enabled: true });
    return <span>{snapshot ? "some" : "none"}</span>;
}

describe("signing certificate SSR guard (no window)", () => {
    it("renders the tracker hook and the watcher without touching window or document", () => {
        expect(typeof window).toBe("undefined");
        expect(typeof document).toBe("undefined");
        expect(renderToStaticMarkup(<Probe />)).toBe("<span>none</span>");
    });

    it("renders the card and the theme switch on the server", () => {
        expect(renderToStaticMarkup(<SigningCertificateCard mode="pending" enrollment={{ status: "pending", progress: 10, stage: "submitted" }} canRequest requesting={false} />)).toContain("progressbar");
        expect(renderToStaticMarkup(<ThemeSwitch />)).toBe("");
    });
});
