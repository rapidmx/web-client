// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import GravatarSetting from "../../../apps/shared/components/settings/GravatarSetting.js";
import { GRAVATAR_PREFERENCE_KEY, setGravatarEnabled } from "../../../lib/contacts/gravatar.js";

afterEach(() => localStorage.clear());

describe("GravatarSetting", () => {
    it("is off by default and says what turning it on discloses", () => {
        render(<GravatarSetting />);
        expect(screen.getByRole("checkbox", { name: "Show profile pictures from Gravatar" })).not.toBeChecked();
        expect(screen.getByText(/sending a hash of their email address to gravatar\.com/)).toBeInTheDocument();
    });

    it("stores the choice, and follows a change made elsewhere", async () => {
        const user = userEvent.setup();
        render(<GravatarSetting />);
        const box = screen.getByRole("checkbox", { name: "Show profile pictures from Gravatar" });
        await user.click(box);
        expect(box).toBeChecked();
        expect(localStorage.getItem(GRAVATAR_PREFERENCE_KEY)).toBe("on");
        await user.click(box);
        expect(box).not.toBeChecked();
        expect(localStorage.getItem(GRAVATAR_PREFERENCE_KEY)).toBe("off");
        act(() => setGravatarEnabled(true));
        expect(box).toBeChecked();
    });
});
