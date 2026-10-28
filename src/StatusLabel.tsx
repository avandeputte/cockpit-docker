/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React from 'react';
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";

import cockpit from 'cockpit';

import { statusClass } from './util';
import type { StackStatus } from './util';

const _ = cockpit.gettext;

export const stackStatusText = (status: StackStatus): string => {
    switch (statusClass(status)) {
    case "active":
        return _("Active");
    case "exited":
        return _("Exited");
    case "inactive":
        return _("Inactive");
    default:
        return _("Unknown");
    }
};

export const StackStatusLabel = ({ status, isCompact = true }: { status: StackStatus, isCompact?: boolean }) => {
    const cls = statusClass(status);
    const color = cls === "active" ? "green" : cls === "exited" ? "red" : "grey";
    return <Label isCompact={isCompact} color={color} className={"stack-status stack-status-" + cls}>{stackStatusText(status)}</Label>;
};

/** Status of a single container: running, healthy, unhealthy, exited, ... */
export const ContainerStatusLabel = ({ status }: { status: string | undefined }) => {
    let color: "green" | "red" | "orange" | "grey" = "grey";
    if (status === "running" || status === "healthy")
        color = "green";
    else if (status === "unhealthy" || status === "dead")
        color = "red";
    else if (status === "restarting" || status === "starting" || status === "paused")
        color = "orange";
    return <Label isCompact color={color} className="container-status">{status ?? _("N/A")}</Label>;
};
