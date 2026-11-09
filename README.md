# Tapdance

**Your AI agent tests your app on real Android emulators and iOS simulators, and shows you what it
did.**

```text
  your AI agent                     Tapdance                        the phones
  (Claude Code, Codex, Cursor)  ──▶ borrows a phone, installs   ──▶ Android emulators and
  on your laptop or a server        your app, taps through it       iPhone simulators, on your
                                ◀── screenshots, videos, logs       Mac or a rented machine
```

<!-- Demo GIF goes here: docs/assets/demo.gif (an agent signing in on an iPhone simulator). -->

- [What you can ask your agent](#what-you-can-ask-your-agent)
- [Get started in 3 steps](#get-started-in-3-steps)
- [Project status](#project-status)
- [Keep your machines safe](#keep-your-machines-safe)
- [Learn more](#learn-more)
- [Credits and license](#credits-and-license)

## What you can ask your agent

Once Tapdance is connected, you tell your agent what to check, in your own words. It borrows a phone,
drives your app, and brings back screenshots, videos and logs. You don't need to learn any commands.

| You want to… | Say to your agent | What you get back |
| --- | --- | --- |
| [Test your Android app](docs/use-cases.md#test-your-android-app) | "Install app-debug.apk on an Android emulator, sign up with a new account and tell me if anything breaks." | What worked and what broke, with a screenshot of each screen. |
| [Build and test your iOS app](docs/use-cases.md#build-and-test-your-ios-app) | "Build the iOS app from this repo, run it on an iPhone simulator, go through onboarding and checkout, and send me screenshots of each step." | The app built and installed, and a screenshot of every step. |
| [Take a screenshot](docs/use-cases.md#take-a-screenshot) | "Send me a screenshot of the settings screen in dark mode." | A PNG, also in other languages if you ask. |
| [Record a video](docs/use-cases.md#record-a-video) | "Record a video of the login flow and give me the MP4." | An MP4 you can attach to a pull request. |
| [Watch live, or take over](docs/use-cases.md#watch-live-or-take-over) | "Open a live view so I can watch, and let me take over when you get stuck." | A link to the phone in your browser. You type passwords yourself. |
| [Find out why it crashed](docs/use-cases.md#find-out-why-it-crashed) | "The app crashes after login. Get the crash log and tell me why." | The crash log, the steps that cause it, and the agent's explanation. |
| [Make a repeatable test](docs/use-cases.md#make-a-repeatable-test) ◐ | "Turn what you just did into a scenario file and run it again on iOS and Android." | A scenario file in your repo, and PASS or FAIL for each step. |
| [Check accessibility](docs/use-cases.md#check-accessibility) | "Check the sign-up screens for unlabelled buttons and small touch targets, then try the largest text size." | A list of problems per screen, with screenshots. |
| [Measure performance](docs/use-cases.md#measure-performance) ◐ | "Scroll the feed for 30 seconds and tell me how many frames were janky." | Frame and memory numbers. |
| [Test in-app purchases](docs/use-cases.md#test-in-app-purchases) ◐ | "Buy the monthly subscription with the test account and check that the premium badge appears." | The purchase checked; the agent asks you when a sign-in needs a person. |
| [Test deep links and notifications](docs/use-cases.md#test-deep-links-and-notifications) ◐ | "Open myapp://orders/42 and check that it shows order 42. Then post a new-message notification and open it." | Where each link or notification landed, with screenshots. |
| [Build from a private repo or your CI](docs/use-cases.md#build-from-a-private-repository-or-your-ci) ◐ | "Install the APK from the latest CI run on main and check the login screen." | The app from your repo or CI, installed and checked. |

Each row links to a page that shows what the agent does behind the scenes, how to do the same by hand,
and where the files land. Rows marked ◐ work in part: for example, iPhone simulators report memory but
not frame health. The linked page says what has not run on a real phone yet.

## Get started in 3 steps

### 1. Install Tapdance

On the computer where your agent runs, with [Node.js](https://nodejs.org) 22.13 or newer:

```bash
npm install -g tapdance-cli
```

The command is `tapdance`. The npm package called just `tapdance` is a different project. To work on
Tapdance itself, the [installation guide](docs/installation.md#from-source) shows how to install from
source.

### 2. Connect your agent

For [Claude Code](https://code.claude.com/docs/en/mcp), in your app's project folder:

```bash
claude mcp add tapdance -- tapdance mcp
```

Start Claude Code and run `/mcp`: you should see a server called `tapdance`. You can do this before the
phones are set up. If Node.js came from nvm, or Claude Code starts from a desktop launcher, give the
full paths instead; [connect your agent](docs/agents.md) shows how, and covers Codex and Cursor too.

### 3. Choose where the phones run

The phones are emulators and simulators. They run on your Mac, on another Mac you own, or on machines
you rent.

| Where the phones run | Cost | Time | Guide |
| --- | --- | --- | --- |
| **My Mac.** Your agent and the phones on the same Mac. iPhones need [Xcode](https://developer.apple.com/xcode/); Android phones need [Android Studio](https://developer.android.com/studio). | Free | About 15 minutes, if Xcode is installed | [Try it on your Mac](docs/quick-start.md) |
| **A Mac or Mac mini elsewhere.** Your agent on a laptop or server, the phones on a Mac you own, connected by [Tailscale](https://tailscale.com), a free private network. | Free | About 30 minutes | [Run the phones on another machine](docs/deployment/one-command-host.md) |
| **No Mac.** Android on [Google Cloud](https://cloud.google.com/compute), an [N2 machine](https://cloud.google.com/compute/docs/general-purpose-machines#n2_machines). iPhones on a [Mac mini rented from Scaleway](https://www.scaleway.com/en/pricing/apple-silicon/). Both reached through [Tailscale](https://tailscale.com). | About USD 0.20 an hour for Google Cloud, plus its disk until you delete it. About EUR 3 a day for the Mac, 24 hours minimum. | About 1.5 hours | [Start without a Mac](docs/guides/start-without-a-mac.md) |

| **Tapdance Cloud.** No Mac, no cloud account: sign up and your agent gets phones on machines we run, one customer per machine. | Per hour or per Mac day | Minutes | Not available yet ([plan](docs/hosting-plan.md#stage-5--tapdance-cloud-one-step-at-a-time)) |

Only need Android? Your own Mac or Google Cloud is enough: follow either guide and skip the iPhone
steps. Windows cannot run the phones.

**Or let your agent do the setup.** Paste one of these into Claude Code. It runs the commands, reads
what they print and tells you what it needs from you.

- **My Mac** (run Claude Code on that Mac):

  ```text
  Set up Tapdance on this Mac so you can test my app on simulators, following
  https://github.com/mirzemehdi/tapdance/blob/main/docs/quick-start.md ("Set it up once").
  Install it with npm, start the phone service, run `tapdance doctor` and fix what it reports, then
  add the Tapdance MCP server for this project. Stop and ask me before installing Xcode or Android
  Studio, or changing anything outside Tapdance.
  ```

- **A Mac or Mac mini elsewhere** (run Claude Code on your laptop; you run one command on the Mac):

  ```text
  Help me run my app's test phones on my Mac mini while you stay on this laptop, following
  https://github.com/mirzemehdi/tapdance/blob/main/docs/deployment/one-command-host.md ("Set it up once").
  Tell me the one command to run on the Mac mini, wait for me to copy its key file here, then
  install Tapdance on this laptop, connect to the Mac mini and add the Tapdance MCP server. Never
  print the key file's contents.
  ```

When the setup is done, ask your agent something from the table above.

## Project status

Tapdance is an early release, 0.1.x on npm. What has run for real:

- The whole test loop on a Mac, with iPhone simulators and Android emulators.
- An agent on one machine testing a real app on phones on another machine: the owner's Mac, Google
  Cloud for Android, and a rented Scaleway Mac mini for iOS.
- One agent using an Android machine and an iOS machine in the same session.

Not yet: a recorded run with Claude Code, Codex or Cursor itself calling the tools. The same tools have
been driven on real phones by a scripted MCP client. Some newer features are unit-tested only. [STATUS.md](STATUS.md) lists every feature and
what has been proven.

## Keep your machines safe

- Your agent can only drive the phones. It never gets a shell on the machine that runs them.
- Testing your own app on your own Mac is like running it in Xcode's simulator: nothing extra to do.
- A Mac that runs phones for an agent on another machine is different. An iPhone app in the simulator
  runs as a normal Mac program, so whoever can install apps there can run code on that Mac. Use a Mac
  that holds nothing personal, or a separate user account on it.
- Keep the token file that connects your machines private. You can revoke it at any time.

The [threat model](docs/security/threat-model.md) explains what each permission allows.

## Learn more

- [Use cases](docs/use-cases.md): every row of the table above, in detail.
- [Docs index](docs/README.md): every guide, by goal.
- [Glossary](docs/glossary.md): the words the guides use.
- [CLI reference](docs/cli-reference.md): every command, for scripts and for using Tapdance by hand.
- [Contributing](CONTRIBUTING.md): working on Tapdance itself.

Found a bug? `tapdance report` writes an issue-ready report, with your tokens removed.

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
