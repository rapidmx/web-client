// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ErrorPage from "../../../apps/admin/_500.js";

describe("ErrorPage", () => {
    it("renders an internal-server-error message", () => {
        render(<ErrorPage />);
        expect(screen.getByText("Internal server error")).toBeInTheDocument();
    });
});
