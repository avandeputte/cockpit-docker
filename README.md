# cockpit-docker: Docker Compose stacks in Cockpit

A [Cockpit](https://cockpit-project.org/) module for managing Docker Compose
stacks. It is a port of [Dockge](https://github.com/louislam/dockge) to
Cockpit: the same features, but running inside the Cockpit web console with
PatternFly, Cockpit's login and privilege handling, and no extra daemon.

## Features

Everything Dockge does, with these Cockpit equivalents:

| Dockge | This module |
| --- | --- |
| Stack list with search and status | **Docker stacks** page: Active/Exited/Inactive counters, searchable and filterable stack table |
| Compose editor (`compose.yaml` + `.env`) | YAML and `.env` editors (CodeMirror) with live validation, plus form editors per service (image, ports, volumes, restart policy, environment, container name, networks, depends on), internal/external networks and `x-dockge` URLs. Comments in the YAML are kept when using the forms |
| Deploy / Save / Start / Stop / Restart / Update / Down / Delete | Same buttons; output of `docker compose` is streamed into a terminal |
| Per-service start / stop / restart, status and CPU/memory stats | Service cards, refreshed every 5 seconds |
| Combined logs terminal | `docker compose logs -f` terminal on the stack page |
| Container "Bash" terminal (bash / sh) | Interactive terminal page per service |
| Console | Shell in the stacks directory (opt-in in Settings) |
| `docker run` → compose conversion | **Docker run** card (uses composerize, in the browser) |
| Agents (multiple Docker hosts) | **Hosts** card: other machines are reached through Cockpit's SSH connection (`user@host`) |
| Settings: primary hostname, global.env | Settings dialog: stacks directory, primary hostname, `global.env`, console |
| Login, 2FA, password, appearance | Handled by Cockpit itself (login, administrative access, light/dark theme, language) |

Stacks live in `/opt/stacks/<name>/compose.yaml` by default, exactly like
Dockge, so an existing Dockge stacks directory works as is. Compose projects
started elsewhere are listed too, marked "Not managed".

Settings are stored in `/etc/cockpit/docker.json` on each host.

## How it works

There is no backend service. The browser code runs `docker compose ...` and
reads/writes the stack files through the Cockpit bridge (`cockpit.spawn()` and
stream channels), with `superuser: "try"`, so it uses administrative access when
the user has it turned on, and otherwise works for users in the `docker` group.
Remote hosts use the `host` option of those channels.

## Requirements

* Cockpit 137 or later (tested with 362)
* Docker Engine with the compose plugin (`docker compose`) on each managed host
* For other hosts: Cockpit must be able to log in to them over SSH (for example
  with SSH keys); recent Cockpit releases may need `AllowMultiHost = yes` in
  `/etc/cockpit/cockpit.conf`

## Installing

Download the `.rpm` or `.deb` from the
[releases](https://github.com/avandeputte/cockpit-docker/releases) (or from the
artifacts of the "build" workflow), then:

```sh
sudo dnf install ./cockpit-docker-*.noarch.rpm     # Fedora, RHEL, ...
sudo apt install ./cockpit-docker_*_all.deb         # Debian, Ubuntu, ...
```

Or from source: `make && sudo make install PREFIX=/usr`.

## Development

Follows the layout of Cockpit's
[starter-kit](https://github.com/cockpit-project/starter-kit) and the
[development guide](https://docs.cockpit-project.org/cockpit-guide/latest/guide/development.html).

```sh
make                 # fetch pkg/lib from Cockpit, npm install, build dist/
make devel-install   # symlink dist/ to ~/.local/share/cockpit/docker
make watch           # rebuild on changes
npm run eslint       # lint
npx tsc --noEmit     # type check
npm test             # unit tests (QUnit, run with node)
```

After `make devel-install`, log in to Cockpit and open **Docker stacks**.

Source layout:

* `src/util.ts`: pure helpers (compose YAML, env substitution, ports, docker output parsing); unit tested in `test/unit/`
* `src/docker.ts`: everything that touches the host, through `cockpit.spawn()` / channels
* `src/model.ts`: hosts and stack list state, polling
* `src/Overview.tsx`, `src/StackPage.tsx`, `src/ServiceCard.tsx`, `src/TerminalPages.tsx`, `src/SettingsDialog.tsx`: pages
* `test/check-application`: Cockpit browser integration test (needs Cockpit's test VMs, `make check`)

### Translations

User-visible strings use `cockpit.gettext()`; `make po/docker.pot` extracts
them. Put translations in `po/<lang>.po`.

## Packaging

```sh
make dist   # cockpit-docker-VERSION.tar.xz with a pre-built dist/
make rpm    # noarch RPM (needs rpmbuild)
make deb    # Debian/Ubuntu package (needs dpkg-deb)
```

The version comes from `git describe --tags`, so tag releases as `v1.2.3`.
The GitHub workflow builds both packages on every push and pull request, and
attaches them to a GitHub release when a `v*` tag is pushed.

## License

LGPL-2.1-or-later, like Cockpit. Code ported from Dockge is MIT licensed, see
[LICENSE.dockge](LICENSE.dockge).
