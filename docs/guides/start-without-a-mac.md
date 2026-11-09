# Start without a Mac: Android on Google Cloud, iOS on a rented Mac

This walkthrough takes you from nothing to your AI agent testing your app on an Android phone and an
iPhone, with only a laptop. The phones are emulators and simulators that run on two machines in your
own cloud accounts, one for each platform:

```text
  your laptop                         a private network (Tailscale, free)
  ┌──────────────────────┐             ┌────────────────────────────────────────────┐
  │ your AI agent        │ ──────────▶ │ Google Cloud machine (yours): Android phones │
  │ + Tapdance           │ ──────────▶ │ Scaleway Mac mini (yours):    iPhones        │
  └──────────────────────┘             └────────────────────────────────────────────┘
```

You pay Google and Scaleway directly. There is no Tapdance account, and Tapdance never sees your
cloud passwords or keys: it uses the `gcloud` and `scw` tools you are logged in to. Only need Android?
Skip everything marked **iOS only**.

## What you need

- **Accounts:** [Google Cloud](https://console.cloud.google.com) with billing on, [Scaleway](https://console.scaleway.com)
  with a payment method (iOS only; it may ask to verify your identity first, so sign up a day early), and
  [Tailscale](https://login.tailscale.com) with **HTTPS Certificates** turned on (free; it gives your
  machines `https://` addresses and the live view). New words are in the [glossary](../glossary.md).
- **On your laptop (Linux or macOS):** [Node.js](https://nodejs.org) 22.13 or newer, Tailscale logged
  in, [gcloud](https://cloud.google.com/sdk/docs/install) and (iOS only)
  [scw](https://www.scaleway.com/en/docs/scaleway-cli/quickstart/), and your agent (Claude Code here).
- **Cost:** about USD 0.20 an hour for the Android machine while it runs (it switches itself off when
  idle), and EUR 2.64-5.28 a day before VAT, depending on which Mac mini is in stock, at least one day.

## Set it up once

All on your laptop. Sections 1 and 2 below have the details for the first two steps.

1. **Accounts and tools.** A Google Cloud project with billing on, a Scaleway account (iOS only) and a
   Tailscale account ([section 1](#1-create-the-accounts)). On the laptop: Tailscale logged in, Node.js
   22.13 or newer, `gcloud init` (pick your project), and for iOS `scw init` (paste an API key from the
   Scaleway console) ([section 2](#2-prepare-your-laptop)).
2. **Install Tapdance** (0.3.0 or newer: older versions have no `tapdance machine`).

   ```bash
   npm install -g tapdance-cli
   ```

3. **Create the iPhone machine (iOS only).** It shows the cost and asks first. Start it first: Scaleway
   takes a while to install macOS. Kotlin Multiplatform app, or a private repository? See
   [section 3](#3-create-the-iphone-machine-ios-only) for the options to add now. Already rented a Mac in
   the Scaleway console? `create` finds it and asks whether to use it, so you do not pay for a second
   day; `--server-id <its name or id>` picks one, `--new` rents another anyway. A Mac you bring this way
   is deleted by `tapdance machine destroy ios` later, and Tapdance leaves its deletion schedule as it
   is: without automatic deletion set in the Scaleway console, it bills until you destroy it.

   ```bash
   tapdance machine create --cloud scaleway
   ```

4. **Create the Android machine,** in a second terminal while the Mac installs. It goes in the zone
   your gcloud is set to, else `us-central1-a`; add `--zone europe-west1-b` (or one near you) to choose.

   ```bash
   tapdance machine create --cloud gcp
   ```

   Each one prints a **Tailscale link** when its setup reaches that point: open it and approve the
   machine. For Android that is about 3 minutes in; for the Mac, after macOS is installed, often an hour
   in. The command waits for you; if the link has expired by then, run the same command again for a new
   one. Android takes about 10 minutes (6 of them work in the measured run, plus your click); the Mac
   about 1 to 1½ hours: Scaleway's macOS install (about an hour in earlier runs), then 10 to 20 minutes
   of setup (8½ minutes measured on a Mac that was already installed).

5. **Let only your laptop reach the machines.** By default every machine in a tailnet can reach every
   other, and these machines run your app's code. In the Tailscale admin console, under **Access
   controls**, delete the default rule that lets every machine reach every other, then add a rule that
   lets your laptop reach the two machines on port 4720:

   ```json
   { "action": "accept", "src": ["<your laptop's 100.x address>"], "dst": ["<Android machine's 100.x address>:4720", "<Mac's 100.x address>:4720"] }
   ```

   The 100.x addresses are listed under **Machines**; use the machines `create` named (they may end in
   `-1`). If you use your tailnet for other things, add rules for those too. The
   [threat model](../security/threat-model.md) explains why.

6. **Give Claude Code the Tapdance tools,** in your app's project folder. If you already added it from
   the README, skip this. Start Claude Code and type `/mcp`: you should see `tapdance`. The full paths
   matter when Node.js came from nvm.

   ```bash
   claude mcp add tapdance -- "$(command -v node)" "$(command -v tapdance)" mcp
   ```

## Ask your agent

Tell it what you want, in plain words, in your app's folder. For example: "Lease an Android phone,
install app-debug.apk, sign up with a new account and take a screenshot of each screen. Then do the
same on an iPhone with the iOS app built from our main branch." Building the iOS app on the Mac needs
a one-time setup first: [section 6](#6-ask-it-to-test-your-app), steps 1 to 4.

## When you are done

```bash
tapdance machine destroy android
tapdance machine destroy ios
```

Each one removes the machine and everything made for it, and checks what is left that costs money. For
Android **you should see** `Nothing billable left from this machine.` The Mac cannot be deleted in its
first 24 hours: `destroy` then says `Left: the Mac mini, scheduled for deletion at <time>`, and it
bills until then. (`destroy` on a Mac has not run on a real account yet.)

## Or let it run by itself

```bash
tapdance machine auto on --platform android
```

From then on, when your agent asks for an Android phone and the machine is off, Tapdance starts it; if
there is no machine, it creates one in the background and tells the agent to try again in a few
minutes (the agent passes on the Tailscale link for you to approve). The machine switches itself off
after 30 minutes without use. Each new machine still needs you to approve it in Tailscale: the agent
passes the link on, so keep an eye on what it tells you. Auto mode keeps at most one machine per
platform and never deletes one: a stopped Android machine keeps its disk, which bills about USD 6.40 a
month, until you run `tapdance machine destroy android` yourself. `--delete-after-days 7` reminds you
once it has been off a week. For iPhones,
`tapdance machine auto on --platform ios --accept-mac-day` lets it rent a Mac when needed, one at a time;
each new Mac costs at least one day (auto mode for iPhones has not run on a real account yet). If your
project already has a Mac, auto mode does not rent another:
it asks you to set that one up once with `--server-id`. `tapdance machine auto` shows the setting,
`tapdance machine auto off` turns it off.

**Want help along the way?** Paste this into Claude Code on your laptop:

```text
Walk me through https://github.com/mirzemehdi/tapdance/blob/main/docs/guides/start-without-a-mac.md
("Set it up once") one step at a time. Run the commands meant for my laptop yourself, tell me exactly
what to click in the Google Cloud, Scaleway and Tailscale websites, and wait for me where it says to.
Ask before anything that costs money, give me each Tailscale link to approve, and never print token
files or passwords.
```

**How sure this is.** The Android part ran for real on a Google Cloud account: `machine create` took
about 6 minutes of work plus the Tailscale click, the agent's checklists passed, auto mode created,
stopped and started the machine by itself, and `destroy` left nothing that bills
([evidence](../testing/evidence/2026-11-09-byoc-self-run.md)). The iPhone part ran for real on a Scaleway Mac mini the owner had rented
(`--server-id`): set up and connected in under 9 minutes, and the iOS checklists passed. Not run on a
real account yet: renting a Mac with `create` (the rent, the macOS install wait, the scheduled
deletion), `destroy` on a Mac, and auto mode for iPhones. These are tested only
with a stand-in for Scaleway and gcloud. Each step it automates has run for real by hand (the
[do it by hand](#under-the-hood-do-it-by-hand) section at the end). The agent in these runs was a test
script, not Claude Code itself. Report what trips you up with `tapdance report`.

The sections below are the same steps in detail: what to type, and what you should see.

## Before you start

**What it costs.**

- **[Google Cloud](https://cloud.google.com/compute):** about USD 0.20 an hour while the Android machine
  runs, an `n2-standard-4` ([N2 machine types](https://cloud.google.com/compute/docs/general-purpose-machines#n2_machines)).
  It switches itself off after 30 minutes without use. Its 64 GB disk costs about USD 6.40 a month, even
  while the machine is off, until you destroy it.
- **[Scaleway](https://www.scaleway.com/en/pricing/apple-silicon/) (iOS only):** EUR 2.64-5.28 a day
  before VAT, depending on which Mac mini is in stock (M1-M 2.64, often out of stock; M2-M 4.08; M2-L
  5.04; M4-S 5.28); `create` rents the
  cheapest one in stock and tells you which and what it costs before you say yes. Apple's licence makes Scaleway bill at least 24
  hours, and the Mac cannot be deleted sooner. It bills until it is deleted, even when switched off.
  `create` asks before renting it, and sets it to be deleted by itself at the 24-hour mark.
- **Tailscale:** free for personal use.

A test day costs EUR 2.64-5.28 (before VAT) for the Mac plus one or two dollars for Google Cloud.

These prices are approximate, read on 2026-11-09. Google and Scaleway change them: check
[Google Cloud's N2 prices](https://cloud.google.com/compute/vm-instance-pricing#n2_machine_types) and [Scaleway's Mac mini prices](https://www.scaleway.com/en/pricing/apple-silicon/) before you start.

**How long it takes.** About 10 minutes for the Android machine. About 1 to 1½ hours for the Mac, most
of it Scaleway installing macOS, when there is nothing for you to do; start it first and set up Android
meanwhile. Building your iOS app on the Mac adds 10 to 60 minutes the first time: a Kotlin
Multiplatform app's first build took 9 minutes on the smallest Mac mini.

**What you need.**

- A laptop with Linux or macOS. Windows is expected to work as the laptop, but nobody has tried it yet.
- A Google account and a payment card. Google Cloud and Scaleway both ask for one.
- Claude Code, or another AI agent that supports MCP, on the laptop.
- Your app's code on GitHub. For Android, you build a debug APK on your laptop. For iOS, the Mac builds
  the app from GitHub (step 6). That works for native iOS apps and Kotlin Multiplatform apps. Flutter
  and React Native apps have not been tried: the Mac runs only `xcodebuild`, so for those, let your CI
  build a simulator app instead (step 6).

## 1. Create the accounts

Start a day early if you can: Scaleway may ask you to verify your identity before you can rent a Mac.

1. **Google Cloud.** Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in.
   Set up billing when it asks. Create a new project, for example `tapdance-test`, and note its
   **project ID** (the project picker shows it). A project of its own keeps Tapdance apart from
   everything else you run.
2. **Scaleway (iOS only).** Sign up at [console.scaleway.com](https://console.scaleway.com) and add a
   payment method.
3. **Tailscale.** Sign up at [login.tailscale.com](https://login.tailscale.com). Tailscale makes a
   private network between your machines, so the phones are never open to the internet. In its admin
   console, open **DNS** and turn on **HTTPS Certificates**: your machines then talk over `https://`,
   and you can watch the phones live in your browser.

## 2. Prepare your laptop

**Tailscale.** On Linux:

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

`tailscale up` prints a link: open it and log in. On macOS, install the app from
[tailscale.com/download](https://tailscale.com/download) instead. **You should see** your laptop under
**Machines** in the Tailscale admin console.

**Node.js 22.13 or newer.** Ubuntu's own Node.js is too old. One easy way is nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
```

**Tapdance:**

```bash
npm install -g tapdance-cli
tapdance --version
```

**You should see** `0.3.0` or newer. The npm package called just `tapdance` is a different
project, so install `tapdance-cli`.

**gcloud, Google Cloud's command-line tool.** Install it from
[cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install), then log in and pick
your project:

```bash
gcloud init
```

It opens a browser to log you in, then asks which project to use: pick `tapdance-test`. **You should
see** your project ID when you run `gcloud config get-value project`.

**scw, Scaleway's command-line tool (iOS only).** Install it from
[Scaleway's quickstart](https://www.scaleway.com/en/docs/scaleway-cli/quickstart/), then:

```bash
scw init
```

It asks for an API key. In the Scaleway console, under **IAM > API keys**, generate a key for
**yourself** (so it has your permissions). `scw init` asks for its access key and secret key, then your
default organization, project and zone. The key stays in scw's own config file; Tapdance never reads it.

## 3. Create the iPhone machine (iOS only)

Start this first, because Scaleway takes a while to install macOS:

```bash
tapdance machine create --cloud scaleway
```

Add options for the Mac's setup after `--`, now rather than after the Mac day has started:

- **A Kotlin Multiplatform app:** `-- --android-build-sdk`. Its iOS build also configures the Android
  parts and fails with "SDK location not found" without the Android SDK.
- **A private repository** the Mac should build from: `-- --with-gh`, which installs the GitHub tool
  for step 6. Both together: `-- --android-build-sdk --with-gh`.

It checks that `scw` is logged in, shows what it will rent and what it costs, and asks:

```text
› cheapest Mac mini in stock: M2-M in fr-par-3 (available)
› Rent an iOS machine "ios" from Scaleway: a Mac mini M2-M in fr-par-3.
›   Scaleway bills a Mac mini for at least 24 hours, and you cannot delete it sooner (Apple's macOS licence).
›   It bills until it is deleted, also while switched off: EUR 0.17 an hour before VAT (M2-M), ...
›   It is scheduled for automatic deletion at the 24-hour mark, so a forgotten Mac costs one day (--keep turns that off).
Rent it? You pay Scaleway for at least 24 hours. [y/N]
```

Answer `y`. Then it works through six steps and prints each one with the time it took. Two things need
you:

- **Waiting.** Step 3 waits for Scaleway to install macOS, often 20 to 60 minutes. Leave it running and
  do step 4 in a second terminal.
- **One click.** In step 5 it prints **Open this link and approve the machine in your Tailscale
  network**. Open the link and approve the machine. It is called `tapdance-ios`.

**You should see** at the end:

```text
Machine ios is ready and connected.
  endpoint: https://tapdance-ios.tail1234.ts.net:4720
```

On a 16 GB Mac mini (M2-M and up) Tapdance keeps one iPhone booted as a spare, so the next one starts in
seconds. The 8 GB M1-M has room for one iPhone at a time: there it keeps no spare, and each new iPhone
takes one to two minutes to start. `--type` and `--zone` pick an offer yourself.

## 4. Create the Android machine

```bash
tapdance machine create --cloud gcp
```

It uses the project `gcloud` is set to (`--project <PROJECT_ID>` picks another), shows what it will
create and what it costs, and asks `Create it?`. Answer `y`. It then:

1. turns on the Compute Engine, IAP and OS Login APIs in your project;
2. makes a private network that only Google's own SSH service can enter;
3. creates the machine `tapdance-android`;
4. waits until it answers;
5. installs the Android tools, an Android system image and Tapdance on it, and starts one Android phone
   as a self-test. Here too it prints a **Tailscale link**: open it and approve `tapdance-android`;
6. connects your laptop to it.

**You should see** `Machine android is ready and connected.` after about 10 minutes (6 of them work in the measured run, plus your click).

If it stops with an error, it says which step failed and why. Fix what it names, then run the same
command again: it continues where it stopped. Common ones are in [If something goes
wrong](#if-something-goes-wrong).

Once both machines are in your Tailscale network, let only your laptop reach them:
[step 5 of "Set it up once"](#set-it-up-once) has the rule.

## 5. Try both phones, then connect your agent

Borrow each phone once by hand. Run this in your app's project folder, so the screenshots land there:

```bash
cd ~/<your-app>
tapdance device lease --platform android
tapdance screenshot
tapdance device release
tapdance device lease --platform ios
tapdance screenshot
tapdance device release
```

**You should see** each lease print the phone it got, and each screenshot saved under
`./tapdance-artifacts/`.

**If Android is unreachable**, the Google Cloud machine has switched itself off after 30 minutes without
use. Start it again, and wait about a minute:

```bash
tapdance machine start android
```

You can tell your agent it may run that command itself.

Now give your agent the phones. For Claude Code, from your app's project folder:

```bash
claude mcp add tapdance -- "$(command -v node)" "$(command -v tapdance)" mcp
```

The full paths matter because Node.js came from nvm: Claude Code started from a desktop launcher or an
IDE may not see nvm's `PATH`. Start Claude Code in that folder and run `/mcp`. **You should see** a
server called `tapdance`, connected, with tools such as `lease_device` and `take_screenshot`. Codex
and Cursor are in [connect your agent](../agents.md).

## 6. Ask it to test your app

**Android: build on your laptop.** Build a debug APK as you normally would, for example:

- a native Android app: `./gradlew assembleDebug`, which writes `app/build/outputs/apk/debug/app-debug.apk`;
- a Kotlin Multiplatform app: `./gradlew :composeApp:assembleDebug`, which writes
  `composeApp/build/outputs/apk/debug/composeApp-debug.apk`;
- a Flutter app: `flutter build apk --debug`, which writes `build/app/outputs/flutter-apk/app-debug.apk`;
- a React Native app: `cd android && ./gradlew assembleRelease`, which writes
  `android/app/build/outputs/apk/release/app-release.apk`. Use a release build: a debug build loads its
  JavaScript from Metro on your laptop, which the cloud machine cannot reach.

The agent uploads the APK to the Android machine itself.

**iOS: let the Mac build it from GitHub.** Do this once. The commands below log in to the Mac with the
key `tapdance machine create` made for it. Find the Mac's address in the line it printed after "A
shell on the machine", or with `tapdance machine list --json` (the `shell` field):

```bash
KEY=~/.tapdance/machines/ios/id_ed25519
MAC=m1@<mac-ip>
```

A **public repository** needs no GitHub token: skip steps 1 and 2, and use `--git-auth none` in step 3.

1. **If the repository is private, make a GitHub token.** On GitHub, open **Settings > Developer
   settings > Personal access tokens > Fine-grained tokens > Generate new token**. Pick only your app's
   repository, and give it **Contents: Read-only**. Copy the token.
2. **Log the Mac in to GitHub with it.** On your laptop, run this and paste the token when it asks. It
   is not shown on screen:

   ```bash
   ssh -t -i "$KEY" "$MAC" 'tapdance host gh-login'
   ```

   The prompt form has not been tried on a rented Mac yet. The form that has been tried passes the token
   over ssh's input, without writing it to a file:

   ```bash
   read -rs TOKEN
   printf '%s' "$TOKEN" | ssh -i "$KEY" "$MAC" 'tapdance host gh-login'
   unset TOKEN
   ```

   `read -rs` waits for you to paste the token and press Enter, without showing it.

3. **Allow builds of your repository** on the Mac:

   ```bash
   ssh -i "$KEY" "$MAC" 'tapdance host builds enable --repo https://github.com/<you>/<your-app> --git-auth gh --allow-admin-account'
   ```

   `--allow-admin-account`: the rented Mac's only user is an administrator, which is fine on a Mac that
   holds nothing of yours. The Mac needs the GitHub tool for `--git-auth gh`: create it with `-- --with-gh`
   (section 3). Created it without? Install the tool on the Mac yourself: `ssh -i "$KEY" "$MAC" 'brew
   install gh'` if Homebrew is there, else from [cli.github.com](https://cli.github.com).

   It checks that the Mac can read the repository and warns if not.

4. **Files kept out of git?** If the iOS build needs files your repository does not contain, such as
   `google-services.json`, `GoogleService-Info.plist` or `local.properties`, give the Mac a copy once.
   For example, from your app's folder on the laptop:

   ```bash
   ssh -i "$KEY" "$MAC" 'tapdance host builds files add --repo https://github.com/<you>/<your-app> iosApp/iosApp/GoogleService-Info.plist' < iosApp/iosApp/GoogleService-Info.plist
   ```

   The second path is where the file belongs in the repository. The Mac copies it in before each build.

The agent can then build any branch of that repository on the Mac and install it on the iPhone. The Mac
builds what is on GitHub, so **push your branch first**: changes only on your laptop are not tested. If the
Xcode project sits in a subfolder, as `iosApp/iosApp.xcodeproj` does in a Kotlin Multiplatform app, it
is found as long as there is only one, up to two folders deep. The [host builds guide](host-builds.md) has the other options.

**Flutter or React Native?** Building them on the Mac has not been tried. Let your CI build a simulator
app instead and have the Mac install it: see [build in CI](ci-builds.md). Installing an iOS app from CI
is unit-tested only so far.

Then ask your agent, for example:

```text
Lease an Android phone, install composeApp/build/outputs/apk/debug/composeApp-debug.apk,
open the app, sign in with the test account from TESTING.md, and take a screenshot of each
screen. Release the phone. Then lease an iPhone, build the iOS app from our main branch on
the Mac, install it and do the same. Tell me what looked wrong, and release the iPhone at the end.
```

An agent session holds one phone at a time, so the agent releases the Android phone before it leases
the iPhone.

**You should see:** the agent leases a phone, installs and opens the app, taps through it, and saves
screenshots under `./tapdance-artifacts/`.

You can watch the phone live in your browser while the agent works. Ask the agent for its session id:
the `get_device_status` tool reports it, and in Claude Code it starts with `claude-code:`. Then run:

```bash
tapdance --session claude-code:<id> view
```

Open the link it prints. Touching the phone in the browser takes over; **Hand back** returns it to the
agent.

## 7. Stop paying

When you are done:

```bash
tapdance device release
tapdance machine destroy android
tapdance machine destroy ios
```

Each `destroy` asks first, then logs the machine out of Tailscale, removes it from your laptop, deletes
it with everything made for it (its disk, network and firewall rule on Google Cloud; its ssh key on
Scaleway), and checks your account. For Android **you should see** `Nothing billable left from this
machine.` It
also lists other things in your project that cost money, such as your other machine; it leaves those
alone.

The Mac is different in its first 24 hours: Scaleway does not delete it sooner. `destroy` then sets it
to be deleted as soon as Scaleway allows and tells you when; it bills until then. `tapdance machine
list` shows your machines, what they cost so far (an estimate), and the Mac until it is gone.

Then, if you made one, delete the GitHub token. If you do not use Google Cloud for anything else, log
gcloud out with `gcloud auth revoke --all`: its login can reach your whole account.

## If something goes wrong

- **"gcloud is not logged in" or "scw cannot reach Scaleway":** run `gcloud init` or `scw init` again
  (step 2).
- **"Billing is not turned on":** link a billing account to the project in the Google Cloud console
  (**Billing > Link a billing account**). A Firebase project's billing account works too.
- **Google Cloud says the quota for `N2_CPUS` is too low:** your new project needs a higher limit. Ask
  for 4 or more under **IAM & Admin > Quotas & system limits** in the console, or try another zone with
  `--zone europe-west1-b`.
- **Google Cloud says nested virtualization is not allowed:** your Google account belongs to an
  organization that forbids it. Use a personal Google account and a new project.
- **Scaleway has no Mac in stock:** `create` names the offers in stock: pick one with `--type` and
  `--zone`, or try later.
- **The Tailscale link timed out:** run the same `create` command again and open the new link.
- **Old machines stay listed in Tailscale:** `destroy` logs the machine out, but Tailscale keeps it as
  offline, and a new machine then gets a name like `tapdance-android-1`. Delete the old entries under
  **Machines** in the Tailscale admin console.
- **A step failed:** fix what it names and run the same command again; it continues at that step. To
  give up instead, `tapdance machine destroy <name>` removes what was made.
- **Android is unreachable later:** the machine switched itself off. `tapdance machine start android`.
- **iPhone leases fail with "Internal error":** the small Mac ran out of memory. Log in to it (the
  `shell` line of `tapdance machine list --json`) and run `tapdance host warm android=0,ios=0`.
- **The first command on a new iPhone times out:** run it again. The first one starts a helper on the
  phone and can be slow.
- **The iOS build fails with "SDK location not found":** it is a Kotlin Multiplatform app and the Mac
  has no Android SDK. Create the Mac with `tapdance machine create --cloud scaleway -- --android-build-sdk`,
  or on a Mac you have, run `host-setup.sh` again with `--android-build-sdk`.

Everything else: [troubleshooting](../troubleshooting.md). The words used here are explained in the
[glossary](../glossary.md).

## Under the hood: do it by hand

What `tapdance machine create` does, and how to do it yourself, for example on another cloud or to see
each step. The full reference is [`tapdance machine`](../cli-reference.md#machine).

**On Google Cloud** it runs your `gcloud`: it turns on the Compute Engine, IAP and OS Login APIs, creates a
network, subnet and firewall rule called `tapdance-android` (the rule lets only Google's IAP range
`35.235.240.0/20` reach SSH), creates the VM `tapdance-android` with nested virtualization, no service
account, OS Login and a stop 8 hours after each start, labelled `tapdance-machine=android`, copies
`scripts/host-setup.sh` to it over IAP SSH and runs it with `--yes`, reads the endpoint and the pairing
token over SSH and runs `tapdance connect` with the token on stdin. The token is never shown.

**On Scaleway** it runs your `scw`: it makes an ssh key in `~/.tapdance/machines/ios/` and adds it to
your project, rents the Mac mini `tapdance-ios` and schedules its deletion, waits for macOS, reads the
Mac's password from Scaleway's API into memory and sends it to the Mac over ssh's stdin to turn on
automatic login (`infrastructure/scripts/macos-auto-login.sh --password-stdin`) and to allow sudo
during the setup only, restarts the Mac, runs `host-setup.sh --ios-only` and connects the same way.
The password is never printed or saved by Tapdance.

The steps below are the same path typed by hand: it ran for real in the earlier field tests.

### By hand A. Rent the Mac (it takes about an hour to be ready)

Start this first, because Scaleway needs about an hour to install macOS.

1. In the Scaleway console, add your SSH public key under your project's **SSH keys**.
2. Open **Bare Metal > Apple silicon > Create Mac mini** and choose:
   - the **M1-M** offer, the smallest and cheapest;
   - the newest macOS version;
   - **No commitment**;
   - your SSH key;
   - **automatic deletion after 24 hours**, so a forgotten Mac stops billing on its own.
3. Create it.

**You should see:** the Mac mini listed as installing. When it is ready, its page shows an IP address,
the user name `m1`, and a password. Xcode comes installed, and you need no Apple ID or Apple developer
account for simulators. Keep the password private; you need it in D.

With automatic deletion, the Mac is gone after 24 hours. To test again another day, rent a new one and
repeat A and D. Running `tapdance connect … --name mac` with the new
Mac's address replaces the old one on your laptop. Turn automatic deletion off if you want to keep the
Mac longer: it keeps billing, EUR 2.64 a day before VAT for an M1-M.

### By hand B. Start the Android machine on Google Cloud

While the Mac installs, create the machine that runs the Android phones. It needs
[nested virtualization](https://cloud.google.com/compute/docs/instances/nested-virtualization/overview), which lets an emulator run inside a cloud machine:

```bash
gcloud compute instances create tapdance-n2 \
  --zone=us-central1-a \
  --machine-type=n2-standard-4 \
  --enable-nested-virtualization \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=64GB --boot-disk-type=pd-balanced \
  --no-service-account --no-scopes \
  --tags=tapdance-host \
  --max-run-duration=8h --instance-termination-action=STOP
```

**You should see** a table with `tapdance-n2` and the status `RUNNING`. The zone `us-central1-a` is
only an example: a zone near you, such as `europe-west1-b`, works too. Use the same zone in every
command on this page. The last line of the command
stops the machine after 8 hours, so a forgotten one does not run all week. Older gcloud versions keep
these two options under `gcloud beta`.

If gcloud says the quota for `N2_CPUS` is too low, your new project needs a higher limit. Ask for 4 or
more under **IAM & Admin > Quotas & system limits** in the console.

Now let only Google's own SSH service reach the machine:

```bash
gcloud compute firewall-rules create tapdance-host-ssh-iap \
  --network=default --direction=INGRESS --action=allow --rules=tcp:22 \
  --source-ranges=35.235.240.0/20 --target-tags=tapdance-host
```

**You should see** the rule `tapdance-host-ssh-iap` listed as created.

A new project also comes with a rule called `default-allow-ssh`, which lets the whole internet try to
reach SSH. If this project is only for Tapdance, delete it:

```bash
gcloud compute firewall-rules delete default-allow-ssh
```

The full details are in the [Google Cloud guide](../deployment/google-cloud-n2.md).

### By hand C. Set up the Android machine

Open a shell on it from your laptop:

```bash
gcloud compute ssh tapdance-n2 --zone=us-central1-a --tunnel-through-iap
```

The first time, gcloud makes an SSH key for you and may ask a few questions: the defaults are fine.
Your prompt then changes to the machine's name. Everything until `exit` below runs **on the Google
Cloud machine**.

Check that emulators can run:

```bash
ls -l /dev/kvm
```

**You should see** a line for `/dev/kvm`. If it says "No such file", stop: the machine was created
without nested virtualization, and emulators cannot run on it.

Now run the one setup command. `--label my-laptop` is a name for your laptop, the computer that will
use these phones:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-laptop
```

It asks you a few things on the way:

1. It lists what it will install (Node.js, Java, the Android tools, an Android system image, Tailscale)
   and asks **"Install them now?"**. Answer yes. This also accepts the Android SDK licences.
2. It prints a **Tailscale login link**. Open it in your laptop's browser and approve the machine.
3. It asks you to **approve the pairing** for `my-laptop`. Answer yes.
4. It boots one Android phone as a self-test. The first boot can take a few minutes.

**You should see** a block like this at the end:

```text
TAPDANCE HOST READY
endpoint:  https://tapdance-n2.tail1234.ts.net:4720
token:     saved to /home/you/.tapdance/worker/pairing-my-laptop.token (mode 600), fingerprint 3fa9c2. ...
devices:   android 34 (google_apis)
self-test: PASS (android lease, screenshot ok)
cost guard: idle stop after 30 min, uptime cap off
...
on the agent machine:  tapdance connect https://tapdance-n2.tail1234.ts.net:4720 < pairing-my-laptop.token
```

**Copy the `on the agent machine` line** into a text file on your laptop. You need it in a minute.

The machine switches itself off after 30 minutes without use, to save money. While you wait for the Mac,
it will probably do that. `gcloud compute instances start tapdance-n2 --zone=us-central1-a` starts it again.

Type `exit` to go back to your laptop. There, copy the token file and connect, using the line you
copied and adding `--name android`:

```bash
gcloud compute scp --zone=us-central1-a --tunnel-through-iap tapdance-n2:.tapdance/worker/pairing-my-laptop.token .
tapdance connect https://tapdance-n2.tail1234.ts.net:4720 --name android < pairing-my-laptop.token
rm pairing-my-laptop.token
```

The token file is a key to the phones. Keep it out of chats and repositories, and delete the copy once
`connect` has saved it.

**You should see:** `connect` checks the machine, shows Android phones as available, and prints the
lines to add Tapdance to Claude Code, Codex or Cursor.

### By hand D. Set up the Mac

Wait until Scaleway shows the Mac as ready. Then, from your laptop, have the Mac download one script
and run it, using the IP address from the Scaleway page:

```bash
ssh -t m1@<mac-ip> 'curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/infrastructure/scripts/macos-auto-login.sh -o macos-auto-login.sh && bash macos-auto-login.sh m1'
```

The first time, ssh asks "Are you sure you want to continue connecting?": type `yes`. The script asks
for the Mac's password twice: type the one from the Scaleway page. It makes the Mac log in by itself
after a restart, which the phones need. It stores the password in a file that is scrambled, not
encrypted. That is fine on a rented Mac that holds nothing of yours. Then restart the Mac with the **Reboot** button on the
Scaleway page, and wait a minute.

Now log in to the Mac:

```bash
ssh -t m1@<mac-ip>
```

Everything until `exit` below runs **on the Mac**. Download and run the setup command:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh -o host-setup.sh
bash host-setup.sh --ios-only --with-gh --allow-admin-account --label my-laptop
```

What the options mean:

- `--ios-only`: iPhones only on this Mac; Android runs on Google Cloud.
- `--with-gh`: installs the GitHub tool, so the Mac can fetch your app from GitHub.
- `--allow-admin-account`: the rented Mac's only user is an administrator. That is fine on a Mac that
  holds nothing of yours.
- **Kotlin Multiplatform app?** Add `--android-build-sdk` too. Its iOS build also configures the
  Android parts, and fails with "SDK location not found" without the Android SDK.

It asks you a few things:

1. What to install, and **"Install them now?"**: yes. It may also download an iOS runtime, about 8 GB.
2. The Mac's password, for the steps that need it.
3. A **Tailscale login link**: open it on your laptop and approve the Mac.
4. **Approve the pairing** for `my-laptop`: yes.

**You should see** the same `TAPDANCE HOST READY` block, this time with `devices: ios …`. **Copy its
`on the agent machine` line** too. The setup takes about 15 minutes.

Type `exit` to go back to your laptop. The smallest Mac mini has room for one iPhone at a time, so tell
it not to keep a spare one running:

```bash
ssh m1@<mac-ip> 'tapdance host warm android=0,ios=0'
```

Then copy the token. For the second line, paste the `on the agent machine` line you copied from the Mac,
and add `--name mac` before the `<`:

```bash
scp m1@<mac-ip>:.tapdance/worker/pairing-my-laptop.token .
tapdance connect https://<address the Mac printed> --name mac < pairing-my-laptop.token
rm pairing-my-laptop.token
```

**You should see:** iPhones available on `mac`. Your laptop now knows two machines: Android phones go
to `android` and iPhones go to `mac`.

More about the Mac, including what to do after a restart: the
[Scaleway guide](../ios/scaleway-mac.md).

### By hand: stop paying

1. **Delete the Mac mini** on the Scaleway page, after its first 24 hours, or let automatic deletion do
   it. Switching it off does not stop billing.
2. **Delete the Google Cloud machine and its firewall rule:**

   ```bash
   gcloud compute instances delete tapdance-n2 --zone=us-central1-a
   gcloud compute firewall-rules delete tapdance-host-ssh-iap
   ```

   A stopped machine still bills for its disk, so delete it rather than stop it.
3. **Forget the machines on your laptop:** `tapdance disconnect android` and `tapdance disconnect mac`.
4. **Remove the two machines** from the Tailscale admin console.
5. Check with the read-only leftovers scripts: `infrastructure/scripts/gcp-leftovers.sh <PROJECT_ID>`
   and `infrastructure/scripts/scaleway-leftovers.sh` ([Google Cloud tear-down](../deployment/google-cloud-n2.md#tear-down)).
