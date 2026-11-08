# Tapdance

**Your AI agent tests your app on real Android emulators and iOS simulators, and shows you what it
did.**

```text
  your AI agent                     Tapdance                        the phones
  (Claude Code, Codex, Cursor)  ──▶ borrows a phone, installs   ──▶ Android emulators and
  on your laptop or a server        your app, taps through it       iPhone simulators, on your
                                ◀── screenshots, videos, logs       Mac or a rented machine
```

You connect Tapdance to your agent once. After that you just tell the agent what to check, in your own
words.

## Contents

- [What it looks like](#what-it-looks-like)
- [What you can ask](#what-you-can-ask)
- [Get started](#get-started)
  - [1. Install Tapdance](#1-install-tapdance)
  - [2. Set up the phones](#2-set-up-the-phones)
  - [3. Connect your agent](#3-connect-your-agent)
- [Watch, and take over](#watch-and-take-over)
- [Keep your machines safe](#keep-your-machines-safe)
- [Project status](#project-status)
- [Learn more](#learn-more)
- [Credits and license](#credits-and-license)

## What it looks like

You ask your agent in plain words. It borrows a phone, drives your app, and brings back proof.

<!-- Demo GIF goes here: docs/assets/demo.gif (an agent signing in on an iPhone simulator). -->

```text
You:    Install the debug build on a Pixel, sign in with the test account, and check that
        the order history screen loads. Screenshot each step.

Agent:  lease_device        → Pixel 8, Android 14
        install_app         → app-debug.apk installed
        launch_app          → com.example.shop
        tap "Sign in", type the email and password, tap "Continue"
        take_screenshot     → tapdance-artifacts/…/01-signed-in.png
        tap "Orders"        → the list shows 3 orders
        take_screenshot     → tapdance-artifacts/…/02-orders.png
        release_device

        Sign-in and order history work. One thing looked off: the "Reorder" button is cut
        off on the right edge. See 02-orders.png.
```

This shows the kind of steps an agent takes. It is an example, not a recorded session.

## What you can ask

You don't need to learn any commands. Write what you want checked, the way you would ask a teammate.
The agent picks the steps. Screenshots, videos and logs land in `tapdance-artifacts/` in your project.

**Check a change before you open a pull request**

> I just changed the checkout flow. Build the debug APK, install it on an Android phone, buy the
> cheapest item with the test card from TESTING.md, and tell me if anything looks broken. Record a
> video of the whole flow so I can attach it to the PR.

**Reproduce a bug report**

> A user says the app crashes when they rotate the phone on the profile screen. Try it on an iPhone and
> on an Android phone. If it crashes, send me the crash log and the steps that caused it.

**Screenshots for the store or a design review**

> Take screenshots of the home, search and settings screens on an iPhone, in English, German and
> Japanese, in light and dark mode. Name the files so I can tell them apart.

**Try harder conditions**

> Turn on the largest text size and check that no button label is cut off on the sign-up screens. Then
> do the same in landscape.

> On Android, turn off Wi-Fi, open the app, and check that the offline message appears instead of a
> spinner. Turn Wi-Fi back on and check that it recovers.

**Notifications and links**

> Post a "new message from Sam" notification on the Android phone, open it, and check that it lands in
> the right chat. Then open the link `myapp://orders/42` and check that the order screen shows order 42.

**Things only a person should type**

> Sign in with Google on the Android phone. When you reach the Google sign-in screen, ask me to do it,
> wait until I hand back, and then check that my name shows in the menu.

The agent pauses and asks you. You sign in yourself in the live view in your browser, so the agent
never sees your password. See [watch, and take over](#watch-and-take-over).

**Compare both platforms**

> Walk through onboarding on an Android phone and on an iPhone, one after the other, and list every
> screen where the two versions look or behave differently.

**Explore an unfamiliar app**

> Open the app, tap through every screen you can reach from the main menu, and give me a short map of
> the app with a screenshot of each screen.

Some of this depends on where the phones run. Wi-Fi and airplane mode can be switched on Android
emulators only, and an iPhone app must be built for the simulator. Your agent tells you when something
cannot be done.

## Get started

Three steps: install Tapdance, set up the machine that runs the phones, and connect your agent.

### 1. Install Tapdance

Install it on the computer where your agent runs. You need Node.js 22.13 or newer.

```bash
npm install -g tapdance-cli
```

The command is `tapdance`. The npm package called just `tapdance` is a different project, so install
`tapdance-cli`. If npm cannot find it, the first release is not out yet: the
[installation guide](docs/installation.md#from-source) shows how to install from source.

### 2. Set up the phones

Pick the situation that fits you.

**I have a Mac.** Everything runs on your Mac. It is free, and takes about 15 minutes if Xcode is
already installed. You need Xcode with one iOS simulator runtime for iPhones, and the Android SDK, which
Android Studio installs, for Android phones. Then run:

```bash
tapdance worker install
tapdance doctor
```

`worker install` starts the part of Tapdance that runs the phones. `doctor` checks everything and tells
you what is missing. The [quick start](docs/quick-start.md) has the details.

**My agent runs elsewhere, and I have a Mac or Mac mini for the phones.** Your agent runs on a laptop or
a server, and your Mac runs the phones. The two talk over Tailscale, a free private network between
your machines. It is free and takes about 30 minutes. On the Mac, run one command; `--label` is a name
for the computer your agent runs on:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-laptop
```

It ends by printing one line to run on your agent's computer, and saves a token file that is the key to
your phones. The [guide for your own Mac](docs/deployment/one-command-host.md) walks through it.

**I don't have a Mac.** Rent the machines: Android phones on Google Cloud, iPhones on a Mac mini from
Scaleway. You create three accounts: Google Cloud, Scaleway and Tailscale. Google Cloud costs about
USD 0.20 an hour while the machine runs, plus about USD 7 a month for its disk until you delete it. The
Mac mini costs about EUR 3 a day, billed for at least 24 hours. Allow about 1.5 hours, most of it
waiting for Scaleway to install macOS. The [walkthrough without a Mac](docs/guides/start-without-a-mac.md)
goes from the accounts to your first test, and ends with how to stop paying.

**I only need Android.** Use your own Mac (as above, with only the Android SDK), or Google Cloud (the
walkthrough without a Mac, skipping Scaleway). A Linux PC with hardware virtualization can run Android
phones too, though it has only been tried on Google Cloud so far. Windows cannot run the phones.

### 3. Connect your agent

For Claude Code, in your app's project folder:

```bash
claude mcp add tapdance -- tapdance mcp
```

Start Claude Code and run `/mcp`: a server called `tapdance` should be listed. Then ask it something
from [what you can ask](#what-you-can-ask). Codex, Cursor and other agents are in
[connect your agent](docs/agents.md).

## Watch, and take over

You can watch the phone live in your browser while the agent works. Touching the screen takes over, so
you can type a password or approve a purchase yourself. One click hands it back to the agent. The
[agent guide](docs/agents.md#watching-the-agent) shows how to open the live view.

Tapdance also works from the terminal and from scripts, without an agent. The
[CLI reference](docs/cli-reference.md) lists every command.

## Keep your machines safe

- Your agent can only drive the phones. It never gets a shell on the machine that runs them.
- Use a Mac that holds nothing personal, or a separate user account on it. An iPhone app in the
  simulator runs as a normal Mac program, so installing one runs code on that Mac.
- Keep the token file private. It is a key to your phones, and you can revoke it at any time.

The [threat model](docs/security/threat-model.md) explains what each permission allows.

## Project status

Tapdance 0.1.0 is not released yet. What has run for real:

- The whole test loop on a Mac, with iPhone simulators and Android emulators.
- An agent on one machine testing a real app on phones on another machine: the owner's Mac, Google
  Cloud for Android, and a rented Scaleway Mac mini for iOS.
- One agent using an Android machine and an iOS machine in the same session.
- The live browser view, with taking over and handing back.

Not yet:

- Claude Code, Codex or Cursor using Tapdance's tools themselves. So far only a scripted client has.
- MacStadium, AWS Mac, OVH or a physical Linux PC as the machine that runs the phones.
- Running external tools, such as Google's Android CLI, on a remote machine. This is not built.

Some newer features are unit-tested only. [STATUS.md](STATUS.md) lists every feature and what has been
proven.

## Learn more

The [docs index](docs/README.md) lists every guide by goal.

The [glossary](docs/glossary.md) explains the words the guides use.

Found a bug? `tapdance report` writes an issue-ready report, with your tokens removed.

Want to work on Tapdance itself? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and license

Tapdance builds on other people's work:

- [Simlock](https://github.com/callstackincubator/simlock) runs the phones and lends them out.
- [agent-device](https://github.com/callstack/agent-device) drives them: taps, typing, screenshots.
- [AXe](https://github.com/cameroncooke/AXe) is an optional way to drive iPhone simulators.
- [App Store Connect CLI](https://github.com/rorkai/App-Store-Connect-CLI) (`asc`) runs as an external
  tool for App Store Connect.
- [fastlane](https://github.com/fastlane/fastlane) runs as an external tool, when you allow it.
- [Maestro](https://github.com/mobile-dev-inc/maestro) runs test flows as an external tool.
- [Google's Android CLI](https://developer.android.com/cli) runs as an external tool against the
  borrowed Android phone.

[NOTICE.md](NOTICE.md) lists every project with its license.

Tapdance is free and open source under the [GNU AGPL-3.0](LICENSE). You may use, change and self-host
it. If you offer a changed Tapdance to others as a network service, the AGPL asks you to share your
changes.
