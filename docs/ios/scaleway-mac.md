# Scaleway Mac mini as an iOS worker

Scaleway rents Apple Silicon Mac minis by the hour. This page rents one, sets it up as a Tapdance
worker, joins it to a gateway on your Linux VPS, and deletes it when you are done.

Status: **not tested.** No step on this page has been run against a real Scaleway Mac by the Tapdance
maintainers. The Tapdance steps are the same ones verified locally on one Mac
([evidence](../testing/evidence/2026-11-01-local-ios.md)); the VPS-to-Mac path is untested
([STATUS.md](../../STATUS.md), Q-08 and G-06). Provider facts below come from Scaleway's documentation
and pricing pages as read on 2026-11-01. Check them again before you rent.

## Costs and terms (November 2026 estimates)

| Item | What Scaleway states | Source |
| --- | --- | --- |
| Machine | Mac mini M2, 8-core CPU, 10-core GPU, 16 GB RAM, 256 GB SSD | [Apple silicon pricing](https://www.scaleway.com/en/pricing/apple-silicon/) |
| Price | About €0.17 per hour, or €115 per month, before VAT | same |
| Minimum rental | **24 hours.** You cannot delete a Mac mini running macOS until 24 hours after its lease starts. Scaleway attributes this to Apple's macOS license. | [Apple silicon FAQ](https://www.scaleway.com/en/docs/apple-silicon/faq/) |
| Billing | Billed for as long as the Mac mini is assigned to your account, **including while it is powered off**. Only deletion stops billing. | same |
| Smallest bill | At about €0.17/h, the 24-hour minimum is roughly €4 before VAT. | arithmetic |
| Commitment plans | Optional discounted commitment plans. Deleting a committed machine takes effect only on the commitment's anniversary date. | [Quickstart](https://www.scaleway.com/en/docs/apple-silicon/quickstart/) |
| Zone | The M2 is offered in PARIS 1 (`fr-par-1`) per the quickstart. | same |
| Auto-delete | The console offers automatic deletion after 24 hours. | FAQ |

Prices, models and zones change. Read Scaleway's pricing page on the day you rent.

On disk: 256 GB holds Xcode, one or two iOS runtimes (each needs about 8 GiB free to install) and a
few simulators. If you plan to keep several runtimes, check free space with `df -h` as you go.

## 1. Rent the Mac mini

In the Scaleway console, go to **Bare Metal > Apple silicon > Create Mac mini**, then:

1. Choose the **Standard** setup and the zone that offers the M2.
2. Choose macOS. Scaleway notes that a non-default macOS version can take about an hour longer to
   install. Pick a macOS version that runs the Xcode you need.
3. Choose **No commitment** unless you know you will keep the machine.
4. Leave Private Networks off unless you already use a Scaleway VPC.
5. Read and accept the Bare Metal conditions and the macOS License Agreement.
6. Create it, and wait for the installation notice.

## 2. Connect

The Mac mini's **Overview** page in the console shows the SSH command, the user name and the VNC port.

```sh
ssh <your-mac-user>@<mac-ip>
```

For the desktop, use a VNC client with the port shown on the Overview page. Scaleway assigns the VNC
port at install time, so it may not be 5900, and it protects VNC with `fail2ban`. You need the desktop
once or twice: to sign in to the App Store if you install Xcode that way, and to check that the
simulator and screen capture work in a logged-in session.

Use SSH keys. Do not put any token or password into a shared note or a repository.

## 3. Check or install Xcode

Scaleway's FAQ says macOS images come with the latest Xcode that is compatible with the OS. Check:

```sh
xcodebuild -version
xcode-select -p
```

If Xcode is missing or is not the version you need, install it from the App Store (over VNC) or from
[developer.apple.com/download](https://developer.apple.com/download/) (Apple ID required). Then:

```sh
sudo xcode-select -s /Applications/Xcode.app
sudo xcodebuild -license accept
sudo xcodebuild -runFirstLaunch
```

## 4. Install a runtime

```sh
xcodebuild -downloadPlatform iOS
xcrun simctl list runtimes
```

Or install a specific version through Simlock after step 5: `tapdance devices install ios 18.5`.

## 5. Install Tapdance and the worker

Install Node.js 22.13 or later (from [nodejs.org](https://nodejs.org/) or Homebrew if it is present),
then install the Tapdance CLI as described in [local-mac-worker.md](local-mac-worker.md#3-install-tapdance-and-check-the-mac).

```sh
tapdance worker check
tapdance worker install --service
```

Keep the default iOS backend (agent-device). AXe does not work with a remote agent.

Keep the machine awake. A rented Mac mini is a desktop, so turn off system sleep:

```sh
sudo pmset -a sleep 0
```

`--service` installs a launchd login service. It runs while your user is logged in. If you reboot the
Mac, log in again over VNC (or enable automatic login) so the worker starts. Whether simulator boot and
screen capture work from an SSH-only session, with nobody logged in to the desktop, has not been
tested; if they fail, log in once over VNC and leave that session running.

## 6. Join your gateway

On your Linux VPS, the gateway must already be running and reachable over TLS or Tailscale
(`tapdance gateway setup` prints the Caddy and Tailscale options). On the VPS:

```sh
tapdance gateway token --role worker --label scaleway-m2
```

Copy the printed secret. On the Mac mini:

```sh
tapdance worker login --accept-gateway-exec --gateway wss://gateway.example.com --label scaleway-m2
```

Paste the token at the prompt (or pipe it in). Then on the VPS:

```sh
tapdance workers list
tapdance devices --platform ios
```

The Mac mini has a public IPv4 address, but the worker needs no inbound port: it dials out to the
gateway. While joined, the worker's own Simlock HTTP API is off. Open nothing else.

**Security:** the gateway now has operator rights over this Mac, and any agent token on the gateway
can run commands on it as the worker's macOS user. Treat this Mac as belonging to your gateway. Do not
keep Apple signing certificates or other secrets on it unless you accept that.

## 7. Lease from the VPS

On the VPS (the machine where `tapdance gateway setup` already configured Tapdance and saved an agent
token):

```sh
tapdance doctor
tapdance device lease --platform ios --device "iPhone 16" --os 18.5
tapdance app install ./build/Build/Products/Debug-iphonesimulator/MyApp.app
tapdance app launch com.example.MyApp
tapdance ui inspect
tapdance ui tap --text "Sign in"
tapdance screenshot
tapdance device release
```

Use a device and OS version that `tapdance devices --platform ios` lists for this worker. The `.app`
must be a simulator build; see [simulator-management.md](simulator-management.md#app-vs-ipa).
Screenshots, recordings and logs land on the VPS under the artifacts directory.

From an agent, the same flow is `lease_device`, `install_app`, `launch_app`, `inspect_screen`, `tap`,
`take_screenshot` and `release_device` through `tapdance mcp`.

To watch the simulator from your laptop, see [remote-browser-access.md](remote-browser-access.md).

## 8. Stop paying: delete the server

Powering the Mac mini off does **not** stop billing. To stop charges:

1. On the VPS, release any lease (`tapdance device release`).
2. Revoke the worker's join token on the VPS: `tapdance simlock --gateway token list`, then
   `tapdance simlock --gateway token revoke <token-id>`.
3. In the Scaleway console, go to **Bare Metal > Apple silicon**, open the menu next to the Mac mini,
   choose **Delete**, type `DELETE`, and confirm. This is possible only after the 24-hour minimum, is
   irreversible, wipes all data, and takes about 30 minutes.

If deletion is refused, the 24 hours have probably not passed yet. Try again later, or turn on the
console's automatic deletion after 24 hours when you create the next one.

## Apple licensing note

The 24-hour minimum exists because of Apple's macOS Software License Agreement. Renting a Mac for your
own testing is the use Scaleway sells. Re-renting Macs to other people, or offering short shared Mac
sessions, needs its own review of the current license ([apple.com/legal/sla](https://www.apple.com/legal/sla/))
before you build anything on it.
