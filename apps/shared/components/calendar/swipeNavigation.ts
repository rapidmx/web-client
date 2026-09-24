///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { SwipeDirection } from "../../gestures/useSwipe.js";

/**
 * What a horizontal swipe on the phone layout's calendar does, as the direction the visible period moves: `-1` is the previous
 * month/week/day, `1` the next. This is the one place that mapping lives, so it flips in a single line.
 *
 * As specified, swiping left (finger right to left) shows the previous period and swiping right shows the next, the opposite of the
 * usual "drag the page along with the finger" convention.
 */
export const SWIPE_PERIOD_SHIFT: Readonly<Record<SwipeDirection, 1 | -1>> = { left: -1, right: 1 };
