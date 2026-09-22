// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Message } from "@rapidmx/react-shared/mail/mailApi.js";
import OutboxRowStatus from "../../../apps/shared/components/mail/OutboxRowStatus.js";

const row = (fields: Partial<Message>) => <OutboxRowStatus message={{ uid: "m1", ...fields } as Message} />;

describe("OutboxRowStatus", () => {
    it("says a queued message is sending, with the animated dot", () => {
        const { container } = render(row({}));
        expect(screen.getByTestId("outbox-row-status")).toHaveTextContent("Sending…");
        expect(screen.getByTestId("outbox-row-status")).toHaveAttribute("data-state", "sending");
        expect(container.querySelector(".rr-sending-dot")).not.toBeNull();
    });

    it("counts the next attempt for a message the server will try again, with the time when it has one", () => {
        const { rerender } = render(row({ scheduledSendAttempts: 2 }));
        expect(screen.getByTestId("outbox-row-status")).toHaveTextContent("Retrying (attempt 3)");
        rerender(row({ scheduledSendAttempts: 1, scheduledSendTime: "2999-01-01T10:00:00.000Z" }));
        expect(screen.getByTestId("outbox-row-status")).toHaveTextContent(/^Retrying \(attempt 2, .+\)$/);
    });

    it("spells out why a message was not sent, in red, and shows when a scheduled one will go", () => {
        const { rerender, container } = render(row({ scheduledSendError: "Relay access denied." }));
        expect(screen.getByTestId("outbox-row-status")).toHaveTextContent("Not sent: Relay access denied.");
        expect(screen.getByTestId("outbox-row-status").className).toContain("text-danger");
        expect(container.querySelector(".rr-sending-dot")).toBeNull();
        rerender(row({ scheduledSendTime: "2999-01-01T10:00:00.000Z" }));
        expect(screen.getByTestId("outbox-row-status")).toHaveTextContent(/^Scheduled for /);
        expect(screen.getByTestId("outbox-row-status").className).not.toContain("text-danger");
    });
});
