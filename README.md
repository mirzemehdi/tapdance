# Tapdance

**Your AI agent tests your app on real Android emulators and iOS simulators, and shows you what it
did.**

```text
  your AI agent                     Tapdance                        the phones
  (Claude Code, Codex, Cursor)  ──▶ borrows a phone, installs   ──▶ Android emulators and
  on your laptop or a server        your app, taps through it       iPhone simulators, on your
                                ◀── screenshots, videos, logs       Mac or a rented machine
```

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

## Install Tapdance

Install it on the computer where your agent runs. No Mac? Skip this section: the
[walkthrough without a Mac](docs/guides/start-without-a-mac.md) covers the install too.

You need git and Node.js 22 or 24, at least 22.13. Node 25 and later no longer include corepack,
which the install uses. Tapdance is not on npm yet, so it installs from source:

```bash
mkdir -p ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"
git clone https://github.com/mirzemehdi/tapdance.git
cd tapdance
corepack enable --install-directory ~/.local/bin pnpm
pnpm install
pnpm build
ln -s "$PWD/packages/cli/dist/main.js" ~/.local/bin/tapdance
tapdance --version
```

The `export` line puts `~/.local/bin` on your `PATH` for this terminal only. Add the same line to your
shell's startup file, such as `~/.zshrc` or `~/.bashrc`, to keep it. Do not run `npm install -g tapdance`: that name belongs to a
different package. The [installation guide](docs/installation.md) has more detail.

## Pick your situation

### I have a Mac

Everything runs on your Mac: your agent, Tapdance and the phones.

- **You need:** macOS with Xcode and one iOS simulator runtime for iPhones. For Android phones, the
  Android SDK, which Android Studio installs.
- **Cost:** free.
- **Time:** about 15 minutes if Xcode is already installed.

In your app's project folder:

```bash
tapdance init --mode local --yes
tapdance worker install
tapdance doctor
```

`worker install` starts the part of Tapdance that creates and runs the phones on your Mac. `doctor`
checks everything and tells you what is missing. If you only want iPhones, run
`tapdance config set platforms.android.enabled false` before `doctor`, so it skips the Android checks.

Borrow a phone by hand once, to see it work:

```bash
tapdance device lease --platform ios --device "iPhone 16"
tapdance app launch com.apple.Preferences
tapdance screenshot
tapdance device release
```

The first phone takes about 40 seconds to start. Later ones take a second or less, because Tapdance
keeps a spare one ready. The screenshot lands in `./tapdance-artifacts/`.

The [quick start](docs/quick-start.md) walks through each step. Then give it to your agent, below.

### My agent runs elsewhere, and I have a Mac or Mac mini for the phones

Your agent runs on a laptop or a server. A Mac you own runs the phones. The two talk over a private
network between your machines, called Tailscale, which is free.

- **You need:** a Mac with Xcode, a free Tailscale account, and both machines logged in to it.
  Tapdance installed on the agent's computer.
- **Cost:** free.
- **Time:** about 30 minutes.

On the Mac, run one command. `--label` is a name for the computer your agent runs on:

```bash
curl -fsSL https://raw.githubusercontent.com/mirzemehdi/tapdance/main/scripts/host-setup.sh | bash -s -- --label my-laptop
```

It installs what is missing and asks you to approve a few steps. It ends by printing the Mac's address
and the line to run on your agent's computer. It also saves a token file on the Mac,
`~/.tapdance/worker/pairing-my-laptop.token`. That file is the key to your phones.

Copy the token file to your agent's computer privately, for example with `scp`. Then, on that computer,
run the line the Mac printed. It looks like this:

```bash
tapdance connect https://my-mac.tail1234.ts.net:4720 < pairing-my-laptop.token
```

`connect` checks the Mac and prints the lines that add Tapdance to your agent. The
[guide for your own Mac](docs/deployment/one-command-host.md) also covers keeping it awake and taking
access away again.

### I don't have a Mac

Rent the machines that run the phones: Android phones on Google Cloud, iPhones on a Mac mini rented
from Scaleway.

- **You need:** a laptop, a Google account and a payment card. You create three accounts, in this
  order: Google Cloud, Scaleway and Tailscale. If your app's code is private, a GitHub token too.
- **Cost:** Google Cloud is about USD 0.20 an hour while the machine runs, plus about USD 7 a month for
  its disk until you delete it. The Scaleway Mac mini is about EUR 3 a day, billed for at least 24
  hours. Tailscale is free.
- **Time:** about 1.5 hours until both phones work, most of it waiting for Scaleway to install macOS.
  Building your iOS app on the rented Mac adds 30 to 60 minutes the first time.
- **Apps:** native and Kotlin Multiplatform apps can be built on the rented Mac. Flutter and React
  Native apps have not been tried there; your CI can build them instead.

The [walkthrough without a Mac](docs/guides/start-without-a-mac.md) goes from creating the accounts to
your agent testing your app. It ends with how to stop paying.

### I only need Android

Pick the machine that runs the Android phones:

- **Your own Mac.** Follow "I have a Mac" and install only the Android SDK. Free.
- **Google Cloud.** Follow the walkthrough without a Mac and skip the Scaleway steps. About USD 0.20
  an hour while it runs.
- **A Linux PC** with hardware virtualization turned on. It can run Android phones too, but so far it
  has only been tried on Google Cloud, not on a physical PC.

A Windows computer cannot run the phones. It is expected to run your agent and Tapdance, but that has
not been tried yet.

## Give it to your agent

For Claude Code, in your app's project folder:

```bash
claude mcp add tapdance -- tapdance mcp
```

Start Claude Code and run `/mcp`: a server called `tapdance` should be listed.
[Connect your agent](docs/agents.md) covers Codex, Cursor and other agents.

Then ask it in plain words:

- "Install the debug build on an iPhone and check that onboarding works in dark mode."
- "Reproduce the crash from issue 42 on Android 14 and send me the logs."
- "Take screenshots of every settings screen in German."

You can watch the phone live in your browser while the agent works, and take over to type a password
yourself. The [agent guide](docs/agents.md#watching-the-agent) shows how.

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
- AXe, the App Store Connect CLI, fastlane, Maestro and Google's Android CLI run as external tools.

[NOTICE.md](NOTICE.md) lists every project with its license.

Tapdance is free and open source under the [GNU AGPL-3.0](LICENSE). You may use, change and self-host
it. If you offer a changed Tapdance to others as a network service, the AGPL asks you to share your
changes.
