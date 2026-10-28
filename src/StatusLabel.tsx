/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 */

import React from 'react';
import { Label } from "@patternfly/react-core/dist/esm/components/Label/index.js";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip/index.js";
import { ArrowCircleUpIcon } from '@patternfly/react-icons';

import cockpit from 'cockpit';

import type { ServiceUpdate } from './docker';
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

/** "Update available" for a stack or service; for a service also a failed check */
export const UpdateLabel = ({ updates, isCompact = true }: { updates: ServiceUpdate[], isCompact?: boolean }) => {
    const available = updates.filter(u => u.status === "update-available");
    if (available.length > 0) {
        const images = [...new Set(available.map(u => u.image))].join(", ");
        return (
            <Tooltip content={cockpit.format(_("Newer image available: $0"), images)}>
                <Label isCompact={isCompact} color="blue" icon={<ArrowCircleUpIcon />} className="update-available" tabIndex={0}>
                    {_("Update available")}
                </Label>
            </Tooltip>
        );
    }
    const failed = updates.filter(u => u.status === "error");
    if (failed.length > 0 && failed.length === updates.length) {
        return (
            <Tooltip content={failed.map(u => `${u.image}: ${u.error}`).join("; ")}>
                <Label isCompact={isCompact} variant="outline" className="update-check-failed" tabIndex={0}>
                    {_("Update check failed")}
                </Label>
            </Tooltip>
        );
    }
    return null;
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
