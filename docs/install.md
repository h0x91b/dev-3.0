# Install

Every way to get dev-3.0 onto a machine. The two fastest paths (agent-driven and Homebrew) are
in the [README quick start](../README.md#quick-start) — this page is the full reference.

- [macOS desktop app](#macos--desktop-app)
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

Apple Silicon and Intel are both supported. Windows is on the roadmap — the desktop app already
builds and starts there, but no Windows artifact is published in releases yet.

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
