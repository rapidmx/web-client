// @vitest-environment jsdom
///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
///////////////////////////////////////////////////////////////////////////////
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import NotFoundPage from "../../../apps/admin/_404.js";

describe("NotFoundPage", () => {
    it("renders a not-found message", () => {
        render(<NotFoundPage />);
        expect(screen.getByText("Page not found")).toBeInTheDocument();
    });
});
