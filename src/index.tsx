/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

import "cockpit-dark-theme";

import { Application } from './app.jsx';

import "patternfly/patternfly-6-cockpit.scss";
// The pf-v6-u-* classes used on the pages (subtle text, small spacing)
import "@patternfly/patternfly/utilities/Spacing/spacing.css";
import "@patternfly/patternfly/utilities/Text/text.css";
import './app.scss';

document.addEventListener("DOMContentLoaded", () => {
    createRoot(document.getElementById("app")!).render(<Application />);
});
