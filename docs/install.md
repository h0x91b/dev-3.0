# Install

Every way to get dev-3.0 onto a machine. The two fastest paths (agent-driven and Homebrew) are
in the [README quick start](../README.md#quick-start) — this page is the full reference.

- [macOS desktop app](#macos--desktop-app)
- [Windows — zip download](#windows--zip-download)
- [Windows via WSL, with the UI in a Windows browser](#windows-via-wsl-with-the-ui-in-a-windows-browser)
- [Linux](#linux)
- [tmux on Linux — the version matters](#tmux-on-linux--the-version-matters)
- [Cloud VM caveats](#cloud-vm-caveats)
- [Build from source](#build-from-source)

## macOS — desktop app

### Homebrew (recommended)

```sh
brew tap h0x91b/dev3
brew trust h0x91b/dev3   # newer Homebrew refuses untrusted third-party taps (skip on older brew)
brew install --cask dev3
```

Auto-installs the required `git` and `cloudflared` dependencies (the latter powers the
public-tunnel option used by `dev3 remote` and the in-app remote-access modal). tmux is bundled
inside the app itself — a pinned, self-contained 3.6a build (tmux 3.7 has a client-side CPU
regression; see [Troubleshooting](troubleshooting.md)).

```sh
brew upgrade --cask dev3   # update
brew uninstall --cask dev3 # remove
```

### Manual download

Grab the latest `.dmg` directly — [**Apple Silicon**](https://github.com/h0x91b/dev-3.0/releases/latest/download/stable-macos-arm64-dev-3.0.dmg)
or [**Intel**](https://github.com/h0x91b/dev-3.0/releases/latest/download/stable-macos-x64-dev-3.0.dmg)
— drag to Applications, and run. tmux is bundled inside the app; make sure `git` is installed,
plus `cloudflared` if you want the public-tunnel feature (`brew install cloudflared`; safe to
skip otherwise).

Apple Silicon and Intel are both supported. For Windows, see the next section.

### Repositories on Desktop or Documents

Projects under `~/Desktop` or `~/Documents` are supported. If a task terminal later reports
`Operation not permitted` there, or Git says `not a git repository`, follow
[Task terminals lose access to Desktop or Documents](troubleshooting.md#task-terminals-lose-access-to-desktop-or-documents-on-macos).
The fix observed so far involves the running tmux binary, which is a different entry from the app
in macOS privacy settings. Full Disk Access is broad and not a blanket installation step.

## Windows — zip download

**Windows support is brand new and may still be rough.** x64 only, and there is no installer or
Homebrew path — one zip you extract and run. Every tagged release carries it:

1. Download [**`stable-win-x64-dev-3.0.zip`**](https://github.com/h0x91b/dev-3.0/releases/latest/download/stable-win-x64-dev-3.0.zip)
   (~121 MB to download, ~400 MB once extracted) from the latest release. **Automatic updating is
   not proven on Windows.** The first observed attempt hung — a blank console window, and a stale
   `launcher.exe` still holding the extracted tree, which had to be killed by hand before the
   update finished. Treat a new build as a fresh download of this zip until that is fixed.
2. Right-click the zip → **Extract All**. Nothing else is needed; the app carries its own runtime.
3. Open the extracted `dev-3.0` folder and double-click `bin\launcher.exe`.
4. **The first launch shows a full-screen blue SmartScreen warning.** This build is not
   code-signed at this time — there is no certificate today, and that may change in the future.
   Two clicks get past it: **More info**, then **Run anyway**, once per build. That dialog means
   Windows does not recognise the publisher; it is not a virus report.

`git` has to be on `PATH` (dev3 creates a git worktree per task). Terminals run over PowerShell —
no tmux and no WSL involved. The `dev3` CLI ships inside the bundle at
`Resources\app\cli\dev3.exe`; there is no standalone Windows CLI tarball yet.

Testing `main` instead? The rolling [`canary`](https://github.com/h0x91b/dev-3.0/releases/tag/canary)
pre-release carries `canary-win-x64-dev-3.0-canary.zip`, rebuilt from `main` and deliberately not
marked "Latest" — canary builds are not tested releases.

Every Windows zip, on either channel, is the exact tree CI extracted and launched on a Windows
runner before publishing — that is the only guarantee on offer, and it is not the same as "tested".

## Windows via WSL, with the UI in a Windows browser

The alternative to the zip: run the Linux `dev3` engine inside WSL2, where agents get real tmux
terminals and a Linux toolchain, and open the UI in a browser on Windows. Nothing runs on the
Windows side except the browser.

### Pick a topology

| | Projects live on | Worktrees and engine on | Use it when |
|---|---|---|---|
| **Full WSL** | the WSL ext4 filesystem (`~/src/...`) | ext4 | The repo is backed by a remote anyway. Fastest by a wide margin |
| **Hybrid** | a Windows drive (`/mnt/c/...`, `/mnt/e/...`) | ext4 | The project tree has to stay on the Windows drive (Windows tools own it, or it must survive a distro reset) |

Every file access under `/mnt/<drive>` crosses the 9p bridge between WSL and Windows, and that is
slow for anything that touches many small files: on one machine `bun install` in a project on
`/mnt/e` took about six minutes, and the test suite never finished. Full WSL avoids the bridge
entirely.

Hybrid keeps the heavy part off it. dev3 puts task worktrees under `~/.dev3.0/worktrees/`, which
is on ext4 whatever the project path is, so dependency installs, builds and tests inside a task run
at native speed. What still crosses the bridge is the main checkout and its `.git` directory: git
operations in a task read the shared object store over 9p, and each worktree's index and admin data
live in the main repo's `.git/worktrees/`, so they cross it too. Work done directly in the main
checkout is as slow as before. Do not run `git worktree prune` from a Windows git client on that
repo, and keep Windows-side tools from running `git gc` there (it prunes worktrees too): Windows
git cannot resolve the `/home/...` worktree paths, treats them as gone and deletes their admin
data, which breaks every task worktree.

### Install

Inside the WSL distro (Ubuntu shown). WSL2 with systemd is assumed; recent Ubuntu images enable it
by default, otherwise set `systemd=true` under `[boot]` in `/etc/wsl.conf` and run `wsl --shutdown`
from Windows.

```sh
sudo apt-get update && sudo apt-get install -y tmux git
case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=x64;; esac   # Windows on ARM runs an arm64 distro
curl -fsSL -o /tmp/dev3.tar.gz \
  "https://github.com/h0x91b/dev-3.0/releases/latest/download/dev3-cli-linux-$A.tar.gz"
mkdir -p ~/.dev3 && tar -C ~/.dev3 -xzf /tmp/dev3.tar.gz
echo 'export PATH=$HOME/.dev3:$PATH' >> ~/.bashrc && export PATH=$HOME/.dev3:$PATH
```

Check `tmux -V` against [tmux on Linux](#tmux-on-linux--the-version-matters). `cloudflared` is not
needed: the browser is on the same machine, so the public tunnel stays off.

### First run, in the foreground

```sh
DEV3_TELEMETRY=off dev3 remote --no-detach --no-tunnel --host 127.0.0.1 --port 8090
```

- `DEV3_TELEMETRY=off` turns telemetry off from the first start. Leave it out if you are happy to
  send it; the in-app toggle works either way.
- `--no-tunnel` skips the Cloudflare quick tunnel.
- `--host 127.0.0.1` keeps the server off the network. The default bind is `0.0.0.0`, and under
  WSL's mirrored networking mode that puts the sign-in page on your LAN.
- `--port 8090` gives a stable address to bookmark.

Open the printed URL in a Windows browser: `http://localhost:8090/...`. WSL forwards connections
to `localhost` on Windows into the distro (WSL's default `localhostForwarding`; do not disable it
in `.wslconfig`). `http://localhost` counts as a secure context in browsers, so notifications and
clipboard access work without HTTPS or a certificate.

### Run it as a service

Once the foreground run works, stop it with Ctrl-C **before** installing the service. A second
server on the same port does not start; under systemd it fails, restarts, fails again, and the
journal shows `Is port 8090 in use?` on every attempt.

```sh
DEV3_TELEMETRY=off dev3 remote install-service --no-start --no-tunnel --host 127.0.0.1 --port 8090
sudo loginctl enable-linger $USER   # start with the distro, not with your first shell
systemctl --user edit dev3-remote.service
```

`install-service` writes `DEV3_TELEMETRY=off` from your shell into the unit and prints it under
"Carried from this shell into the unit". `--no-start` keeps the service stopped until the drop-in
below exists.

Put this in the drop-in that `systemctl --user edit` opens:

```ini
[Service]
KillMode=process
```

then `systemctl --user start dev3-remote`. `KillMode=process` keeps running agents alive when the
service restarts; it is safe here only because this setup runs `--no-tunnel` (why:
[Keep agents alive across restarts](remote-access.md#run-it-as-a-service-linux)). It also means
stopping the service no longer stops the agents; that section shows how to take them down too.
Edit the drop-in, not the unit: `install-service` rewrites the unit on every run.

WSL may stop the whole distro, systemd services included, shortly after its last terminal closes,
which takes dev3 and every agent with it; and nothing starts the distro when Windows boots. If
that happens on your machine, keep a WSL terminal open while agents run, or look at the idle
settings in Microsoft's `.wslconfig` documentation for your WSL version.

### Claude Code: one login per project

To run each project under its own Claude Code config dir (and so its own account), pin it in the
project's `.dev3/config.local.json`, which stays out of git:

```json
{ "env": { "CLAUDE_CONFIG_DIR": "/home/you/.claude-acme" } }
```

Keep that dir **outside the repo**. Claude Code stores the account's login token
(`.credentials.json`, plain text on Linux), its settings and every session transcript there, so a
dir inside the project tree is one `git add -A` away from publishing the token, and on a Windows
drive (`/mnt/...`) its file permissions are not enforced either.

Two things break this:

- **A dev3 managed account.** Once any account exists in dev3's account switcher, dev3 sets
  `CLAUDE_CONFIG_DIR` for every Claude session it launches, to the active account's dir, or unsets
  it when the system login is selected. Either way the project's pin is lost. Pin per project, or
  use managed accounts, not both.
- **`CLAUDE_PROJECT_DIR` inside a task is the worktree**, not the project's main checkout. A
  settings file that references `$CLAUDE_PROJECT_DIR/.claude/...` (hooks, a status line) points
  into the worktree in a task, which has only what git tracks. Keep such files tracked, or
  reference them by absolute path.

## Linux

The fastest way to run dev-3.0 on a Linux box (cloud VM, dev server, headless host) is the
`dev3` CLI over Homebrew. **Two commands, then `dev3 remote`** — it prints an access URL + QR
you open from your laptop. `tmux`, `git`, and `cloudflared` come along as brew dependencies.

> ⚠️ **Don't run the Homebrew installer as `root`** — it refuses by design. On a fresh VM,
> create a regular user first: `useradd -m -s /bin/bash dev3 && su - dev3`.
> Glibc ≥ 2.28 required (Ubuntu 18.04+, Debian 10+, RHEL 8+).

**1. Install Homebrew** (one-time). Pick the line matching your shell — the only difference is
which rc file gets the PATH:

<details open>
<summary><strong>bash</strong></summary>

```bash
curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash && \
  echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.bashrc && \
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

</details>

<details>
<summary><strong>zsh</strong></summary>

```zsh
curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash && \
  echo 'eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"' >> ~/.zshrc && \
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
```

</details>

**2. Install dev-3.0** (same tap as macOS):

```sh
brew tap h0x91b/dev3 && brew trust h0x91b/dev3 && brew install h0x91b/dev3/dev3
```

**3. Go remote:**

```sh
dev3 remote
```

That's it. Full Homebrew-on-Linux docs: https://docs.brew.sh/Homebrew-on-Linux

### What the `dev3` CLI gives you

- **Headless / browser UI** — `dev3 remote` serves the full UI to any browser, including your
  phone. See [Remote access](remote-access.md) for the tunnel, service, and session details.
- **Desktop GUI** — `dev3 gui` launches the full Electrobun desktop app. On the first run it
  lazily downloads the bundle (~88 MB) into `~/.dev3.0/gui/` and registers an XDG menu entry.
  If your distro is missing GTK/WebKit libraries it prints the exact `apt`/`dnf`/`pacman`
  command for you to copy.
- **CLI tooling** — `dev3 task …`, `dev3 current`, `dev3 note add …` etc. when you want to
  script the Kanban board from a terminal.

Local diagnostic logs are retained for 14 days and redact prompt-bearing payloads and command
arguments. See [Local diagnostic logs](diagnostic-logs.md) for the retention and payload policy.

### Pre-built CLI tarball (no Homebrew)

If you don't want Homebrew at all (e.g. running inside a minimal container), grab the CLI
tarball directly:

```sh
# Auto-pick your arch: x64 (Intel/AMD, e.g. Hetzner CPX/CCX) or arm64 (Ampere/Graviton, e.g. Hetzner CAX)
case "$(uname -m)" in aarch64|arm64) A=arm64;; *) A=x64;; esac
curl -fsSL -o /tmp/dev3.tar.gz \
  "https://github.com/h0x91b/dev-3.0/releases/latest/download/dev3-cli-linux-$A.tar.gz"

mkdir -p ~/.dev3 && tar -C ~/.dev3 -xzf /tmp/dev3.tar.gz
~/.dev3/dev3 remote
# (optional) put it on PATH: echo 'export PATH=$HOME/.dev3:$PATH' >> ~/.bashrc
```

Make sure `tmux` (see below — the version matters), `git`, and `cloudflared` are installed (for
`cloudflared` see [Cloudflare's docs](https://github.com/cloudflare/cloudflared#installing-cloudflared)).
Without `cloudflared` `dev3 remote` still works — it just falls back to LAN + SSH-forward URLs
(or pass `--no-tunnel` to skip the check).

## tmux on Linux — the version matters

Unlike macOS builds (which bundle a self-contained tmux 3.6a inside the app and CLI tarball),
**Linux artifacts do not ship tmux — you bring your own**. The Homebrew formula still installs
the pinned `h0x91b/dev3/tmux@3.6` keg automatically; tarball installs rely on the system tmux.

The pinned, tested version is **3.6a**. Any 3.3–3.6 works; **avoid the 3.7.x line** — its client
busy-spins at 100% CPU on a congested server socket and freezes the UI (the whole reason for the
pin). Check what you have: `tmux -V`.

Current stable distro repos still ship pre-3.7 versions, so the stock package is fine:

```sh
sudo apt-get update && sudo apt-get install -y tmux   # Debian / Ubuntu
sudo dnf install -y tmux                              # Fedora / RHEL 9+ / Alma / Rocky
sudo yum install -y tmux                              # RHEL 8 / CentOS 8
sudo zypper install -y tmux                           # openSUSE
sudo pacman -S --noconfirm tmux                       # Arch (rolling — check `tmux -V`, may already be 3.7!)
sudo apk add tmux                                     # Alpine
```

If your distro already ships 3.7.x (rolling releases), install exactly 3.6a instead — either via
Homebrew on Linux (`brew install h0x91b/dev3/tmux@3.6`; the app prefers the keg automatically) or
from source:

```sh
sudo apt-get install -y build-essential libevent-dev libncurses-dev bison   # Debian/Ubuntu deps
# sudo dnf install -y gcc make libevent-devel ncurses-devel bison           # Fedora/RHEL deps
curl -fsSL https://github.com/tmux/tmux/releases/download/3.6a/tmux-3.6a.tar.gz | tar xz
cd tmux-3.6a && ./configure && make -j"$(nproc)" && sudo make install
```

`dev3 doctor` flags a 3.7.x tmux with a warning, and the app logs it at startup.

## Cloud VM caveats

- **IPv4 outbound** is required — GitHub has no AAAA records, and DNS64/NAT64 on IPv6-only cloud
  VMs is unreliable. On Hetzner Cloud, add a Primary IPv4 (~€0.49/mo) when creating the VM.
- **2 GB VMs** work fine for the brew/tarball install (no build needed). If you ever build from
  source on one, add 4 GB swap first — vite OOMs on the first build:
  ```bash
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ```

## Build from source

```bash
apt-get install -y git tmux bash ca-certificates curl unzip
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc

git clone https://github.com/h0x91b/dev-3.0.git && cd dev-3.0
bun install --frozen-lockfile
bun scripts/generate-build-info.ts
bun scripts/generate-changelog.ts
bun --bun ./node_modules/vite/bin/vite.js build   # `bun --bun` avoids Node OOM
bun build src/cli/main.ts --compile --outfile dist/dev3

./dist/dev3 remote
```

For day-to-day development on the repo, see [AGENTS.md](../AGENTS.md).
