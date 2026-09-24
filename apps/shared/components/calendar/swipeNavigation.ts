///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { SwipeDirection } from "../../gestures/useSwipe.js";

/**
 * What a horizontal swipe on the phone layout's calendar does, as the direction the visible period moves: `-1` is the previous
 * month/week/day, `1` the next. This is the one place that mapping lives, so it flips in a single line.
 *
 * Swiping left (finger right to left) shows the next period and swiping right shows the previous, as most calendar apps do: the page is
 * dragged along with the finger, and what was to its right comes in.
 */
export const SWIPE_PERIOD_SHIFT: Readonly<Record<SwipeDirection, 1 | -1>> = { left: 1, right: -1 };
