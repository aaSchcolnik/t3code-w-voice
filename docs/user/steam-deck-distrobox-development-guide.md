# Steam Deck remote development with T3 Code, Distrobox, Tailscale, and VS Code

Last reviewed: July 22, 2026

This guide turns a Steam Deck into a remote development machine while keeping:

- SteamOS responsible for SSH, Tailscale, and the physical desktop.
- The Arch Distrobox responsible for development tools, repositories, AI providers, and T3 Code.
- The Mac responsible for the T3 Code desktop UI, VS Code UI, and browser-based testing.

It is tailored to `contentsnare-client` and `contentsnare-api`.

## Existing setup assumed by this guide

The Steam Deck already has:

- Working OpenSSH access to the `deck` user on SteamOS.
- A working Arch Distrobox.
- `mise`, Git, GitHub CLI, and the required AI-provider CLIs inside the Distrobox.
- Provider authentication completed inside the Distrobox.

This guide does not move provider authentication to SteamOS.

## Recommended architecture

```text
Mac
├── T3 Code desktop app
│   └── HTTPS/WSS → Tailscale Serve URL
├── VS Code desktop
│   └── Remote SSH → SteamOS → shared /home/deck files
└── Browser
    └── app.lvh.me:4200
        lvh.me:3000
        lvh.me:8080
           │
           └── SSH local forwards over Tailscale

Steam Deck / SteamOS
├── OpenSSH server
├── Tailscale daemon and MagicDNS identity
├── Tailscale Serve → 127.0.0.1:3773
├── VS Code remote server under /home/deck
└── Distrobox runtime

Arch Distrobox
├── T3 server on 127.0.0.1:3773
├── Codex, Claude, Cursor, OpenCode, and other providers
├── ~/code/contentsnare-client
├── ~/code/contentsnare-api
├── Angular development server
├── Rails, Sidekiq, and AnyCable
└── Node, Ruby, Postgres, Redis, and other development dependencies
```

This deliberately avoids three problematic arrangements:

1. Installing the development toolchain into SteamOS's read-only system image.
2. Running T3 on SteamOS while its providers and toolchain live inside Distrobox.
3. Exposing development ports directly to the LAN or public internet.

## Values used throughout the guide

Determine these values before continuing:

| Placeholder        | Example                           | How to find it                                                       |
| ------------------ | --------------------------------- | -------------------------------------------------------------------- |
| `<BOX>`            | `arch`                            | Run `distrobox list` on SteamOS                                      |
| `<DECK_USER>`      | `deck`                            | Run `whoami` on SteamOS                                              |
| `<TAILSCALE_FQDN>` | `steamdeck-devbox.example.ts.net` | Run `tailscale status --json` or inspect the Tailscale Machines page |
| `<SSH_KEY>`        | `~/.ssh/id_ed25519`               | Use the key already configured for the Deck                          |
| `<CODE_ROOT>`      | `/home/deck/code`                 | Choose a directory under the shared home directory                   |

Replace placeholders in commands. Do not type the angle brackets literally.

The Tailscale device name becomes part of the HTTPS URL. Rename the machine to something stable such as
`steamdeck-devbox` in the Tailscale admin console before pairing T3 if that is the name desired in the URL.

## Phase 1: install Tailscale on SteamOS

### Why Tailscale belongs on SteamOS

Tailscale is machine-level networking. Installing its daemon on SteamOS makes it available:

- Before the Distrobox is entered.
- In both Gaming Mode and Desktop Mode.
- To OpenSSH, T3, VS Code, and an optional remote-desktop server.

Do not install a second independent Tailscale daemon inside Distrobox. Two separate Tailscale nodes on the same
physical Deck create unnecessary routing and lifecycle complexity.

SteamOS has an image-based, read-only system. The ordinary Arch `pacman` installation is therefore not the right
installation path. Tailscale's Linux installer redirects SteamOS users to the
[`tailscale-dev/deck-tailscale`](https://github.com/tailscale-dev/deck-tailscale) installer.

### Install on the Deck

Run these commands through the existing SteamOS SSH connection:

```bash
git clone https://github.com/tailscale-dev/deck-tailscale.git ~/deck-tailscale
sudo -i
cd /home/deck/deck-tailscale
bash tailscale.sh
source /etc/profile.d/tailscale.sh
tailscale up --qr --operator=deck
exit
```

Scan the QR code or open the authentication link and add the Deck to the same tailnet as the Mac.

The upstream installer suggests adding `--ssh`. That enables Tailscale SSH. It is intentionally omitted here because
OpenSSH is already configured and is needed by VS Code. Maintaining one known SSH authentication path is simpler.
Tailscale still secures the network path to the existing OpenSSH server.

Verify:

```bash
tailscale status
tailscale ip -4
systemctl status tailscaled --no-pager
```

If `tailscale` is not in `PATH` in a new shell:

```bash
source /etc/profile.d/tailscale.sh
```

The Deck installer places the binaries under `/opt/tailscale/` and enables the daemon at boot.

### Install Tailscale on the Mac

Install the official macOS Tailscale app and sign in to the same tailnet.

Verify from the Mac:

```bash
tailscale status
ping <TAILSCALE_FQDN>
ssh <DECK_USER>@<TAILSCALE_FQDN>
```

If the FQDN does not resolve, enable MagicDNS in the Tailscale admin console. MagicDNS generates a DNS name for each
tailnet device.

### Optional key-expiry decision

For unattended access, Tailscale allows key expiry to be disabled for a machine from the Machines page.

Tradeoff:

- Enabled expiry is safer if the Deck is lost or stolen.
- Disabled expiry avoids a remote machine becoming unreachable until it is reauthenticated.

Do not disable expiry automatically. Make the choice based on the physical security of the Deck.

## Phase 2: let Distrobox use the host Tailscale CLI

T3 runs inside Distrobox, but `tailscaled` runs on SteamOS. T3's `--tailscale-serve` integration executes:

```text
tailscale status --json
tailscale serve --bg --https=443 http://127.0.0.1:<t3-port>
```

Create a container-local `tailscale` wrapper that delegates those commands to SteamOS.

Enter the Distrobox:

```bash
distrobox enter --name <BOX>
```

Verify that `distrobox-host-exec` exists:

```bash
command -v distrobox-host-exec
```

Create the wrapper inside the Distrobox:

```bash
sudo install -d -m 755 /usr/local/bin
sudo tee /usr/local/bin/tailscale >/dev/null <<'EOF'
#!/bin/sh
exec distrobox-host-exec /opt/tailscale/tailscale "$@"
EOF
sudo chmod 755 /usr/local/bin/tailscale
```

Test from inside Distrobox:

```bash
command -v tailscale
tailscale status
tailscale status --json
```

If `/opt/tailscale/tailscale` does not exist on SteamOS, run `command -v tailscale` on SteamOS and substitute that
absolute path in the wrapper.

This arrangement also relies on Distrobox's normal shared network namespace, so container loopback and host loopback
refer to the same network stack. The default Distrobox configuration behaves this way. If this particular box was
created with `--unshare-netns` or `--unshare-all`, do not continue with the loopback design until networking is
reconfigured.

## Phase 3: prepare Node and install the T3 CLI

The Deck needs the headless `t3` CLI/server, not the T3 desktop application. The desktop application remains on the
Mac.

`contentsnare-client` currently requires:

```text
Node >=24.15.0
npm >=11.12.0
```

Its `.tool-versions` pins Node `24.15.0`. That version also satisfies T3's current Node requirement.

Inside Distrobox:

```bash
mise install node@24.15.0
mise use --global node@24.15.0
node --version
npm --version
```

Expected minimums:

```text
v24.15.0
11.12.0
```

Install T3 under the mise-managed Node installation:

```bash
npm install --global t3@latest
t3 --version
```

A global T3 installation is not strictly required—`npx t3@latest` also works—but it is preferable for a persistent
service because startup does not depend on resolving and installing the package.

Verify that the provider executables remain visible in the same shell:

```bash
command -v codex
command -v claude
command -v cursor-agent
command -v opencode
```

Only check providers actually used. If a provider is missing here but appears in a different interactive shell, fix
the Distrobox shell's `PATH` before continuing. T3 inherits the environment from the shell that launches it.

## Phase 4: run T3 manually and pair the Mac

Always prove the manual flow before creating an automatic service.

Inside Distrobox:

```bash
t3 serve \
  --host 127.0.0.1 \
  --port 3773 \
  --tailscale-serve
```

This should:

1. Start T3 on Deck loopback.
2. Ask the host Tailscale CLI to configure HTTPS Serve.
3. Print a pairing token, pairing URL, and QR code.
4. Advertise an HTTPS URL resembling:

```text
https://<TAILSCALE_FQDN>/
```

Tailscale Serve may print a one-time authorization URL if HTTPS certificates or Serve have not been enabled for the
tailnet. Open that URL and approve the feature. Serve makes the endpoint available only within the tailnet; do not
enable Tailscale Funnel.

Port 443 can serve one Tailscale Serve target at a time. If the Deck already uses Serve on 443 for another
application, use a dedicated HTTPS port:

```bash
t3 serve \
  --host 127.0.0.1 \
  --port 3773 \
  --tailscale-serve \
  --tailscale-serve-port 8443
```

The T3 URL would then be `https://<TAILSCALE_FQDN>:8443/`. Use the same port in the automatic service if this option
is selected.

In a second Distrobox shell, verify:

```bash
tailscale serve status
curl http://127.0.0.1:3773/.well-known/t3/environment
```

From the Mac, verify:

```bash
curl https://<TAILSCALE_FQDN>/.well-known/t3/environment
```

### Pair the T3 desktop app

In the T3 Code desktop app on the Mac:

1. Open **Settings → Connections**.
2. Under **Remote Environments**, choose **Add environment**.
3. Choose the direct/pairing URL flow, not desktop-managed SSH launch.
4. Enter the full pairing URL printed by `t3 serve`, or enter:
   - Host: `https://<TAILSCALE_FQDN>/`
   - Token: the printed one-time pairing token
5. Save the environment with a clear name such as `Steam Deck Devbox`.

The Mac app now connects directly to the T3 server through Tailscale HTTPS/WSS. T3 traffic is not relayed through a
T3-hosted service.

Treat pairing URLs and tokens as passwords. Create a new token if one is exposed:

```bash
t3 auth pairing create --json
```

## Phase 5: optionally start T3 automatically

Do this only after manual pairing and provider detection work.

The service runs under SteamOS's user-level systemd and enters Distrobox noninteractively.

On SteamOS, first find the Distrobox executable:

```bash
command -v distrobox
```

The example assumes `/usr/bin/distrobox`. Substitute the actual path if different.

Before creating the service, verify the exact noninteractive environment it will use:

```bash
distrobox enter --name <BOX> --no-tty -- /bin/bash -lc '
  command -v node
  command -v t3
  command -v tailscale
  tailscale status >/dev/null
'
```

All commands must succeed.

Create the service:

```bash
mkdir -p ~/.config/systemd/user
nano ~/.config/systemd/user/t3code-devbox.service
```

Use:

```ini
[Unit]
Description=T3 Code server in the Arch Distrobox
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStartPre=/usr/bin/distrobox enter --name <BOX> --no-tty -- /bin/bash -lc 'for attempt in {1..30}; do tailscale status >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1'
ExecStart=/usr/bin/distrobox enter --name <BOX> --no-tty -- /bin/bash -lc 'exec t3 serve --host 127.0.0.1 --port 3773 --tailscale-serve'
Restart=on-failure
RestartSec=5
TimeoutStartSec=90

[Install]
WantedBy=default.target
```

Replace both `<BOX>` occurrences before saving. If using Tailscale Serve port 8443, append
`--tailscale-serve-port 8443` to `ExecStart`.

Enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now t3code-devbox.service
systemctl --user status t3code-devbox.service --no-pager
```

Inspect logs:

```bash
journalctl --user -u t3code-devbox.service -n 100 --no-pager
journalctl --user -u t3code-devbox.service -f
```

If it must start before the `deck` user logs in graphically:

```bash
sudo loginctl enable-linger deck
```

Linger keeps the user's systemd manager alive without a graphical login. It also means background development
services can continue consuming power. Use it only if unattended startup is genuinely useful.

To disable automatic T3 startup:

```bash
systemctl --user disable --now t3code-devbox.service
```

## Phase 6: clone and register the Content Snare repositories

Inside Distrobox:

```bash
mkdir -p <CODE_ROOT>
cd <CODE_ROOT>
gh repo clone akturatech/contentsnare-client
gh repo clone akturatech/contentsnare-api
```

If they are already present on the Deck, do not clone a second copy. Use the existing paths.

### Client baseline

```bash
cd <CODE_ROOT>/contentsnare-client
mise install
node --version
npm --version
npm ci
```

### API baseline

The API currently pins Ruby `3.4.9` and requires Postgres, Redis, Rails dependencies, and private Bundler credentials.
Follow its repository README and team credential process:

```bash
cd <CODE_ROOT>/contentsnare-api
cat .ruby-version
```

Do not copy secrets into this guide, T3 configuration, shell history, or Git.

The API can run natively inside Distrobox or through its Docker Compose setup. Choose one method and keep it
consistent with the team's normal workflow:

- Native Distrobox services provide the simplest process and filesystem model.
- Docker Compose provides the repository's pinned service topology but requires a working container engine from
  inside Distrobox.

Do not combine half of the API stack from SteamOS with half from Distrobox.

### Register projects with T3

T3's GUI does not currently add projects to remote environments. Run:

```bash
t3 project add <CODE_ROOT>/contentsnare-client --title "Content Snare Client"
t3 project add <CODE_ROOT>/contentsnare-api --title "Content Snare API"
```

The projects should then appear under the `Steam Deck Devbox` environment in the Mac T3 app.

## Phase 7: use VS Code on the Mac without code-server

VS Code Remote SSH is the recommended editor arrangement. It uses the native Mac VS Code interface while files,
extensions, searches, and Git operations target the remote machine.

Distrobox shares `/home/deck` with SteamOS. Consequently:

- T3 edits `<CODE_ROOT>/contentsnare-client` inside Distrobox.
- VS Code opens the same path through SteamOS SSH.
- Changes appear immediately; there is no synchronization or shared-session mechanism.
- `code-server` is unnecessary.

### Configure SSH over Tailscale

Add these aliases to `~/.ssh/config` on the Mac:

```sshconfig
Host steamdeck
    HostName <TAILSCALE_FQDN>
    User <DECK_USER>
    IdentityFile <SSH_KEY>
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
    RequestTTY force
    RemoteCommand /usr/bin/distrobox enter --name <BOX>

Host steamdeck-host steamdeck-code
    HostName <TAILSCALE_FQDN>
    User <DECK_USER>
    IdentityFile <SSH_KEY>
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

Replace `<BOX>` and use the SteamOS path returned by `command -v distrobox` if it is not `/usr/bin/distrobox`.

Verify:

```bash
# Interactive convenience: enters Distrobox automatically.
ssh steamdeck

# Raw SteamOS recovery/administration session.
ssh steamdeck-host

# Raw alias reserved for VS Code Remote SSH.
ssh steamdeck-code
```

The `steamdeck` alias fulfills the convenience goal of entering Distrobox with a plain `ssh steamdeck`. Its
`RemoteCommand` makes it unsuitable for `scp`, `rsync`, VS Code Remote SSH, and commands such as
`ssh steamdeck 'command'`; use `steamdeck-host` or `steamdeck-code` for those operations.

This does not interfere with T3 because this guide connects T3 through its Tailscale HTTPS URL rather than
desktop-managed SSH launch.

Install Microsoft's **Remote - SSH** extension in VS Code. Then:

1. Open the Command Palette.
2. Run **Remote-SSH: Connect to Host…**.
3. Select `steamdeck-code`.
4. Open `<CODE_ROOT>/contentsnare-client`.

VS Code installs its remote server under the Deck user's home directory. It does not need to modify SteamOS's
read-only system image.

### Make VS Code terminals enter Distrobox

VS Code's files can be accessed through SteamOS, but development commands should run inside Distrobox.

The simplest method is:

```bash
distrobox enter --name <BOX>
```

in each new VS Code terminal.

Optionally configure a remote terminal profile in VS Code's remote settings:

```json
{
  "terminal.integrated.profiles.linux": {
    "Arch Distrobox": {
      "path": "/usr/bin/distrobox",
      "args": ["enter", "--name", "<BOX>"]
    }
  },
  "terminal.integrated.defaultProfile.linux": "Arch Distrobox"
}
```

Replace `<BOX>` and confirm the Distrobox executable path on SteamOS.

This split is acceptable for reading and editing: VS Code owns the editor process on SteamOS, while terminals and T3
own execution inside Distrobox. If a VS Code extension requires the project runtime and fails to find Node, make the
existing mise installation available in the SteamOS user `PATH`, or use VS Code's **Attach to Running Container**
workflow as an advanced alternative. Do not install Node with SteamOS `pacman` solely for VS Code.

## Phase 8: test Content Snare in the Mac browser

Jump Desktop is not needed for normal UI testing.

The Content Snare development environment currently uses:

| Service              | Remote URL expected by the code | Port |
| -------------------- | ------------------------------- | ---: |
| Angular client       | `http://app.lvh.me:4200`        | 4200 |
| Rails API            | `http://lvh.me:3000`            | 3000 |
| AnyCable WebSocket   | `ws://lvh.me:8080/cable`        | 8080 |
| Optional Rails HTTPS | `https://lvh.me:3001`           | 3001 |

`lvh.me` and its subdomains resolve to `127.0.0.1`. When the browser runs on the Mac, these names therefore point to
the Mac. SSH local forwarding maps those Mac loopback ports to the same loopback ports on the Deck.

This preserves the application's existing domains, cookies, CORS behavior, and WebSocket URL without source changes.

### Create a dedicated port-forwarding SSH alias

Add this second alias to `~/.ssh/config` on the Mac:

```sshconfig
Host steamdeck-content-snare
    HostName <TAILSCALE_FQDN>
    User <DECK_USER>
    IdentityFile <SSH_KEY>
    IdentitiesOnly yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
    ExitOnForwardFailure yes
    LocalForward 127.0.0.1:4200 127.0.0.1:4200
    LocalForward 127.0.0.1:3000 127.0.0.1:3000
    LocalForward 127.0.0.1:3001 127.0.0.1:3001
    LocalForward 127.0.0.1:8080 127.0.0.1:8080
```

Start the tunnel in a dedicated Mac terminal:

```bash
ssh -N steamdeck-content-snare
```

Leave it running while testing. The transport goes to the Deck's private MagicDNS address through Tailscale.

If a Mac process already occupies one of those ports, stop it first. Using different local port numbers would require
changing Content Snare's hard-coded development URLs, defeating the purpose of this arrangement.

### Start the API on the Deck

Inside Distrobox:

```bash
cd <CODE_ROOT>/contentsnare-api
foreman start
```

The current `Procfile` starts:

- Rails on port 3000.
- Sidekiq.
- AnyCable on port 8080.

Use the repository's documented alternatives when debugging a single process.

### Start the Angular client on the Deck

In another Distrobox terminal:

```bash
cd <CODE_ROOT>/contentsnare-client
export NODE_OPTIONS=--max-old-space-size=4096
npx ng serve \
  --no-hmr \
  --host=app.lvh.me \
  --configuration=development \
  --verbose
```

This is equivalent to the repository's `start-loc` workflow without asking the Deck to open a browser.

### Open the UI on the Mac

Open:

```text
http://app.lvh.me:4200
```

The complete request path is:

```text
Mac browser
  → Mac 127.0.0.1:4200
  → SSH tunnel over Tailscale
  → Deck 127.0.0.1:4200
  → Angular server inside Distrobox
```

API and WebSocket requests follow the same path through ports 3000 and 8080.

Live reload and browser developer tools remain on the Mac. Code compilation and application processes remain on the
Deck.

### Verify ports when something is unreachable

Inside Distrobox:

```bash
ss -ltn | grep -E ':(3000|3001|4200|8080)\b'
```

On the Mac while the tunnel is active:

```bash
curl -I http://app.lvh.me:4200
curl -I http://lvh.me:3000
```

For WebSocket failures, confirm port 8080 is listening and inspect the browser Network panel.

### Automated browser tests

Playwright can run on the Deck inside Distrobox:

```bash
cd <CODE_ROOT>/contentsnare-client
npm run e2e:isolated -- <spec-id>
```

Install Playwright's Linux browser/dependencies inside Distrobox if the repository setup has not already done so.
Do not install those dependencies into SteamOS.

Manual visual verification should normally use the Mac browser over the SSH tunnel. This gives a full desktop browser,
developer tools, screenshots, and network inspection without streaming the Deck desktop.

## Phase 9: Jump Desktop is optional

Do not install Jump Desktop inside Distrobox.

Jump Desktop's current download page provides Jump Desktop Connect for macOS and Windows, not Linux. Its documented
Linux path is to manually configure a VNC connection. A VNC server must therefore run on SteamOS because SteamOS owns
the KDE desktop session and physical display.

Jump Desktop is useful only for tasks such as:

- Interacting with a GUI application that exists only on the Deck.
- Resolving a graphical authentication or desktop-session problem.
- Inspecting behavior that depends specifically on the Deck display.

It is not needed for:

- T3 Code.
- VS Code.
- Terminal access.
- Angular/Rails development.
- Testing the UI in a Mac browser.

If remote desktop is added later:

1. Install and configure a VNC-compatible server on SteamOS, not Distrobox.
2. Bind or firewall it so it is reachable only through Tailscale.
3. Add a manual VNC connection in Jump Desktop using `<TAILSCALE_FQDN>`.
4. Never expose VNC port 5900 directly to the public internet.

Evaluate the VNC server against the Deck's current KDE/Wayland session before installation. Sunshine on SteamOS with
Moonlight on the Mac is another option when low-latency desktop or game streaming matters more than Jump Desktop
compatibility.

The Deck must be awake for T3, SSH, VS Code, Tailscale Serve, or remote desktop to work. Tailscale does not prevent
system suspension. When using the Deck as a development server, keep it powered and configure an appropriate
sleep policy.

## Daily workflow

After the one-time setup:

1. Keep the Deck powered and awake.
2. Confirm Tailscale:

   ```bash
   tailscale status
   ```

3. Confirm T3:

   ```bash
   systemctl --user status t3code-devbox.service --no-pager
   ```

4. Open T3 Code on the Mac and select `Steam Deck Devbox`.
5. Open VS Code and connect to `steamdeck-code`.
6. Start the Content Snare port tunnel:

   ```bash
   ssh -N steamdeck-content-snare
   ```

7. Start `foreman start` in the API repository inside Distrobox.
8. Start the Angular development server inside Distrobox.
9. Open `http://app.lvh.me:4200` in the Mac browser.
10. Read and edit the same files from Mac VS Code while T3 changes them on the Deck.

## Troubleshooting

### T3 URL does not respond

Check each layer in order.

On SteamOS:

```bash
tailscale status
systemctl status tailscaled --no-pager
```

Inside Distrobox:

```bash
tailscale status --json
curl http://127.0.0.1:3773/.well-known/t3/environment
tailscale serve status
```

On the Mac:

```bash
tailscale status
curl https://<TAILSCALE_FQDN>/.well-known/t3/environment
```

If loopback works but HTTPS does not, the problem is Tailscale Serve, HTTPS authorization, MagicDNS, or tailnet access
rules—not T3.

### T3 starts but providers are missing

Inside the same noninteractive environment used by the service:

```bash
distrobox enter --name <BOX> --no-tty -- /bin/bash -lc '
  printf "PATH=%s\n" "$PATH"
  command -v node
  command -v t3
  command -v codex
  command -v claude
  command -v cursor-agent
  command -v opencode
'
```

Fix shell or mise activation until the expected providers appear there. A provider available only after manually
running shell initialization will not be available to the automatic service.

### T3 pairing token was lost

Inside Distrobox:

```bash
t3 auth pairing create --json
```

Use the new one-time credential in the Mac app.

### VS Code edits files but terminal commands run on SteamOS

Enter Distrobox:

```bash
distrobox enter --name <BOX>
```

Or configure the Distrobox terminal profile from Phase 7.

### `app.lvh.me` opens the wrong machine

That hostname always resolves to loopback on the machine running the browser. Confirm the SSH tunnel is active on the
Mac:

```bash
ssh -v -N steamdeck-content-snare
```

Do not replace `app.lvh.me` with the Tailscale hostname unless the application's domain, cookie, CORS, and WebSocket
configuration is deliberately redesigned.

### A SteamOS update affects Tailscale

Update the Deck installer and rerun it from the normal OpenSSH connection:

```bash
cd ~/deck-tailscale
git pull
sudo bash tailscale.sh
```

Then verify `tailscale status` and the T3 Serve URL. The installer warns that updates should not be performed through
Tailscale SSH; this guide keeps normal OpenSSH available for that reason.

### The Deck is visible in Tailscale but unreachable

Check:

- The Deck is awake.
- Wi-Fi is connected.
- `tailscaled` is running.
- Tailnet ACLs permit the Mac to reach the Deck.
- OpenSSH is running when using VS Code or port forwarding.
- The device key has not expired.

## Security checklist

- Keep T3 bound to `127.0.0.1`; let Tailscale Serve provide remote HTTPS.
- Use Tailscale Serve, not Funnel.
- Restrict tailnet access to trusted users and devices.
- Keep SSH key authentication enabled.
- Do not expose Rails, Angular, AnyCable, VNC, or T3 directly to the public internet.
- Treat T3 pairing URLs and tokens as secrets.
- Keep repositories and provider credentials under the intended Deck user.
- Remember that Distrobox shares the Deck home directory and is not a security sandbox.
- Revoke the Deck in Tailscale immediately if it is lost.

## Source references

- [T3 Code remote access and Tailscale Serve](./remote-access.md)
- [T3 Code Codex provider configuration](../providers/codex.md)
- [Tailscale Steam Deck installer](https://github.com/tailscale-dev/deck-tailscale)
- [Tailscale Linux installation and verification](https://tailscale.com/docs/install/linux)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale MagicDNS](https://tailscale.com/docs/features/magicdns)
- [Distrobox host command execution](https://distrobox.it/usage/distrobox-host-exec/)
- [Distrobox container networking options](https://distrobox.it/usage/distrobox-create/)
- [VS Code Remote SSH and port forwarding](https://code.visualstudio.com/docs/remote/ssh)
- [Jump Desktop Connect downloads](https://support.jumpdesktop.com/hc/en-us/articles/39544705175181-Download-Jump-Desktop-Connect)
- [Jump Desktop Linux compatibility](https://support.jumpdesktop.com/hc/en-us/articles/216426043-General-Is-Jump-Desktop-compatible-with-Linux)
- [Valve Steam Deck immutable-filesystem guidance](https://partner.steamgames.com/doc/steamdeck/faq?language=english)
- [`contentsnare-client` runtime and scripts](../../../contentsnare-client/package.json)
- [`contentsnare-client` local environment URLs](../../../contentsnare-client/src/environments/environment.ts)
- [`contentsnare-api` development instructions](../../../contentsnare-api/README.md)
- [`contentsnare-api` development processes](../../../contentsnare-api/Procfile)
