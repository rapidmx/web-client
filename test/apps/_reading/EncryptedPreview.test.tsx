// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
    ENCRYPTED_SUBJECT_PLACEHOLDER,
    EncryptedPreview,
    conversationLooksEncrypted,
    displaySubject,
} from "../../../apps/shared/components/mail/reading/EncryptedPreview.js";

describe("EncryptedPreview", () => {
    it("is a small lock - decoration - and the words 'Encrypted message'", () => {
        const { container } = render(<EncryptedPreview />);
        expect(screen.getByText("Encrypted message")).toBeInTheDocument();
        expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });
});

describe("conversationLooksEncrypted", () => {
    it("is true for the placeholder subject and no preview - what an encrypted latest message leaves - and for nothing else", () => {
        expect(ENCRYPTED_SUBJECT_PLACEHOLDER).toBe("[...]");
        expect(conversationLooksEncrypted({ subject: "[...]", latestPreview: "" })).toBe(true);
        expect(conversationLooksEncrypted({ subject: "[...]", latestPreview: "Decrypted elsewhere" })).toBe(false);
        expect(conversationLooksEncrypted({ subject: "Lunch", latestPreview: "" })).toBe(false);
    });
});

describe("displaySubject", () => {
    it("names the placeholder subject of an encrypted message, and leaves every other subject exactly as it is", () => {
        expect(displaySubject("[...]")).toBe("Encrypted message");
        expect(displaySubject("Lunch")).toBe("Lunch");
        expect(displaySubject("")).toBe("");
    });
});
