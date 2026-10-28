// SPDX-License-Identifier: LGPL-2.1-or-later

// Python helpers are bundled as text (see the ".py" loader in build.js)
declare module '*.py' {
    const content: string;
    export default content;
}
