# Start without a Mac: Android on Google Cloud, iOS on a rented Mac

This walkthrough takes you from nothing to your AI agent testing your app on an Android phone and an
iPhone, with only a laptop. The phones are emulators and simulators that run on two rented machines:

```text
  your laptop                         a private network (Tailscale, free)
  ┌──────────────────────┐             ┌──────────────────────────────────────┐
  │ your AI agent        │ ──────────▶ │ Google Cloud machine: Android phones │
  │ + Tapdance           │ ──────────▶ │ Scaleway Mac mini:    iPhones        │
  └──────────────────────┘             └──────────────────────────────────────┘
```

Only need Android? Skip step 3 and step 6, and every part marked **iOS only**. Then it takes about 30
minutes and costs only the Google Cloud machine.

## The short version

| Step | What you do | Time |
| --- | --- | --- |
| 1 | Create three accounts: Google Cloud, Scaleway (iOS only) and Tailscale | 15 min, plus Scaleway's identity check |
| 2 | Install Tapdance, Tailscale and `gcloud` on your laptop | 10 min |
| 3 | Rent a Mac mini on Scaleway's website (iOS only) | 5 min, then about an hour of waiting |
| 4–5 | Create the Android machine and run one setup command on it | 20 min |
| 6 | Run one setup command on the Mac (iOS only) | 15 min |
| 7–8 | Try a phone yourself, then add Tapdance to Claude Code | 5 min |
| 9 | Ask your agent to test your app | – |
| 10 | Delete the machines so they stop billing | 5 min |

Each step below says exactly what to type and what you should see.

**Want help along the way?** Paste this into Claude Code on your laptop:

```text
Walk me through https://github.com/mirzemehdi/tapdance/blob/main/docs/guides/start-without-a-mac.md
one step at a time. Run the commands meant for my laptop yourself, tell me exactly what to click in
the Google Cloud, Scaleway and Tailscale websites, and wait for me where it says to. Ask before
anything that costs money, and never print token files or passwords.
```

## Before you start

**What it costs.**

- **[Google Cloud](https://cloud.google.com/compute):** about USD 0.20 an hour while the machine runs, an `n2-standard-4`
  ([N2 machine types](https://cloud.google.com/compute/docs/general-purpose-machines#n2_machines)). Its 64 GB disk costs about USD 7 a
  month, even while the machine is stopped, until you delete it. Step 10 deletes it.
- **[Scaleway](https://www.scaleway.com/en/pricing/apple-silicon/):** EUR 2.64 a day before VAT for the smallest Mac mini, about EUR 3 with VAT. Apple's
  licence makes Scaleway bill at least 24 hours. It bills until you delete the Mac, even when it is
  switched off.
- **Tailscale:** free for personal use.

A test day costs roughly EUR 3 for the Mac plus one or two dollars for Google Cloud.

**How long it takes.** About 1.5 hours until both phones work, most of it waiting for Scaleway to
install macOS. You can set up the Android machine while you wait. Building your iOS app on the rented
Mac adds 30 to 60 minutes the first time: a Kotlin Multiplatform app's first build took 9 minutes on
the smallest Mac mini.

**What you need.**

- A laptop with Linux or macOS. Windows is expected to work as the laptop, but nobody has tried it yet.
- A Google account and a payment card. Google Cloud and Scaleway both ask for one.
- Claude Code, or another AI agent that supports MCP, on the laptop.
- Your app's code on GitHub. For Android, you build a debug APK on your laptop. For iOS, the rented Mac
  builds the app from GitHub (step 9). That works for native iOS apps and Kotlin Multiplatform apps.
  Flutter and React Native apps have not been tried: the Mac runs only `xcodebuild`, so for those, let
  your CI build a simulator app instead (step 9).
- If your repository is private, a GitHub token the Mac can read it with. Step 9 makes one.

**How sure this is.** Each part of this path has run for real: from a Linux server, Android on Google
Cloud and iOS on a Scaleway Mac mini were tested in one session. Two things have not. The Google Cloud
commands below were run in a slightly different form, with Terraform. And the agent in those runs was
a test script, not Claude Code itself. Claude Code uses the same tools in the same way, but nobody has
recorded a run with it yet. Report what trips you up with `tapdance report`.

## 1. Create the accounts

Do them in this order. Start a day early if you can: Scaleway may ask you to verify your identity
before you can rent a Mac, and that can take a while.

1. **Google Cloud.** Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with
   your Google account. Set up billing when it asks. Create a new project, for example
   `tapdance-test`, and note its **project ID**: the project picker shows it, often with a number at
   the end. A project of its own makes cleaning up easy, because you can delete the whole project.
2. **Scaleway (iOS only).** Sign up at [console.scaleway.com](https://console.scaleway.com) and add a payment
   method.
3. **Tailscale.** Sign up at [login.tailscale.com](https://login.tailscale.com) with the same Google
   account. Tailscale makes a private network between your machines, so the phones are never open to
   the internet.

In Tailscale's admin console, open **DNS** and turn on **HTTPS Certificates**. Your machines then talk
over `https://`, and you can watch the phones live in your browser.

By default, every machine in your Tailscale network can reach every other. The rented machines build
and run your app, so it is safer if they cannot reach your laptop. Once all three machines are in the
network (after step 6, or step 5 if you only need Android), change the **Access controls** so that only your laptop can reach the other
two, on port 4720. The [threat model](../security/threat-model.md) has the rule to paste.

**You should see:** a Google Cloud project with billing on, a Scaleway console, and a Tailscale admin
console with no machines yet.

## 2. Prepare your laptop

**git and curl.** On Ubuntu:

```bash
sudo apt install -y git curl
```

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

Any Node.js from 22.13 on works.

**Tapdance:**

```bash
npm install -g tapdance-cli
tapdance --version
```


**You should see** a version such as `0.1.0`. The npm package called just `tapdance` is a different
project, so install `tapdance-cli`.

**The gcloud command-line tool.** Install it from
[cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install). Then point it at your
project and turn on the Compute Engine API:

```bash
gcloud init
gcloud services enable compute.googleapis.com
```

`gcloud init` opens a browser to log you in, then asks which project to use: pick `tapdance-test`.
**You should see** your project ID when you run `gcloud config get-value project`.

**An SSH key for the rented Mac (iOS only),** if you do not have one:

```bash
ssh-keygen -t ed25519
cat ~/.ssh/id_ed25519.pub
```

Press Enter to accept the file name. A passphrase is optional. The second command prints your public
key: you paste it into Scaleway in the next step.

## 3. Rent the Mac (it takes about an hour to be ready)

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
account for simulators. Keep the password private; you need it in step 6.

With automatic deletion, the Mac is gone after 24 hours. To test again another day, rent a new one and
repeat steps 3 and 6, and the iOS part of step 9. Running `tapdance connect … --name mac` with the new
Mac's address replaces the old one on your laptop. Turn automatic deletion off if you want to keep the
Mac longer: it keeps billing about EUR 3 a day.

## 4. Start the Android machine on Google Cloud

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

## 5. Set up the Android machine

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
it will probably do that. Step 7 shows how to start it again.

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

## 6. Set up the Mac

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
- `--with-gh`: installs the GitHub tool, so the Mac can fetch your app from GitHub in step 9.
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

## 7. Try both phones yourself

Before handing it to your agent, borrow each phone once by hand. Run this in your app's project folder,
so the screenshots land there:

```bash
cd ~/<your-app>
tapdance devices
tapdance device lease --platform android
tapdance screenshot
tapdance device release
tapdance device lease --platform ios
tapdance screenshot
tapdance device release
```

The last three lines are iOS only.

**You should see:** `devices` lists both machines. Each lease prints the phone it got, and each
screenshot is saved under `./tapdance-artifacts/`. The first iPhone takes about two minutes to start
on the small Mac mini; later ones are faster.

**If Android is unreachable**, the Google Cloud machine has probably switched itself off after 30
minutes without use, or after 8 hours. Your agent then reports that it cannot reach `android`. Start the
machine again and wait about a minute. You can also tell your agent it may run this command itself:

```bash
gcloud compute instances start tapdance-n2 --zone=us-central1-a
```

## 8. Connect your agent

`connect` already printed the lines for your agent. For Claude Code, from your app's project folder:

```bash
claude mcp add tapdance -- "$(command -v node)" "$(command -v tapdance)" mcp
```

The full paths matter because Node.js came from nvm. Claude Code started from a desktop launcher or an
IDE may not see nvm's `PATH`, and then a plain `tapdance mcp` would not start.

Start Claude Code in that folder and run `/mcp`.

**You should see:** a server called `tapdance`, connected, with tools such as `lease_device` and
`take_screenshot`. Codex and Cursor are in [connect your agent](../agents.md).

## 9. Ask it to test your app

**Android: build on your laptop.** Build a debug APK as you normally would, for example:

- a native Android app: `./gradlew assembleDebug`, which writes `app/build/outputs/apk/debug/app-debug.apk`;
- a Kotlin Multiplatform app: `./gradlew :composeApp:assembleDebug`, which writes
  `composeApp/build/outputs/apk/debug/composeApp-debug.apk`;
- a Flutter app: `flutter build apk --debug`, which writes `build/app/outputs/flutter-apk/app-debug.apk`;
- a React Native app: `cd android && ./gradlew assembleRelease`, which writes
  `android/app/build/outputs/apk/release/app-release.apk`. Use a release build: a debug build loads its
  JavaScript from Metro on your laptop, which the cloud machine cannot reach.

The agent uploads the APK to the Android machine itself.

**iOS: let the Mac build it from GitHub.** Do this once.

1. **If the repository is private, make a GitHub token.** On GitHub, open **Settings > Developer
   settings > Personal access tokens > Fine-grained tokens > Generate new token**. Pick only your app's
   repository, and give it **Contents: Read-only**. Copy the token.
2. **Log the Mac in to GitHub with it.** On your laptop, run this and paste the token when it asks. It
   is not shown on screen:

   ```bash
   ssh -t m1@<mac-ip> 'tapdance host gh-login'
   ```

   The prompt form has not been tried on a rented Mac yet. The form that has been tried passes the token
   over ssh's input, without writing it to a file:

   ```bash
   read -rs TOKEN
   printf '%s' "$TOKEN" | ssh m1@<mac-ip> 'tapdance host gh-login'
   unset TOKEN
   ```

   `read -rs` waits for you to paste the token and press Enter, without showing it.

3. **Allow builds of your repository** on the Mac:

   ```bash
   ssh m1@<mac-ip> 'tapdance host builds enable --repo https://github.com/<you>/<your-app> --git-auth gh --allow-admin-account'
   ```

   It checks that the Mac can read the repository and warns if not.

4. **Files kept out of git?** If the iOS build needs files your repository does not contain, such as
   `google-services.json`, `GoogleService-Info.plist` or `local.properties`, give the Mac a copy once.
   For example, from your app's folder on the laptop:

   ```bash
   ssh m1@<mac-ip> 'tapdance host builds files add --repo https://github.com/<you>/<your-app> iosApp/iosApp/GoogleService-Info.plist' < iosApp/iosApp/GoogleService-Info.plist
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

## 10. Stop paying

Do this when you are done.

1. **Release any phone** still borrowed: `tapdance device release`.
2. **Delete the Mac mini** on the Scaleway page. Scaleway allows it only after the first 24 hours; with
   automatic deletion on, it goes by itself. Switching it off does not stop billing.
3. **Delete the Google Cloud machine and its firewall rule:**

   ```bash
   gcloud compute instances delete tapdance-n2 --zone=us-central1-a
   gcloud compute firewall-rules delete tapdance-host-ssh-iap
   ```

   Or delete the whole `tapdance-test` project in the console, which removes everything in it. A
   stopped machine still bills for its disk, so delete it rather than stop it.
4. **Forget the machines on your laptop:**

   ```bash
   tapdance disconnect android
   tapdance disconnect mac
   ```

5. **Log gcloud out** on your laptop, if you do not use Google Cloud for anything else. Its login can
   reach your whole Google Cloud account:

   ```bash
   gcloud auth revoke --all
   ```

6. **Remove the two machines** from the Tailscale admin console, and delete the GitHub token if you made
   one.

To check that nothing on Google Cloud still bills, the
[Google Cloud guide](../deployment/google-cloud-n2.md#tear-down) has a script that lists leftovers.

## If something goes wrong

- **gcloud says nested virtualization is not allowed:** your Google account belongs to an organization
  that forbids it. Use a personal Google account and a new project.
- **The Android self-test is slow:** the first boot on a cloud machine can take several minutes. Wait.
- **Android is unreachable later:** the machine switched itself off. Start it again (step 7).
- **iPhone leases fail with "Internal error":** the small Mac ran out of memory. Run the `host warm`
  line in step 6 again.
- **The agent's calls fail after the Mac restarted:** automatic login is not set. Run the script at the
  start of step 6 again.
- **The first command on a new iPhone times out:** run it again. The first one starts a helper on the
  phone and can be slow.
- **The iOS build fails with "SDK location not found":** it is a Kotlin Multiplatform app and the Mac
  has no Android SDK. Run the setup command in step 6 again with `--android-build-sdk`; steps already
  done are skipped.

Everything else: [troubleshooting](../troubleshooting.md). The words used here are explained in the
[glossary](../glossary.md).
